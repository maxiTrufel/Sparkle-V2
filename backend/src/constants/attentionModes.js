// Modos de clase — cada uno es un preset completo de las nueve variables del
// sistema de detección de atención (X/Y/K/Q/C del alumno, P/V_doc/Q_doc/C_doc
// del docente). Fuente ÚNICA de verdad de los valores numéricos: el frontend
// NUNCA duplica estos números — solo tiene sus propios nombres/descripciones
// para el selector (ver `frontend/src/constants/attentionModes.js`), y recibe
// los valores reales acá abajo vía WebSocket (`attention_mode_updated`, ver
// `ws/handlers.js`). Evita el mismo problema que ya tuvimos del lado del
// alumno con los defaults de Y duplicados a mano en dos archivos — acá no hay
// una segunda copia de los NÚMEROS en ningún lado.
//
// Fracciones 0-1 (no porcentaje 0-100) para threshold/qThreshold/pThreshold/
// qThresholdTeacher — mismo formato que ya usa todo el sistema (`threshold`,
// `qThreshold`, `pThreshold`, `qThresholdTeacher` en el frontend). Segundos
// como número entero.
// ─────────────────────────────────────────────────────────────────────────────
// SOBRE `threshold` (Y) — es el ÚNICO valor de acá que NO es una decisión
// pedagógica, y por eso vale lo mismo en los cinco modos.
//
// Y es el punto de operación del clasificador: define a partir de qué
// concentración se considera atento a un alumno (`detector.js`:
// `inattentive = (1 - p) <= Y`, o sea que la frontera en el espacio de
// probabilidad está en `1 - Y`). Cambiarlo no expresa una preferencia sobre el
// tipo de clase: cambia el recall de cada clase y la exactitud del sistema.
//
// Está fijado en 0,50 porque es el punto en el que el modelo fue validado
// (ver `Fase3_Registro_de_Resultados.md` §16 y `Ficha_Tecnica_Modelos.md` §11).
// Medido sobre ventanas de 50 s con predicciones out-of-fold de 79
// participantes (`Sparkle_V2_Fase3_7_Modos_de_Clase.ipynb`):
//
//   Y      balanced acc   detecta   marca mal a atentos
//   0,45      0,6906        49 %          11 %
//   0,50      0,7003        64 %          24 %   ← el validado
//   0,60      0,6106        92 %          70 %   ← el default anterior
//
// El valor anterior de 0,60 marcaba como desatento al 70 % de los alumnos que
// SÍ estaban atendiendo, porque señalaba desatención incluso cuando el propio
// modelo la consideraba menos probable que la atención (`p >= 0,40`). Se
// corrigió el 2026-08-01.
//
// Lo que sí varía por modo es todo lo demás: X (cuánto esperar antes de
// contar una captura), k y Q (cuántas capturas recientes y qué proporción
// disparan la alerta del alumno), P (qué fracción del curso dispara la alerta
// del docente) y los cooldowns. Esas sí son decisiones pedagógicas.
// ─────────────────────────────────────────────────────────────────────────────
const STUDENT_THRESHOLD = 0.5;

