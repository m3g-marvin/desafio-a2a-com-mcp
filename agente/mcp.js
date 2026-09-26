import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AsyncLocalStorage } from 'node:async_hooks';

export class ClienteMcp {
  #client;
  #transport;
  #traces = new AsyncLocalStorage();
  #connected;
  #discovery;

  constructor(url) {
    this.#client = new Client(
      { name: 'agente-central-de-salas', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        inputRequired: { autoFulfill: false },
      },
    );
    this.#transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: (requestUrl, init) => this.#fetchWithTrace(requestUrl, init),
    });
  }

  withTrace(trace, fn) {
    return this.#traces.run(trace, fn);
  }

  async preparar() {
    const tool = await this.#descobrir();
    const resource = await this.#client.readResource({ uri: 'politica://uso' });
    const text = resource.contents.map((part) => part.text ?? '').join('\n');
    const match = /^versao:\s*(\S+)/.exec(text);
    if (!match) {
      throw new Error('Resource de politica sem versao');
    }
    return { tool: tool.name, politica: match[1] };
  }

  call(params) {
    return this.#client.request({ method: 'tools/call', params }, { allowInputRequired: true });
  }

  close() {
    return this.#client.close();
  }

  #fetchWithTrace(url, init) {
    // Inclui também o probe de descoberta na mesma cadeia de trace da Task.
    const traceparent = this.#traces.getStore();
    if (traceparent && typeof init?.body === 'string') {
      const body = JSON.parse(init.body);
      body.params ??= {};
      body.params._meta = { ...body.params._meta, traceparent };
      return fetch(url, { ...init, body: JSON.stringify(body) });
    }
    return fetch(url, init);
  }

  async #listarTools() {
    const tools = [];
    let cursor;
    do {
      const page = await this.#client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async #descobrir() {
    this.#connected ??= this.#client.connect(this.#transport).catch((error) => {
      this.#connected = undefined;
      throw error;
    });
    await this.#connected;
    // Chamadas simultâneas compartilham a descoberta, mas não o estado das Tasks.
    this.#discovery ??= this.#listarTools().catch((error) => {
      this.#discovery = undefined;
      throw error;
    });
    const tools = await this.#discovery;
    // A intenção tem nome fixo; sua definição e seu schema vêm da descoberta.
    const tool = tools.find((tool) => tool.name === 'reservar_sala');
    if (!tool) {
      throw new Error('Servidor MCP nao oferece a ferramenta de reserva');
    }
    return tool;
  }
}
