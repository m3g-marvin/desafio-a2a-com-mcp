import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { iniciar, portaLivre, comando } from './processos.js';

const request = (url, method, params, traceparent) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(traceparent && { traceparent }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  }).then((response) => response.json());
const send = (url, text, taskId, traceparent) =>
  request(
    url,
    'SendMessage',
    {
      message: {
        messageId: randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text }],
        ...(taskId && { taskId }),
      },
    },
    traceparent,
  );

test(
  'validador original: 36 verificações em dois processos novos; trace e descoberta',
  { timeout: 30000 },
  async (t) => {
    const mcpPort = await portaLivre();
    const agentPort = await portaLivre();
    const mcp = await iniciar('servidor-mcp/index.js', {
      MCP_PORT: String(mcpPort),
      REQUEST_STATE_SECRET: randomBytes(32).toString('hex'),
    });
    t.after(mcp.stop);
    const agent = await iniciar('agente/index.js', {
      AGENT_PORT: String(agentPort),
      MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`,
    });
    t.after(agent.stop);
    const result = await comando('python3', [
      'validador/validar.py',
      '--mcp',
      `http://127.0.0.1:${mcpPort}`,
      '--agente',
      `http://127.0.0.1:${agentPort}`,
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /36 passaram, 0 falharam/);
    const trace = /trace-id desta execucao: (\w+)/.exec(result.output)[1];
    const events = mcp
      .logs()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    const agentEvents = events.filter((event) => typeof event.id === 'number');
    assert.equal(agentEvents[0].method, 'tools/list');
    assert.ok(agentEvents.filter((event) => event.traceparent?.includes(trace)).length >= 5);
    assert.equal(new Set(agentEvents.map((event) => event.id)).size, agentEvents.length);
  },
);

test(
  'Task retoma após restart real do MCP e não expõe seu estado privado',
  { timeout: 20000 },
  async (t) => {
    const mcpPort = await portaLivre();
    const agentPort = await portaLivre();
    const env = {
      MCP_PORT: String(mcpPort),
      REQUEST_STATE_SECRET: randomBytes(32).toString('hex'),
    };
    let mcp = await iniciar('servidor-mcp/index.js', env);
    t.after(() => mcp.stop());
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
    const agent = await iniciar('agente/index.js', {
      AGENT_PORT: String(agentPort),
      MCP_URL: mcpUrl,
    });
    t.after(agent.stop);
    const url = `http://127.0.0.1:${agentPort}/a2a`;
    const trace = `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
    const paused = await send(
      url,
      'reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty McFly',
      undefined,
      trace,
    );
    assert.equal(paused.result.task.status.state, 'TASK_STATE_INPUT_REQUIRED');
    const id = paused.result.task.id;
    const before = await request(url, 'GetTask', { id });
    assert.equal(before.result.status.state, 'TASK_STATE_INPUT_REQUIRED');
    await mcp.stop();
    mcp = await iniciar('servidor-mcp/index.js', env);
    const completed = await send(url, 'escolha=sala-mirante', id);
    assert.equal(completed.result.task.status.state, 'TASK_STATE_COMPLETED');
    const artifact = JSON.parse(completed.result.task.artifacts[0].parts[0].text);
    assert.equal(artifact.sala, 'sala-mirante');
    assert.equal(artifact.responsavel, 'Marty McFly');
    const current = await request(url, 'GetTask', { id, historyLength: 0 });
    assert.deepEqual(current.result.artifacts, completed.result.task.artifacts);
    assert.deepEqual(current.result.history, []);
    assert.doesNotMatch(
      JSON.stringify([paused, before, completed, current]),
      /requestState|inputResponses|original|pending/,
    );
    assert.ok(mcp.logs().includes(trace));
    assert.ok((await send(url, 'escolha=sala-fusca', id)).error);
    assert.equal((await request(url, 'GetTask', { id: 'inexistente' })).error.code, -32001);
    assert.equal((await request(url, 'MetodoInexistente', {})).error.code, -32601);
  },
);
