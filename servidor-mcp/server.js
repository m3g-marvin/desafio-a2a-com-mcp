import {
  Server,
  createMcpHandler,
  createRequestStateCodec,
  ProtocolError,
} from '@modelcontextprotocol/server';
import { AgendaSalas, politica } from './salas.js';
import { criarTools } from './tools.js';

export const STATE_TTL_SECONDS = 600;
export function criarCodec(secret) {
  if (!/^[a-fA-F0-9]{64,}$/.test(secret ?? '') || secret.length % 2 !== 0) {
    throw new Error(
      'REQUEST_STATE_SECRET deve conter pelo menos 32 bytes em hexadecimal. Veja o README.',
    );
  }
  return createRequestStateCodec({
    key: Buffer.from(secret, 'hex'),
    ttlSeconds: STATE_TTL_SECONDS,
    // O SDK verifica que Mcp-Name corresponde ao nome/URI do corpo.
    bind: (ctx) => `${ctx.mcpReq.method}\0${ctx.http?.req?.headers.get('Mcp-Name') ?? ''}`,
  });
}

export function criarHandler({
  secret = process.env.REQUEST_STATE_SECRET,
  log = console.error,
} = {}) {
  const codec = criarCodec(secret);
  const agenda = new AgendaSalas();
  const tools = criarTools({ agenda, codec });
  const handler = createMcpHandler(
    () => {
      // Server permite propagar erros de protocolo; McpServer converte erros
      // lançados pela tool em isError, inclusive MissingRequiredClientCapability.
      const server = new Server(
        { name: 'central-de-salas', version: '1.0.0' },
        {
          capabilities: { tools: {}, resources: {} },
          requestState: { verify: codec.verify },
        },
      );
      server.setRequestHandler('tools/list', tools.list);
      server.setRequestHandler('tools/call', tools.call);
      server.setRequestHandler('resources/list', () => ({
        resources: [
          {
            name: 'politica-de-uso',
            uri: 'politica://uso',
            mimeType: 'text/markdown',
          },
        ],
      }));
      server.setRequestHandler('resources/read', (request) => {
        if (request.params.uri !== 'politica://uso') {
          throw new ProtocolError(-32602, 'Resource inexistente');
        }
        return { contents: [{ uri: 'politica://uso', mimeType: 'text/markdown', text: politica }] };
      });
      return server;
    },
    { legacy: 'reject', responseMode: 'json' },
  );

  return {
    async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp') {
        return new Response('Not found', { status: 404 });
      }
      if (request.method === 'POST') {
        try {
          const body = await request.clone().json();
          log(
            JSON.stringify({
              method: body.method,
              id: body.id,
              traceparent: body.params?._meta?.traceparent ?? null,
            }),
          );
        } catch {
          log(JSON.stringify({ method: 'invalid-json', id: null, traceparent: null }));
        }
      }
      return handler.fetch(request);
    },
    close: () => handler.close(),
  };
}
