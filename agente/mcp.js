import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AsyncLocalStorage } from 'node:async_hooks';

export async function conectarMcp(url) {
  const traces = new AsyncLocalStorage();
  const client = new Client(
    { name: 'agente-central-de-salas', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      inputRequired: { autoFulfill: false },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    // Inclui também o probe de descoberta na mesma cadeia de trace da Task.
    fetch: (url, init) => {
      const traceparent = traces.getStore();
      if (traceparent && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        body.params ??= {};
        body.params._meta = { ...body.params._meta, traceparent };
        init = { ...init, body: JSON.stringify(body) };
      }
      return fetch(url, init);
    },
  });
  let connected;
  let tools;
  async function descobrir() {
    connected ??= client.connect(transport).catch((error) => {
      connected = undefined;
      throw error;
    });
    await connected;
    if (!tools) {
      const discovered = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        discovered.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      tools = discovered;
    }
    // A intenção tem nome fixo; sua definição e seu schema vêm da descoberta.
    const tool = tools.find((tool) => tool.name === 'reservar_sala');
    if (!tool) throw new Error('Servidor MCP nao oferece a ferramenta de reserva');
    return tool;
  }
  return {
    withTrace: (trace, fn) => traces.run(trace, fn),
    async preparar() {
      const tool = await descobrir();
      const resource = await client.readResource({ uri: 'politica://uso' });
      const text = resource.contents.map((part) => part.text ?? '').join('\n');
      const match = /^versao:\s*(\S+)/.exec(text);
      if (!match) throw new Error('Resource de politica sem versao');
      return { tool: tool.name, politica: match[1] };
    },
    call: (params) =>
      client.request({ method: 'tools/call', params }, { allowInputRequired: true }),
    close: () => client.close(),
  };
}
