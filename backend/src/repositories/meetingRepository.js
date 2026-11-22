const pool = require('../db');

// Acceso a datos de la tabla `meetings` — sin ninguna regla de negocio
// acá, solo las queries en sí.

// Crea (o reutiliza) la reunión por meeting_code — mismo truco de upsert
// que `userRepository.upsertUser`. `connection` es la de la
// transacción del service que llama (`roleService.registerRole`/
// `registerStudent`) — a diferencia de `activateClass` de abajo, este upsert
// NO toca `active`/`last_ended_*`, así que no sirve para arrancar
// una clase, solo para asegurar que la fila de la reunión exista.
async function upsertMeeting(connection, meetingCode) {
  const [result] = await connection.query(
    'INSERT INTO meetings (meeting_code) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [meetingCode]
  );
  return result.insertId;
}

// Estado completo de la clase (activa + la última finalización, si la
// hubo + el modo de atención vigente) — lo consumen tanto la decisión de
// "reanudable" como el catch-up que se manda al unirse a la sala WS (ver
// `services/classService.js`). `attention_mode_id` viaja acá para que
// `handleJoin` (ver `ws/handlers.js`) pueda mandar el catch-up del modo de
// atención con la MISMA consulta que ya hacía, sin una query aparte.
async function getClassState(meetingCode) {
  const [rows] = await pool.query(
    'SELECT active, last_ended_type, last_ended_at, attention_mode_id FROM meetings WHERE meeting_code = ?',
    [meetingCode]
  );
  return rows[0];
}

// Guarda el modo de atención elegido por el docente — upsert, mismo criterio
// que `activateClass`: la reunión debería existir siempre a esta altura
// (se crea en `/register-role`, antes de llegar a la pantalla pre-clase
// donde vive el selector), pero no cuesta nada cubrir el caso de que no
// exista todavía. No toca `active`/`last_ended_*` — el modo se puede elegir
// mientras la clase sigue detenida, independiente de esas columnas.
async function setAttentionMode(meetingCode, modeId) {
  await pool.query(
    `INSERT INTO meetings (meeting_code, attention_mode_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE attention_mode_id = ?`,
    [meetingCode, modeId, modeId]
  );
}

// Arranca (o reanuda desde cero) la clase — upsert: si la reunión todavía
// no existe en la base (no debería pasar — se crea en `/register-role`
// antes de llegar al panel — pero no cuesta nada cubrir el caso), se crea
// ya activa en vez de fallar. `last_ended_*` se limpia siempre:
// una vez que hay una clase en curso de nuevo, esos campos dejan de
// significar nada.
async function activateClass(meetingCode) {
  await pool.query(
    `INSERT INTO meetings (meeting_code, active, last_ended_type, last_ended_at)
     VALUES (?, TRUE, NULL, NULL)
     ON DUPLICATE KEY UPDATE active = TRUE, last_ended_type = NULL, last_ended_at = NULL`,
    [meetingCode]
  );
}

// Finaliza la clase — `type` es 'manual' (botón "Detener Clase") o
// 'automatic' (desconexión del docente sin querer). Se guarda la
// distinción por si sirve para analítica más adelante, aunque
// `isResumable()` no distingue entre ambas para decidir si ofrecer
// "reanudar" (ver `services/classService.js`).
async function markClassEnded(meetingCode, type) {
  await pool.query(
    `UPDATE meetings SET active = FALSE, last_ended_type = ?, last_ended_at = NOW()
     WHERE meeting_code = ?`,
    [type, meetingCode]
  );
}

// El docente elige "Reanudar" — reactiva la clase y limpia la marca de
// finalización, igual criterio que `activateClass` pero sin el upsert (acá
// la reunión ya existe con certeza: solo se llega a este punto tras pasar
// `isResumable()`, que ya requiere una fila existente).
async function reactivateClass(meetingCode) {
  await pool.query(
    `UPDATE meetings SET active = TRUE, last_ended_type = NULL, last_ended_at = NULL
     WHERE meeting_code = ?`,
    [meetingCode]
  );
}

// Solo lectura — resuelve el id interno de una reunión a partir de su
// código, para casos que no pasan por el upsert transaccional de arriba
// (ej. carga de documentos, ver `services/documentService.js`, que ya sabe
// que la reunión existe porque `roleService.getRole` encontró un docente
// para ese código). `null` si la reunión no existe.
async function getMeetingIdByCode(meetingCode) {
  const [rows] = await pool.query('SELECT id FROM meetings WHERE meeting_code = ?', [meetingCode]);
  return rows.length > 0 ? rows[0].id : null;
}

// Ancla de fase para las ventanas de 10s de `attention_snapshots` (ver
// `ws/attentionState.js#evaluateSnapshotsStart` y
// `frontend/src/screens/ConcentrationStats.jsx`) — se fija una sola vez por
// sesión de clase, en `services/classService.js#startClass`, nunca en
// `reactivateClass` (mismo criterio de "se congela al pausar, sigue vigente
// al reanudar" que ya usa `history` del lado del cliente).
async function setAttentionWindowStart(meetingCode, startedAt) {
  await pool.query(
    'UPDATE meetings SET attention_window_started_at = ? WHERE meeting_code = ?',
    [startedAt, meetingCode]
  );
}

async function getAttentionWindowStart(meetingCode) {
  const [rows] = await pool.query(
    'SELECT attention_window_started_at FROM meetings WHERE meeting_code = ?',
    [meetingCode]
  );
  return rows[0]?.attention_window_started_at ?? null;
}

module.exports = {
  upsertMeeting,
  getClassState,
  activateClass,
  markClassEnded,
  reactivateClass,
  getMeetingIdByCode,
  setAttentionMode,
  setAttentionWindowStart,
  getAttentionWindowStart,
};
