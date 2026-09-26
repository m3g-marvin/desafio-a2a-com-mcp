import { RpcError } from './erros.js';

const MAX_BODY_BYTES = 1024 * 1024;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRpcId = (value) => typeof value === 'string' || Number.isFinite(value);

class RequestTooLargeError extends Error {}

function json(response, status, body) {
  if (response.destroyed) {
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on('data', (chunk) => {
      if (exceeded) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        exceeded = true;
        chunks.length = 0;
        reject(new RequestTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

function parseRequest(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new RpcError(-32700, 'Invalid JSON payload');
  }
}

function validateRequest(body) {
  if (
    !isObject(body) ||
    body.jsonrpc !== '2.0' ||
    typeof body.method !== 'string' ||
    !isRpcId(body.id)
  ) {
    throw new RpcError(-32600, 'Invalid request');
  }
  if (body.params !== undefined && !isObject(body.params)) {
    throw new RpcError(-32602, 'Invalid parameters');
  }
}

async function dispatch(ponte, { method, params = {} }, traceparent) {
  switch (method) {
    case 'SendMessage':
      return { task: await ponte.send(params.message, traceparent) };
    case 'GetTask':
      return ponte.get(params.id, params.historyLength);
    default:
      throw new RpcError(-32601, 'Method not found');
  }
}

export function criarHandlerA2a({ ponte, card }) {
  return async (request, response) => {
    if (request.method === 'GET' && request.url === '/.well-known/agent-card.json') {
      return json(response, 200, card);
    }
    if (request.url !== '/a2a') {
      return json(response, 404, { error: 'Not found' });
    }
    if (request.method !== 'POST') {
      return json(response, 405, { error: 'Method not allowed' });
    }

    let body;
    try {
      body = parseRequest(await readBody(request));
      validateRequest(body);
      const result = await dispatch(ponte, body, request.headers.traceparent);
      return json(response, 200, { jsonrpc: '2.0', id: body.id, result });
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        return json(response, 413, { error: 'Request too large' });
      }
      return json(response, 200, {
        jsonrpc: '2.0',
        id: isRpcId(body?.id) ? body.id : null,
        error: {
          code: error instanceof RpcError ? error.code : -32603,
          message: error instanceof RpcError ? error.message : 'Internal error',
        },
      });
    }
  };
}
