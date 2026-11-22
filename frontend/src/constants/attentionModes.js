// Modos de clase — SOLO nombre/descripción para el selector del docente
// (`ui/AttentionModeSelector.jsx`). Los 9 valores numéricos reales que
// implica cada modo (X/Y/K/Q/C del alumno, P/V_doc/Q_doc/C_doc del docente)
// NUNCA se duplican acá — viven únicamente en
// `backend/src/constants/attentionModes.js` y llegan por WebSocket
// (`attention_mode_updated`, ver `hooks/useAttentionModeSync.js`) apenas el
// docente elige un modo o un socket se une a la reunión. A propósito: ya
// tuvimos el problema de dos copias hardcodeadas de un mismo default
// desincronizándose (Y del alumno, auditoría anterior) — acá no hay una
// segunda copia de los NÚMEROS en ningún lado, ni siquiera para mostrar un
// preview en el selector.
// `icon` (pedido explícito — rediseño del selector a tarjetas, ver
// `ui/AttentionModeSelector.jsx`): un emoji por modo, puramente decorativo
// para la tarjeta — no tiene ninguna relación con los valores numéricos, así
// que vive acá sin romper el criterio de arriba (nombre/descripción/ícono
// son presentación; los números son del backend).
export const ATTENTION_MODES = [
  {
    id: 1,
    name: 'Por Defecto',
    description: 'Modo estándar para cualquier clase universitaria. Valores balanceados.',
    icon: '🧭',
  },
  {
    id: 2,
    name: 'Clase Teórica',
    description:
      'El profesor expone, los alumnos escuchan y toman apuntes. Más tolerante con distracciones cortas.',
    icon: '📖',
  },
  {
    id: 3,
    name: 'Clase Práctica',
    description: 'Resolución de ejercicios, laboratorio, trabajo en grupo.',
    icon: '🛠️',
  },
  {
    id: 4,
    name: 'Seminario / Debate',
    description: 'Participación activa, discusión, exposiciones. Se espera atención sostenida.',
    icon: '💬',
  },
  {
    id: 5,
    name: 'Repaso / Consulta',
    description: 'Clase de cierre o consultas antes de un parcial. Ritmo más relajado.',
    icon: '📝',
  },
];

export const DEFAULT_ATTENTION_MODE = 1;
