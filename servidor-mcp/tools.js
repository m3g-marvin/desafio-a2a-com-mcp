import {
  inputRequired,
  inputResponse,
  acceptedContent,
  MissingRequiredClientCapabilityError,
  ProtocolError,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { salas } from './salas.js';

const intervalSchema = z.object({ sala: z.string(), inicio: z.string(), fim: z.string() });
const bookingSchema = intervalSchema.extend({ responsavel: z.string().min(1) });
const roomSchema = z.object({
  id: z.string(),
  nome: z.string(),
  capacidade: z.number().int(),
  recursos: z.array(z.string()),
});

function complete(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function executionError(error) {
  const message = error instanceof Error ? error.message : 'Falha ao executar a ferramenta';
  return { ...complete({ erro: message }), isError: true };
}

function resumeBooking(agenda, state, responses) {
  const response = inputResponse(responses, state.key);
  if (response.kind === 'elicit' && ['decline', 'cancel'].includes(response.action)) {
    return complete({ reservado: false, motivo: 'Reserva recusada pelo usuario' });
  }
  const choice = acceptedContent(
    responses,
    state.key,
    z.object({ sala: z.enum(state.alternativas) }),
  );
  if (!choice) {
    throw new Error('Escolha invalida: selecione uma das alternativas oferecidas');
  }
  // Os argumentos reenviados nunca substituem os valores autenticados.
  return complete(agenda.reservar({ ...state.args, sala: choice.sala }));
}

export function criarTools({ agenda, codec }) {
  async function reserve(args, ctx) {
    const state = ctx.mcpReq.requestState();
    if (state) {
      return resumeBooking(agenda, state, ctx.mcpReq.inputResponses);
    }
    if (ctx.mcpReq.inputResponses) {
      throw new Error('Continuacao sem requestState');
    }
    agenda.validar(args);
    if (!agenda.conflitos(args).length) {
      return complete(agenda.reservar(args));
    }
    const alternativas = agenda.alternativas(args);
    if (!alternativas.length) {
      throw new Error('Sem alternativas disponiveis no intervalo');
    }
    // O contrato exige form explícito, inclusive quando elicitation: {} existe.
    const capabilities = ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities'];
    if (!capabilities?.elicitation?.form) {
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
      requestState: await codec.mint({ tool: 'reservar_sala', args, alternativas, key }, ctx),
    });
  }

  const tools = new Map([
    [
      'listar_salas',
      {
        description: 'Lista as salas com capacidade e recursos.',
        inputSchema: z.object({}),
        outputSchema: z.object({ salas: z.array(roomSchema) }),
        execute: () => complete({ salas }),
      },
    ],
    [
      'consultar_disponibilidade',
      {
        description: 'Consulta disponibilidade e reservas em conflito.',
        inputSchema: intervalSchema,
        execute: (args) => {
          agenda.validar(args);
          const conflitos = agenda.conflitos(args);
          return complete({ sala: args.sala, livre: conflitos.length === 0, conflitos });
        },
      },
    ],
    [
      'reservar_sala',
      {
        description: 'Reserva uma sala ou pede a escolha de uma alternativa.',
        inputSchema: bookingSchema,
        execute: reserve,
      },
    ],
  ]);
  const definitions = [...tools].map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),
    ...(tool.outputSchema && { outputSchema: z.toJSONSchema(tool.outputSchema) }),
  }));

  return {
    list: () => ({ tools: structuredClone(definitions) }),
    async call(request, ctx) {
      const tool = tools.get(request.params.name);
      if (!tool) {
        throw new ProtocolError(-32602, `Tool inexistente: ${request.params.name}`);
      }
      const parsed = tool.inputSchema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        return executionError(new Error('Argumentos invalidos para a ferramenta'));
      }
      try {
        return await tool.execute(parsed.data, ctx);
      } catch (error) {
        if (error instanceof ProtocolError) {
          throw error;
        }
        return executionError(error);
      }
    },
  };
}
