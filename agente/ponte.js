import { randomUUID } from 'node:crypto';

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const terminal = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED']);
const booking = /^reservar sala=(\S+) inicio=(\S+) fim=(\S+) responsavel=(.+)$/;

export function criarPonte(mcp) {
  // Somente task é público. Continuação, chamada original e trace ficam privados.
  const tasks = new Map();
  function transition(record, state, text) {
    if (terminal.has(record.task.status.state))
      throw new RpcError(-32004, 'Task em estado terminal');
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
    if (message) record.task.history.push(message);
    if (terminal.has(state)) record.pending = undefined;
  }
  function pause(record) {
    transition(
      record,
      'TASK_STATE_INPUT_REQUIRED',
      `alternativas: ${record.pending.alternativas.join(', ')}`,
    );
  }
  function consume(record, result) {
    if (result.resultType === 'input_required') {
      const entries = Object.entries(result.inputRequests ?? {});
      if (entries.length !== 1 || !result.requestState)
        throw new Error('Resposta interativa MCP invalida');
      const [key, request] = entries[0];
      const field = request.params?.requestedSchema?.properties?.sala;
      const alternativas = field?.enum ?? (field?.const ? [field.const] : []);
      if (
        request.method !== 'elicitation/create' ||
        request.params?.mode !== 'form' ||
        !alternativas.length
      ) {
        throw new Error('Elicitation MCP nao suportada');
      }
      record.pending = { key, alternativas, requestState: result.requestState };
      pause(record);
    } else if (result.isError) {
      const text = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      transition(record, 'TASK_STATE_FAILED', text);
    } else if (result.structuredContent?.reservado === false) {
      transition(record, 'TASK_STATE_CANCELED', result.structuredContent.motivo);
    } else {
      const data = { ...result.structuredContent, politica: record.politica };
      if (!data.reserva || !data.sala) throw new Error('Reserva ausente na resposta MCP');
      record.task.artifacts = [
        { artifactId: randomUUID(), name: 'reserva', parts: [{ text: JSON.stringify(data) }] },
      ];
      transition(
        record,
        'TASK_STATE_COMPLETED',
        `Reserva ${data.reserva} confirmada na ${data.sala}.`,
      );
    }
  }
  return {
    get(id, historyLength) {
      const record = tasks.get(id);
      if (!record) throw new RpcError(-32001, 'Task nao encontrada');
      const task = structuredClone(record.task);
      if (historyLength !== undefined)
        task.history = historyLength === 0 ? [] : task.history.slice(-historyLength);
      return task;
    },
    async send(message, traceparent) {
      if (
        !message ||
        message.role !== 'ROLE_USER' ||
        typeof message.messageId !== 'string' ||
        !Array.isArray(message.parts) ||
        !message.parts.length ||
        message.parts.some((p) => typeof p?.text !== 'string')
      ) {
        throw new RpcError(-32602, 'message deve conter messageId, ROLE_USER e parts de texto');
      }
      const text = message.parts.map((p) => p.text).join('\n');
      let record;
      let params;
      if (message.taskId) {
        record = tasks.get(message.taskId);
        if (!record) throw new RpcError(-32001, 'Task nao encontrada');
        if (terminal.has(record.task.status.state))
          throw new RpcError(-32004, 'Task em estado terminal');
        if (record.task.status.state !== 'TASK_STATE_INPUT_REQUIRED')
          throw new RpcError(-32004, 'Task em processamento');
        if (message.contextId && message.contextId !== record.task.contextId)
          throw new RpcError(-32602, 'contextId divergente');
        record.task.history.push(structuredClone(message));
        const choice = /^escolha=(\S+)$/.exec(text)?.[1];
        if (choice !== 'recusar' && !record.pending.alternativas.includes(choice)) {
          pause(record);
          return structuredClone(record.task);
        }
        params = {
          ...record.original,
          requestState: record.pending.requestState,
          inputResponses: {
            [record.pending.key]:
              choice === 'recusar'
                ? { action: 'decline' }
                : { action: 'accept', content: { sala: choice } },
          },
        };
      } else {
        const match = booking.exec(text);
        if (!match)
          throw new RpcError(
            -32602,
            'Use reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>',
          );
        record = {
          task: {
            id: randomUUID(),
            contextId: randomUUID(),
            status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
            history: [structuredClone(message)],
          },
          traceparent,
        };
        tasks.set(record.task.id, record);
        record.original = {
          arguments: { sala: match[1], inicio: match[2], fim: match[3], responsavel: match[4] },
        };
      }
      transition(record, 'TASK_STATE_WORKING');
      await mcp.withTrace(record.traceparent ?? traceparent, async () => {
        try {
          if (!params) {
            const config = await mcp.preparar();
            record.politica = config.politica;
            record.original.name = config.tool;
            params = record.original;
          }
          consume(record, await mcp.call(params));
        } catch (error) {
          // Erros de transporte/protocolo não ecoam tokens ou corpos MCP no A2A.
          console.error(
            JSON.stringify({ taskId: record.task.id, error: error.name, code: error.code ?? null }),
          );
          transition(
            record,
            'TASK_STATE_FAILED',
            'Falha na comunicacao MCP ou continuacao invalida/expirada',
          );
        }
      });
      return structuredClone(record.task);
    },
  };
}
