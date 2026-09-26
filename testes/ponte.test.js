import test from 'node:test';
import assert from 'node:assert/strict';
import { criarPonte } from '../agente/ponte.js';

test('GetTask observa WORKING; falha da tool permanece no histórico; terminal é definitivo', async () => {
  let release;
  let entered;
  const working = new Promise((resolve) => {
    entered = resolve;
  });
  const response = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const ponte = criarPonte({
    withTrace: (_trace, fn) => fn(),
    preparar: async () => ({ tool: 'reservar_sala', politica: 'resource-version' }),
    call: () => {
      if (++calls === 1)
        return {
          resultType: 'input_required',
          requestState: 'token-opaco-para-o-agente',
          inputRequests: {
            escolha: {
              method: 'elicitation/create',
              params: {
                mode: 'form',
                requestedSchema: { properties: { sala: { enum: ['sala-fusca'] } } },
              },
            },
          },
        };
      entered();
      return response;
    },
  });
  const message = {
    messageId: 'user-1',
    role: 'ROLE_USER',
    parts: [
      {
        text: 'reservar sala=sala-delorean inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Doc',
      },
    ],
  };
  const paused = await ponte.send(message);
  const pending = ponte.send({
    ...message,
    taskId: paused.id,
    parts: [{ text: 'escolha=sala-fusca' }],
  });
  await working;
  assert.equal(ponte.get(paused.id).status.state, 'TASK_STATE_WORKING');
  release({ isError: true, content: [{ type: 'text', text: 'Sala inexistente: sala-delorean' }] });
  const task = await pending;
  assert.equal(ponte.get(task.id).status.state, 'TASK_STATE_FAILED');
  assert.ok(task.history.some((item) => item.parts[0].text === 'Sala inexistente: sala-delorean'));
  await assert.rejects(() => ponte.send({ ...message, taskId: task.id }), { code: -32004 });
  const copy = ponte.get(task.id);
  copy.status.state = 'TASK_STATE_WORKING';
  assert.equal(ponte.get(task.id).status.state, 'TASK_STATE_FAILED');
});
