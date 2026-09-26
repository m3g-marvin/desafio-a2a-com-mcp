import { readFileSync } from 'node:fs';
import { z } from 'zod';

const read = (name) => readFileSync(new URL(`../dados/${name}`, import.meta.url), 'utf8');
const HOUR_MS = 60 * 60 * 1000;
const TIMEZONE_OFFSET_MS = -3 * HOUR_MS;
const MAX_DURATION_MS = 2 * HOUR_MS;
const MAX_ALTERNATIVES = 3;
const isoDateTime = z.iso.datetime({ offset: true });

export const politica = read('politica-de-uso.md');
const policyVersion = /^versao:\s*(\S+)/.exec(politica);
if (!policyVersion) {
  throw new Error('Politica de uso sem versao na primeira linha');
}
export const versaoPolitica = policyVersion[1];
export const salas = JSON.parse(read('salas.json'));
const roomsById = new Map(salas.map((room) => [room.id, room]));

function compareRooms(a, b) {
  return a.capacidade - b.capacidade || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Somente as reservas persistem em memória. Nenhuma continuação MCP fica aqui.
export class AgendaSalas {
  #reservas;
  #sequence;

  constructor() {
    this.#reservas = JSON.parse(read('reservas.json'));
    this.#sequence = Math.max(
      0,
      ...this.#reservas.map((reserva) => Number(reserva.id.replace('res-', ''))),
    );
  }

  conflitos(args) {
    // Consultas retornam cópias para não expor a agenda interna a mutações.
    return structuredClone(this.#encontrarConflitos(args));
  }

  validar({ sala, inicio, fim }) {
    const room = roomsById.get(sala);
    if (!room) {
      throw new Error(`Sala inexistente: ${sala}`);
    }
    const start = Date.parse(inicio);
    const end = Date.parse(fim);
    if (
      !isoDateTime.safeParse(inicio).success ||
      !isoDateTime.safeParse(fim).success ||
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      throw new Error('Data invalida: use ISO 8601 com fuso horario');
    }
    if (end <= start) {
      throw new Error('Intervalo invalido: fim deve ser posterior a inicio');
    }
    const localStart = new Date(start + TIMEZONE_OFFSET_MS);
    const localEnd = new Date(end + TIMEZONE_OFFSET_MS);
    const day = localStart.toISOString().slice(0, 10);
    const opening = Date.parse(`${day}T08:00:00-03:00`);
    const closing = Date.parse(`${day}T20:00:00-03:00`);
    if (localEnd.toISOString().slice(0, 10) !== day || start < opening || end > closing) {
      throw new Error('Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00');
    }
    if (end - start > MAX_DURATION_MS) {
      throw new Error('Duracao acima do limite: a politica permite no maximo 2 horas');
    }
    return room;
  }

  alternativas(args) {
    const requestedRoom = this.validar(args);
    return salas
      .filter(
        (room) =>
          room.capacidade >= requestedRoom.capacidade &&
          !this.#encontrarConflitos({ ...args, sala: room.id }).length,
      )
      .sort(compareRooms)
      .slice(0, MAX_ALTERNATIVES)
      .map((room) => room.id);
  }

  reservar(args) {
    this.validar(args);
    if (this.#encontrarConflitos(args).length) {
      throw new Error('A sala escolhida ficou ocupada no intervalo');
    }
    const reserva = { id: `res-${String(++this.#sequence).padStart(4, '0')}`, ...args };
    this.#reservas.push(reserva);
    return { reserva: reserva.id, reservado: true, ...args, politica: versaoPolitica };
  }

  #encontrarConflitos({ sala, inicio, fim }) {
    const start = Date.parse(inicio);
    const end = Date.parse(fim);
    return this.#reservas.filter(
      (reserva) =>
        reserva.sala === sala &&
        start < Date.parse(reserva.fim) &&
        end > Date.parse(reserva.inicio),
    );
  }
}
