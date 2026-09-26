import { readFileSync } from 'node:fs';
import { z } from 'zod';

const read = (name) => readFileSync(new URL(`../dados/${name}`, import.meta.url), 'utf8');
export const politica = read('politica-de-uso.md');
export const versaoPolitica = /^versao:\s*(.+)$/m.exec(politica)[1].trim();
export const salas = JSON.parse(read('salas.json'));

// Somente as reservas persistem em memória. Nenhuma continuação MCP fica aqui.
export function criarAgenda() {
  const reservas = JSON.parse(read('reservas.json'));
  let sequence = Math.max(...reservas.map((r) => Number(r.id.replace('res-', ''))));

  function validar({ sala, inicio, fim }) {
    const room = salas.find((r) => r.id === sala);
    if (!room) throw new Error(`Sala inexistente: ${sala}`);
    const start = Date.parse(inicio);
    const end = Date.parse(fim);
    const iso = z.iso.datetime({ offset: true });
    if (
      !iso.safeParse(inicio).success ||
      !iso.safeParse(fim).success ||
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      throw new Error('Data invalida: use ISO 8601 com fuso horario');
    }
    if (end <= start) throw new Error('Intervalo invalido: fim deve ser posterior a inicio');
    const localStart = new Date(start - 3 * 3600000);
    const localEnd = new Date(end - 3 * 3600000);
    const day = localStart.toISOString().slice(0, 10);
    const opening = Date.parse(`${day}T08:00:00-03:00`);
    const closing = Date.parse(`${day}T20:00:00-03:00`);
    if (localEnd.toISOString().slice(0, 10) !== day || start < opening || end > closing) {
      throw new Error('Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00');
    }
    if (end - start > 2 * 3600000)
      throw new Error('Duracao acima do limite: a politica permite no maximo 2 horas');
    return room;
  }

  function conflitos({ sala, inicio, fim }) {
    return reservas.filter(
      (r) =>
        r.sala === sala &&
        Date.parse(inicio) < Date.parse(r.fim) &&
        Date.parse(fim) > Date.parse(r.inicio),
    );
  }

  function alternativas(args) {
    const room = validar(args);
    return salas
      .filter((r) => r.capacidade >= room.capacidade && !conflitos({ ...args, sala: r.id }).length)
      .sort((a, b) => a.capacidade - b.capacidade || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 3)
      .map((r) => r.id);
  }

  function reservar(args) {
    validar(args);
    if (conflitos(args).length) throw new Error('A sala escolhida ficou ocupada no intervalo');
    const reserva = { id: `res-${String(++sequence).padStart(4, '0')}`, ...args };
    reservas.push(reserva);
    return { reserva: reserva.id, reservado: true, ...args, politica: versaoPolitica };
  }

  return { validar, conflitos, alternativas, reservar };
}
