export function criarAgentCard(baseUrl) {
  return {
    name: 'Central de Salas',
    description: 'Reserva salas de reuniao da Hill Valley Tech.',
    version: '1.0.0',
    supportedInterfaces: [
      {
        url: `${baseUrl.replace(/\/$/, '')}/a2a`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'reservar-sala',
        name: 'Reservar sala',
        description: 'Reserva uma sala e solicita uma escolha quando ha conflito.',
        tags: ['salas', 'agenda'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        examples: [
          'reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty',
        ],
      },
    ],
  };
}
