import { once } from 'node:events';

const SHUTDOWN_TIMEOUT_MS = 5000;

// Espera as respostas HTTP em andamento antes de fechar o cliente/handler MCP.
export async function iniciarServidor(server, { port, label, close }) {
  try {
    const listening = once(server, 'listening');
    server.listen(port, '127.0.0.1');
    await listening;
  } catch (error) {
    await close();
    throw error;
  }
  console.error(`${label}: http://127.0.0.1:${port}${label === 'MCP' ? '/mcp' : '/a2a'}`);

  let stopping = false;
  function onRequest(_request, response) {
    response.once('finish', () => {
      if (stopping) {
        // A conexão só fica ociosa depois dos listeners de finish do Node.
        setImmediate(() => server.closeIdleConnections());
      }
    });
  }
  server.on('request', onRequest);

  async function stop() {
    if (stopping) {
      return;
    }
    stopping = true;
    const timeout = setTimeout(() => server.closeAllConnections(), SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    try {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } finally {
      clearTimeout(timeout);
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      server.off('request', onRequest);
      await close();
    }
  }

  function onSignal() {
    void stop().catch((error) => {
      console.error(`${label}: falha ao encerrar: ${error.message}`);
      process.exitCode = 1;
    });
  }
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
