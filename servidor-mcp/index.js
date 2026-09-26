import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { criarHandler } from './server.js';

const handler = criarHandler();
const port = Number(process.env.MCP_PORT ?? 7301);
const server = createServer(toNodeHandler(handler));
server.listen(port, '127.0.0.1', () => console.error(`MCP: http://127.0.0.1:${port}/mcp`));
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close();
    void handler.close();
  });
