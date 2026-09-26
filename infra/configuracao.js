import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

export function carregarAmbiente() {
  const { error } = config({
    path: fileURLToPath(new URL('../.env', import.meta.url)),
    quiet: true,
    override: false,
  });
  if (error && error.code !== 'ENOENT') {
    throw new Error('Nao foi possivel carregar o arquivo .env', { cause: error });
  }
}

export function lerPorta(name, fallback, env = process.env) {
  const value = String(env[name] ?? fallback);
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} deve ser uma porta inteira entre 1 e 65535`);
  }
  return port;
}

export function lerUrlHttp(name, fallback, env = process.env) {
  let url;
  try {
    url = new URL(env[name] ?? fallback);
  } catch {
    throw new Error(`${name} deve ser uma URL HTTP ou HTTPS absoluta`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} deve ser uma URL HTTP ou HTTPS absoluta`);
  }
  return url.href;
}
