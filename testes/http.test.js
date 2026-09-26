import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { criarHandlerA2a } from '../agente/http.js';
import { PonteA2a } from '../agente/ponte.js';

async function request(chunks, ponte) {
  const incoming = Readable.from(chunks);
  Object.assign(incoming, { method: 'POST', url: '/a2a', headers: {} });
  const result = {};
  const response = {
    writeHead(status) {
      result.status = status;
    },
    end(body) {
      result.body = JSON.parse(body);
    },
  };
  await criarHandlerA2a({ ponte, card: {} })(incoming, response);
  return result;
}

test('HTTP preserva UTF-8 quando o caractere chega em chunks separados', async () => {
  const message = { text: 'João 李' };
  const body = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message } }),
  );
  const split = body.indexOf(Buffer.from('ã')) + 1;
  const result = await request([body.subarray(0, split), body.subarray(split)], {
    send(received) {
      return received;
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result.task, message);
});

test('HTTP rejeita corpo acima de 1 MiB sem chamar a ponte', async () => {
  const result = await request([Buffer.alloc(1024 * 1024), Buffer.from('x')], {
    send() {
      assert.fail('A ponte nao deve receber o corpo excedente');
    },
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.error, 'Request too large');
});

test('JSON-RPC diferencia JSON invalido, envelope invalido e parametros invalidos', async () => {
  const ponte = new PonteA2a({});
  const cases = [
    ['{', -32700],
    ['null', -32600],
    ['[]', -32600],
    [JSON.stringify({ jsonrpc: '2.0', id: true, method: 'GetTask' }), -32600],
    [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: null }), -32602],
    [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: [] }), -32602],
    [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 3 } }), -32602],
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'GetTask',
        params: { id: 'x', historyLength: -1 },
      }),
      -32602,
    ],
  ];
  for (const [body, expected] of cases) {
    const result = await request([Buffer.from(body)], ponte);
    assert.equal(result.status, 200);
    assert.equal(result.body.error.code, expected, body);
  }
});
