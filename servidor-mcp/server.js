import {
  Server,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  acceptedContent,
  MissingRequiredClientCapabilityError,
  ProtocolError,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { criarAgenda, salas, politica } from './salas.js';

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

const intervalSchema = z.object({ sala: z.string(), inicio: z.string(), fim: z.string() });
const bookingSchema = intervalSchema.extend({ responsavel: z.string().min(1) });
const roomSchema = z.object({
  id: z.string(),
  nome: z.string(),
  capacidade: z.number().int(),
  recursos: z.array(z.string()),
});
const complete = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
});
const executionError = (error) => ({ ...complete({ erro: error.message }), isError: true });

export function criarHandler({
  secret = process.env.REQUEST_STATE_SECRET,
  log = console.error,
} = {}) {
  const codec = criarCodec(secret);
  const agenda = criarAgenda();
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
      const tools = new Map();
      function registerTool(name, definition, handler) {
        tools.set(name, { definition, handler });
      }
      registerTool(
        'listar_salas',
        {
          description: 'Lista as salas com capacidade e recursos.',
          inputSchema: z.object({}),
          outputSchema: z.object({ salas: z.array(roomSchema) }),
        },
        () => complete({ salas }),
      );
      registerTool(
        'consultar_disponibilidade',
        {
          description: 'Consulta disponibilidade e reservas em conflito.',
          inputSchema: intervalSchema,
        },
        (args) => {
          try {
            agenda.validar(args);
            const conflitos = agenda.conflitos(args);
            return complete({ sala: args.sala, livre: conflitos.length === 0, conflitos });
          } catch (error) {
            return executionError(error);
          }
        },
      );
      registerTool(
        'reservar_sala',
        {
          description: 'Reserva uma sala ou pede a escolha de uma alternativa.',
          inputSchema: bookingSchema,
        },
        async (args, ctx) => {
          const state = ctx.mcpReq.requestState();
          try {
            if (state) {
              const response = inputResponse(ctx.mcpReq.inputResponses, state.key);
              if (response.kind === 'elicit' && ['decline', 'cancel'].includes(response.action)) {
                return complete({ reservado: false, motivo: 'Reserva recusada pelo usuario' });
              }
              const choice = acceptedContent(
                ctx.mcpReq.inputResponses,
                state.key,
                z.object({ sala: z.enum(state.alternativas) }),
              );
              if (!choice)
                throw new Error('Escolha invalida: selecione uma das alternativas oferecidas');
              // Os argumentos reenviados nunca substituem os valores autenticados.
              return complete(agenda.reservar({ ...state.args, sala: choice.sala }));
            }
            if (ctx.mcpReq.inputResponses) throw new Error('Continuacao sem requestState');
            agenda.validar(args);
            if (!agenda.conflitos(args).length) return complete(agenda.reservar(args));
            const alternativas = agenda.alternativas(args);
            if (!alternativas.length) throw new Error('Sem alternativas disponiveis no intervalo');
            // O contrato exige form explícito, inclusive quando elicitation: {} existe.
            if (
              !ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities']?.elicitation
                ?.form
            ) {
              throw new MissingRequiredClientCapabilityError({
                requiredCapabilities: { elicitation: { form: {} } },
              });
            }
            const key = 'escolha_de_sala';
            return inputRequired({
              inputRequests: {
                [key]: inputRequired.elicit({
                  message: 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.',
                  requestedSchema: z.object({ sala: z.enum(alternativas) }),
                }),
              },
              requestState: await codec.mint(
                { tool: 'reservar_sala', args, alternativas, key },
                ctx,
              ),
            });
          } catch (error) {
            if (error instanceof MissingRequiredClientCapabilityError) throw error;
            return executionError(error);
          }
        },
      );
      server.setRequestHandler('tools/list', () => ({
        tools: [...tools].map(([name, { definition }]) => ({
          name,
          description: definition.description,
          inputSchema: z.toJSONSchema(definition.inputSchema),
          ...(definition.outputSchema && { outputSchema: z.toJSONSchema(definition.outputSchema) }),
        })),
      }));
      server.setRequestHandler('tools/call', (request, ctx) => {
        const tool = tools.get(request.params.name);
        if (!tool) throw new ProtocolError(-32602, `Tool inexistente: ${request.params.name}`);
        const parsed = tool.definition.inputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success)
          return executionError(new Error('Argumentos invalidos para a ferramenta'));
        return tool.handler(parsed.data, ctx);
      });
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
        if (request.params.uri !== 'politica://uso')
          throw new ProtocolError(-32602, 'Resource inexistente');
        return { contents: [{ uri: 'politica://uso', mimeType: 'text/markdown', text: politica }] };
      });
      return server;
    },
    { legacy: 'reject', responseMode: 'json' },
  );

  return {
    async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp')
        return new Response('Not found', { status: 404 });
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
