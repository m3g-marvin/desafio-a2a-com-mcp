import { createServer } from 'node:http';
import { carregarAmbiente, lerPorta, lerUrlHttp } from '../infra/configuracao.js';
import { iniciarServidor } from '../infra/processo.js';
import { criarAgentCard } from './card.js';
import { criarHandlerA2a } from './http.js';
import { ClienteMcp } from './mcp.js';
import { PonteA2a } from './ponte.js';

carregarAmbiente();

const port = lerPorta('AGENT_PORT', 7300);
const mcpUrl = lerUrlHttp('MCP_URL', 'http://127.0.0.1:7301/mcp');
const agentUrl = lerUrlHttp('AGENT_URL', `http://127.0.0.1:${port}`);
const mcp = new ClienteMcp(mcpUrl);
const ponte = new PonteA2a(mcp);
const card = criarAgentCard(agentUrl);
const server = createServer(criarHandlerA2a({ ponte, card }));

await iniciarServidor(server, { port, label: 'A2A', close: () => mcp.close() });
