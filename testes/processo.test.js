import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { iniciar, portaLivre } from './processos.js';

test(
  'SIGTERM conclui resposta em andamento antes de fechar a dependencia MCP',
  { timeout: 5000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'a2a-shutdown-'));
    let child;
    try {
      const port = await portaLivre();
      const moduleUrl = new URL('../infra/processo.js', import.meta.url).href;
      const file = join(directory, 'server.mjs');
      await writeFile(
        file,
        `
      import { createServer } from 'node:http';
      import { iniciarServidor } from ${JSON.stringify(moduleUrl)};
      const server = createServer((_request, response) => {
        console.error('REQUEST_IN_PROGRESS');
        setTimeout(() => {
          response.end('ok');
          console.error('RESPONSE_SENT');
        }, 150);
      });
      await iniciarServidor(server, {
        port: ${port}, label: 'A2A',
        close: async () => console.error('DEPENDENCY_CLOSED'),
      });
    `,
      );
      child = await iniciar(file, {});
      const response = fetch(`http://127.0.0.1:${port}/`).then((result) => result.text());
      for (
        let attempt = 0;
        attempt < 100 && !child.logs().includes('REQUEST_IN_PROGRESS');
        attempt++
      ) {
        await delay(5);
      }
      assert.match(child.logs(), /REQUEST_IN_PROGRESS/);
      const stopped = child.stop();
      assert.equal(await response, 'ok');
      await stopped;
      const logs = child.logs();
      assert.match(logs, /DEPENDENCY_CLOSED/);
      assert.ok(logs.indexOf('RESPONSE_SENT') < logs.indexOf('DEPENDENCY_CLOSED'));
    } finally {
      await child?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
