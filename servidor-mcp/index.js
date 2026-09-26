import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { carregarAmbiente, lerPorta } from '../infra/configuracao.js';
import { iniciarServidor } from '../infra/processo.js';
import { criarHandler } from './server.js';

carregarAmbiente();

const port = lerPorta('MCP_PORT', 7301);
const handler = criarHandler();
const server = createServer(toNodeHandler(handler));

await iniciarServidor(server, { port, label: 'MCP', close: () => handler.close() });
