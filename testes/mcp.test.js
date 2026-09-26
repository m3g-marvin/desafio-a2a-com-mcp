import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { criarHandler, criarCodec, STATE_TTL_SECONDS } from '../servidor-mcp/server.js';
import { criarAgenda } from '../servidor-mcp/salas.js';

const secret = randomBytes(32).toString('hex');
const args = {
  sala: 'sala-garagem',
  inicio: '2026-11-03T14:00:00-03:00',
  fim: '2026-11-03T15:00:00-03:00',
  responsavel: 'Doc',
};
async function rpc(
  handler,
  params,
  { method = 'tools/call', capabilities = { elicitation: { form: {} } }, headers = {} } = {},
) {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        'Mcp-Name': params.name ?? params.uri,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': capabilities,
          },
        },
      }),
    }),
  );
  return { status: response.status, ...(await response.json()) };
}
const ask = (handler) => rpc(handler, { name: 'reservar_sala', arguments: args });
const retry = (result, response = { action: 'accept', content: { sala: 'sala-fusca' } }) => ({
  name: 'reservar_sala',
  arguments: args,
  requestState: result.requestState,
  inputResponses: { [Object.keys(result.inputRequests)[0]]: response },
});

test('MRTR: estado independente da instancia, argumentos selados, integridade e expiração', async (t) => {
  const first = criarHandler({ secret, log() {} });
  const paused = (await ask(first)).result;
  await first.close();
  const restarted = criarHandler({ secret, log() {} });
  t.after(() => restarted.close());
  const altered = await rpc(restarted, {
    ...retry(paused),
    arguments: { ...args, inicio: '2026-11-04T09:00:00-03:00', responsavel: 'Biff' },
  });
  assert.equal(altered.result.structuredContent.responsavel, 'Doc');
  assert.equal(altered.result.structuredContent.inicio, args.inicio);

  const tampered = await rpc(restarted, {
    ...retry(paused),
    requestState: `${paused.requestState.slice(0, -8)}AAAAAAAA`,
  });
  assert.equal(tampered.error.code, -32602);
  const wrongTool = await rpc(restarted, { ...retry(paused), name: 'consultar_disponibilidade' });
  assert.equal(wrongTool.error.code, -32602);
  const wrongMethod = await rpc(
    restarted,
    { uri: 'politica://uso', requestState: paused.requestState },
    { method: 'resources/read' },
  );
  assert.equal(wrongMethod.error.code, -32602);

  const now = Date.now();
  t.mock.method(Date, 'now', () => now + (STATE_TTL_SECONDS + 2) * 1000);
  const expired = await rpc(restarted, retry(paused));
  assert.equal(expired.error.code, -32602);
});

test('form capability, headers espelhados, respostas inválidas e recusa', async (t) => {
  const handler = criarHandler({ secret, log() {} });
  t.after(() => handler.close());
  for (const capabilities of [{}, { elicitation: {} }, { elicitation: { url: {} } }]) {
    const response = await rpc(
      handler,
      { name: 'reservar_sala', arguments: args },
      { capabilities },
    );
    assert.equal(response.status, 400);
    assert.equal(response.error.code, -32021);
    assert.ok(response.error.data.requiredCapabilities);
  }
  const mismatch = await rpc(
    handler,
    { name: 'listar_salas', arguments: {} },
    { headers: { 'Mcp-Name': 'reservar_sala' } },
  );
  assert.equal(mismatch.error.code, -32020);
  const paused = (await ask(handler)).result;
  for (const action of ['decline', 'cancel']) {
    const response = await rpc(handler, retry(paused, { action }));
    assert.equal(response.result.structuredContent.reservado, false);
    assert.ok(!response.result.isError);
  }
  const invalid = await rpc(
    handler,
    retry(paused, { action: 'accept', content: { sala: 'sala-aquario' } }),
  );
  assert.equal(invalid.result.isError, true);
  const missingState = retry(paused);
  delete missingState.requestState;
  assert.equal((await rpc(handler, missingState)).result.isError, true);
  const valid = await rpc(handler, retry(paused));
  assert.equal(valid.result.structuredContent.sala, 'sala-fusca');
  // A mesma escolha não pode criar uma segunda reserva sobreposta.
  assert.equal((await rpc(handler, retry(paused))).result.isError, true);
});

test('segredo externo obrigatório com no mínimo 32 bytes', () => {
  for (const value of [undefined, '', 'a'.repeat(32), 'x'.repeat(64), 'a'.repeat(65)])
    assert.throws(() => criarCodec(value));
  assert.doesNotThrow(() => criarCodec(secret));
});

test('política em -03:00, limites inclusivos, intervalos adjacentes e ordenação', () => {
  const agenda = criarAgenda();
  const interval = (inicio, fim) => ({ sala: 'sala-aquario', inicio, fim, responsavel: 'Doc' });
  agenda.reservar(interval('2026-11-03T11:00:00Z', '2026-11-03T13:00:00Z'));
  assert.equal(
    agenda.conflitos(interval('2026-11-03T10:00:00-03:00', '2026-11-03T11:00:00-03:00')).length,
    0,
  );
  assert.doesNotThrow(() =>
    agenda.validar(interval('2026-11-03T18:00:00-03:00', '2026-11-03T20:00:00-03:00')),
  );
  assert.throws(
    () => agenda.validar(interval('2026-11-03T19:00:00-03:00', '2026-11-03T20:00:01-03:00')),
    /Fora da janela/,
  );
  assert.throws(
    () => agenda.validar(interval('2026-11-03T19:00:00-03:00', '2026-11-04T09:00:00-03:00')),
    /Fora da janela/,
  );
  assert.throws(
    () => agenda.validar(interval('2026-11-03T09:00:00', '2026-11-03T10:00:00')),
    /Data invalida/,
  );
  assert.throws(() => agenda.validar(interval(args.inicio, args.inicio)), /Intervalo invalido/);
  const original = {
    ...interval('2026-11-03T12:00:00-03:00', '2026-11-03T13:00:00-03:00'),
    sala: 'sala-porao',
  };
  agenda.reservar(original);
  assert.deepEqual(agenda.alternativas(original), ['sala-fusca', 'sala-garagem', 'sala-mirante']);
});
