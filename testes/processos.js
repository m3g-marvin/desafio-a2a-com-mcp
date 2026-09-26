import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export async function portaLivre() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

export async function iniciar(file, env) {
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timeout);
  };
  for (let i = 0; i < 200; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Processo encerrou: ${stderr}`);
    if (stderr.includes('http://127.0.0.1:')) return { stop, logs: () => stderr };
    await delay(25);
  }
  await stop();
  throw new Error(`Timeout ao iniciar ${file}: ${stderr}`);
}

export async function comando(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const [code] = await once(child, 'exit');
  return { code, output };
}