const ATTENTION_MODES = {
  1: {
    id: 1,
    name: 'Por Defecto',
    description: 'Modo estándar para cualquier clase universitaria. Valores balanceados.',
    // Ventana k·X = 180s (3 min, Tabla 2 de la tesis §3.1.3). C = misma
    // ventana, por diseño (ver el comentario grande de `pThreshold` más
    // abajo para el porqué de ese acoplamiento).
    student: {
      xSeconds: 2, threshold: STUDENT_THRESHOLD, k: 90, qThreshold: 0.75, cooldownSeconds: 180,
    },
    teacher: {
      pThreshold: 0.45, windowSecondsTeacher: 120, qThresholdTeacher: 0.7, cooldownSecondsTeacher: 120,
    },
  },
  2: {
    id: 2,
    name: 'Clase Teórica',
    description:
      'El profesor expone, los alumnos escuchan y toman apuntes. Más tolerante con distracciones cortas.',
    // Ventana k·X = 240s (4 min, Tabla 2).
    student: {
      xSeconds: 3, threshold: STUDENT_THRESHOLD, k: 80, qThreshold: 0.8, cooldownSeconds: 240,
    },
    teacher: {
      pThreshold: 0.4, windowSecondsTeacher: 150, qThresholdTeacher: 0.75, cooldownSecondsTeacher: 150,
    },
  },
  3: {
    id: 3,
    name: 'Clase Práctica',
    description: 'Resolución de ejercicios, laboratorio, trabajo en grupo.',
    // Ventana k·X = 240s (4 min, Tabla 2).
    student: {
      xSeconds: 3, threshold: STUDENT_THRESHOLD, k: 80, qThreshold: 0.85, cooldownSeconds: 240,
    },
    teacher: {
      pThreshold: 0.4, windowSecondsTeacher: 120, qThresholdTeacher: 0.7, cooldownSecondsTeacher: 120,
    },
  },
  4: {
    id: 4,
    name: 'Seminario / Debate',
    description: 'Participación activa, discusión, exposiciones. Se espera atención sostenida.',
    // Ventana k·X = 120s (2 min, Tabla 2).
    student: {
      xSeconds: 2, threshold: STUDENT_THRESHOLD, k: 60, qThreshold: 0.7, cooldownSeconds: 120,
    },
    teacher: {
      pThreshold: 0.5, windowSecondsTeacher: 90, qThresholdTeacher: 0.65, cooldownSecondsTeacher: 90,
    },
  },
  5: {
    id: 5,
    name: 'Repaso / Consulta',
    description: 'Clase de cierre o consultas antes de un parcial. Ritmo más relajado.',
    // Ventana k·X = 300s (5 min, Tabla 2).
    student: {
      xSeconds: 4, threshold: STUDENT_THRESHOLD, k: 75, qThreshold: 0.85, cooldownSeconds: 300,
    },
    teacher: {
      pThreshold: 0.35, windowSecondsTeacher: 180, qThresholdTeacher: 0.8, cooldownSecondsTeacher: 180,
    },
  },
};

// `pThreshold` (P) — desde la auditoría de 2026-08-11 contra la Tabla 2 de
// la tesis, representa la fracción ATENTA mínima del curso: la alerta
// grupal dispara cuando el porcentaje de atentos cae POR DEBAJO de
// `pThreshold * 100` (`pctAttentive < pThreshold * 100`). Antes de esa
// auditoría, este mismo campo se usaba con el sentido opuesto (fracción
// DESatenta mínima, `inattentiveFraction >= pThreshold`) en las cuatro
// implementaciones que consumen este preset — `backend/src/ws/attentionState.js`,
// `frontend/src/hooks/useGroupAttentionAlert.js`,
// `frontend/src/hooks/useAttentionHistory.js` y
// `frontend/src/ui/TeacherDebugLog.jsx` — todas corregidas en el mismo commit
// que este archivo, ninguna quedó con la fórmula vieja.

const DEFAULT_ATTENTION_MODE = 1;

// Acepta number o string (el WS manda JSON, `payload.modeId` puede llegar
// como cualquiera de los dos según cómo lo arme el cliente) — nunca confía
// en la forma exacta de lo que mandó el cliente.
function isValidAttentionMode(modeId) {
  const id = Number(modeId);
  return Number.isInteger(id) && Object.prototype.hasOwnProperty.call(ATTENTION_MODES, String(id));
}

// Devuelve el preset completo para un id — el default si el id no es válido,
// nunca `undefined` (quien llama nunca tiene que chequear null a mano).
function resolveAttentionMode(modeId) {
  const id = Number(modeId);
  return ATTENTION_MODES[id] || ATTENTION_MODES[DEFAULT_ATTENTION_MODE];
}

module.exports = {
  ATTENTION_MODES,
  DEFAULT_ATTENTION_MODE,
  isValidAttentionMode,
  resolveAttentionMode,
};
