import { createServer } from 'node:http';
import { conectarMcp } from './mcp.js';
import { criarPonte, RpcError } from './ponte.js';

const port = Number(process.env.AGENT_PORT ?? 7300);
const mcp = await conectarMcp(process.env.MCP_URL ?? 'http://127.0.0.1:7301/mcp');
const ponte = criarPonte(mcp);
const card = {
  name: 'Central de Salas',
  description: 'Reserva salas de reuniao da Hill Valley Tech.',
  version: '1.0.0',
  supportedInterfaces: [
    {
      url: `${process.env.AGENT_URL ?? `http://127.0.0.1:${port}`}/a2a`,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    },
  ],
  capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    {
      id: 'reservar-sala',
      name: 'Reservar sala',
      description: 'Reserva uma sala e solicita uma escolha quando ha conflito.',
      tags: ['salas', 'agenda'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      examples: [
        'reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty',
      ],
    },
  ],
};
const server = createServer(async (req, res) => {
  function json(status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') return json(200, card);
  if (req.url !== '/a2a') return json(404, { error: 'Not found' });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  let body;
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 1024 * 1024) return json(413, { error: 'Request too large' });
    }
    try {
      body = JSON.parse(raw);
    } catch {
      throw new RpcError(-32700, 'Invalid JSON payload');
    }
    if (
      !body ||
      Array.isArray(body) ||
      body.jsonrpc !== '2.0' ||
      typeof body.method !== 'string' ||
      !['string', 'number'].includes(typeof body.id)
    )
      throw new RpcError(-32600, 'Invalid request');
    const params = body.params ?? {};
    let result;
    if (body.method === 'SendMessage')
      result = { task: await ponte.send(params.message, req.headers.traceparent) };
    else if (body.method === 'GetTask') {
      if (
        typeof params.id !== 'string' ||
        (params.historyLength !== undefined &&
          (!Number.isInteger(params.historyLength) || params.historyLength < 0))
      )
        throw new RpcError(-32602, 'Invalid parameters');
      result = ponte.get(params.id, params.historyLength);
    } else throw new RpcError(-32601, 'Method not found');
    json(200, { jsonrpc: '2.0', id: body.id, result });
  } catch (error) {
    json(200, {
      jsonrpc: '2.0',
      id: ['string', 'number'].includes(typeof body?.id) ? body.id : null,
      error: {
        code: error instanceof RpcError ? error.code : -32603,
        message: error instanceof RpcError ? error.message : 'Internal error',
      },
    });
  }
});
server.listen(port, '127.0.0.1', () => console.error(`A2A: http://127.0.0.1:${port}/a2a`));
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close();
    void mcp.close();
  });
