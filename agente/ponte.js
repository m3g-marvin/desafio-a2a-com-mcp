import { randomUUID } from 'node:crypto';
import { RpcError } from './erros.js';

export { RpcError } from './erros.js';

const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_FAILED',
]);
const BOOKING_PATTERN = /^reservar sala=(\S+) inicio=(\S+) fim=(\S+) responsavel=(.+)$/;
const CHOICE_PATTERN = /^escolha=(\S+)$/;

function messageText(message) {
  if (
    !message ||
    message.role !== 'ROLE_USER' ||
    typeof message.messageId !== 'string' ||
    !message.messageId ||
    !Array.isArray(message.parts) ||
    !message.parts.length ||
    message.parts.some((part) => typeof part?.text !== 'string') ||
    (message.taskId !== undefined && (typeof message.taskId !== 'string' || !message.taskId)) ||
    (message.contextId !== undefined && typeof message.contextId !== 'string')
  ) {
    throw new RpcError(-32602, 'message deve conter messageId, ROLE_USER e parts de texto');
  }
  return message.parts.map((part) => part.text).join('\n');
}

function createRecord(message, text, traceparent) {
  const match = BOOKING_PATTERN.exec(text);
  if (!match) {
    throw new RpcError(
      -32602,
      'Use reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>',
    );
  }
  const [, sala, inicio, fim, responsavel] = match;
  return {
    task: {
      id: randomUUID(),
      contextId: randomUUID(),
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
      history: [structuredClone(message)],
    },
    original: { arguments: { sala, inicio, fim, responsavel } },
    traceparent,
  };
}

function continuationParams(record, message, text) {
  if (TERMINAL_STATES.has(record.task.status.state)) {
    throw new RpcError(-32004, 'Task em estado terminal');
  }
  if (record.task.status.state !== 'TASK_STATE_INPUT_REQUIRED') {
    throw new RpcError(-32004, 'Task em processamento');
  }
  if (message.contextId && message.contextId !== record.task.contextId) {
    throw new RpcError(-32602, 'contextId divergente');
  }
  record.task.history.push(structuredClone(message));
  const choice = CHOICE_PATTERN.exec(text)?.[1];
  if (choice !== 'recusar' && !record.pending.alternativas.includes(choice)) {
    return undefined;
  }
  return {
    ...record.original,
    requestState: record.pending.requestState,
    inputResponses: {
      [record.pending.key]:
        choice === 'recusar'
          ? { action: 'decline' }
          : { action: 'accept', content: { sala: choice } },
    },
  };
}

export class PonteA2a {
  #mcp;
  #log;
  // Somente task é público. Continuação, chamada original e trace ficam privados.
  #tasks = new Map();

  constructor(mcp, { log = console.error } = {}) {
    this.#mcp = mcp;
    this.#log = log;
  }

  get(id, historyLength) {
    if (
      typeof id !== 'string' ||
      (historyLength !== undefined && (!Number.isInteger(historyLength) || historyLength < 0))
    ) {
      throw new RpcError(-32602, 'Invalid parameters');
    }
    const task = structuredClone(this.#findRecord(id).task);
    if (historyLength !== undefined) {
      task.history = historyLength === 0 ? [] : task.history.slice(-historyLength);
    }
    return task;
  }

  async send(message, traceparent) {
    const text = messageText(message);
    let record;
    let params;
    if (message.taskId !== undefined) {
      record = this.#findRecord(message.taskId);
      params = continuationParams(record, message, text);
      if (!params) {
        this.#pause(record);
        return structuredClone(record.task);
      }
    } else {
      record = createRecord(message, text, traceparent);
      this.#tasks.set(record.task.id, record);
    }
    this.#transition(record, 'TASK_STATE_WORKING');
    await this.#mcp.withTrace(record.traceparent ?? traceparent, async () => {
      try {
        if (!params) {
          const config = await this.#mcp.preparar();
          record.politica = config.politica;
          record.original.name = config.tool;
          params = record.original;
        }
        this.#consume(record, await this.#mcp.call(params));
      } catch (error) {
        // Não registrar mensagens/corpos MCP: podem conter o token privado.
        this.#log(
          JSON.stringify({
            taskId: record.task.id,
            error: error instanceof Error ? error.name : 'UnknownError',
            code: typeof error?.code === 'number' ? error.code : null,
          }),
        );
        this.#transition(
          record,
          'TASK_STATE_FAILED',
          'Falha na comunicacao MCP ou continuacao invalida/expirada',
        );
      }
    });
    return structuredClone(record.task);
  }

  #findRecord(id) {
    const record = this.#tasks.get(id);
    if (!record) {
      throw new RpcError(-32001, 'Task nao encontrada');
    }
    return record;
  }

  #transition(record, state, text) {
    if (TERMINAL_STATES.has(record.task.status.state)) {
      throw new RpcError(-32004, 'Task em estado terminal');
    }
    const message =
      text === undefined
        ? undefined
        : {
            messageId: randomUUID(),
            role: 'ROLE_AGENT',
            parts: [{ text }],
            taskId: record.task.id,
            contextId: record.task.contextId,
          };
    record.task.status = {
      state,
      timestamp: new Date().toISOString(),
      ...(message && { message }),
    };
    if (message) {
      record.task.history.push(message);
    }
    if (TERMINAL_STATES.has(state)) {
      record.pending = undefined;
    }
  }

  #pause(record) {
    this.#transition(
      record,
      'TASK_STATE_INPUT_REQUIRED',
      `alternativas: ${record.pending.alternativas.join(', ')}`,
    );
  }

  #consume(record, result) {
    if (result.resultType === 'input_required') {
      const entries = Object.entries(result.inputRequests ?? {});
      if (entries.length !== 1 || typeof result.requestState !== 'string' || !result.requestState) {
        throw new Error('Resposta interativa MCP invalida');
      }
      const [key, request] = entries[0];
      const field = request.params?.requestedSchema?.properties?.sala;
      const alternativas = field?.enum ?? (field?.const ? [field.const] : []);
      if (
        request.method !== 'elicitation/create' ||
        request.params?.mode !== 'form' ||
        !Array.isArray(alternativas) ||
        !alternativas.length ||
        alternativas.some((id) => typeof id !== 'string')
      ) {
        throw new Error('Elicitation MCP nao suportada');
      }
      record.pending = { key, alternativas, requestState: result.requestState };
      this.#pause(record);
      return;
    }
    if (result.isError) {
      const text = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      this.#transition(record, 'TASK_STATE_FAILED', text);
      return;
    }
    if (result.structuredContent?.reservado === false) {
      this.#transition(record, 'TASK_STATE_CANCELED', result.structuredContent.motivo);
      return;
    }
    const data = { ...result.structuredContent, politica: record.politica };
    if (!data.reserva || !data.sala) {
      throw new Error('Reserva ausente na resposta MCP');
    }
    record.task.artifacts = [
      { artifactId: randomUUID(), name: 'reserva', parts: [{ text: JSON.stringify(data) }] },
    ];
    this.#transition(
      record,
      'TASK_STATE_COMPLETED',
      `Reserva ${data.reserva} confirmada na ${data.sala}.`,
    );
  }
}
