const pool = require('../db');
const { retryOnDeadlock } = require('../utils/retryOnDeadlock');

// Acceso a datos de la tabla `connection_sessions` — sin ninguna regla de
// negocio acá (el criterio de CUÁNDO abrir/cerrar una sesión vive en
// `services/sessionService.js`), solo las queries en sí. Las tres queries
// de escritura pasan por `retryOnDeadlock` (Etapa 68): son
// UPDATE/INSERT que pueden colisionar entre sí si el docente y un alumno se
// desconectan casi al mismo tiempo.

// El `NOT EXISTS` evita duplicar una sesión abierta para la misma persona
// (ej. un "re-join sobre el mismo socket físico" mientras la clase ya está
// activa: sin este chequeo, cada catch-up de "join" abriría una fila nueva
// sin haber cerrado la anterior).
function openSession(meetingCode, email) {
  return retryOnDeadlock(() =>
    pool.query(
      `INSERT INTO connection_sessions (meeting_id, user_id, connected_at)
       SELECT r.id, u.id, NOW()
       FROM meetings r, users u
       WHERE r.meeting_code = ? AND u.email = ?
         AND NOT EXISTS (
           SELECT 1 FROM connection_sessions s2
           WHERE s2.meeting_id = r.id AND s2.user_id = u.id AND s2.disconnected_at IS NULL
         )`,
      [meetingCode, email]
    )
  );
}

function closeSession(meetingCode, email) {
  return retryOnDeadlock(() =>
    pool.query(
      `UPDATE connection_sessions s
       JOIN meetings r ON r.id = s.meeting_id
       JOIN users u ON u.id = s.user_id
       SET s.disconnected_at = NOW()
       WHERE r.meeting_code = ? AND u.email = ? AND s.disconnected_at IS NULL`,
      [meetingCode, email]
    )
  );
}

// Cierra CUALQUIER sesión abierta de esta reunión de una — se usa cuando la
// clase entera termina (manual o automática) con uno o más alumnos todavía
// conectados, en vez de tener que recorrer las salas y cerrar alumno por
// alumno.
function closeAllOpenSessions(meetingCode) {
  return retryOnDeadlock(() =>
    pool.query(
      `UPDATE connection_sessions s
       JOIN meetings r ON r.id = s.meeting_id
       SET s.disconnected_at = NOW()
       WHERE r.meeting_code = ? AND s.disconnected_at IS NULL`,
      [meetingCode]
    )
  );
}

// Filas crudas del historial (un tramo de conexión por fila) — el
// agrupamiento por alumno vive en `services/sessionService.
// getHistoryByMeeting`, que es quien arma la forma final de la
// respuesta.
async function getHistoryRows(meetingCode) {
  const [rows] = await pool.query(
    `SELECT u.email, p.name, s.connected_at, s.disconnected_at
     FROM connection_sessions s
     JOIN meetings r ON r.id = s.meeting_id
     JOIN users u ON u.id = s.user_id
     JOIN participations p ON p.meeting_id = s.meeting_id AND p.user_id = s.user_id
     WHERE r.meeting_code = ?
     ORDER BY u.email ASC, s.connected_at DESC`,
    [meetingCode]
  );
  return rows;
}

// Tramos de conexión de UN alumno, ya llevados al MISMO RELOJ que
// `transcript_segments` — para el "Quiz final" (`services/finalQuizService.js`),
// que cruza ambas tablas para saber qué se explicó mientras el alumno no estaba.
//
// ⚠️ Las dos tablas NO guardan la hora igual: `connection_sessions` usa el
// `NOW()` de la base (UTC en el contenedor de producción, hora local en una
// base de desarrollo), mientras que la transcripción se guarda SIEMPRE en
// UTC−3 fijo (`vexaService.normalizeTimestamp`). Compararlas crudas daría
// 3 horas de error en producción. Por eso acá se corre cada tramo en
// `-180 - (desfase de la base respecto de UTC)` minutos: con la base en UTC
// eso resta 3 horas; con la base ya en hora argentina, no mueve nada.
// `NOW()` y `UTC_TIMESTAMP()` se evalúan en el mismo instante de la
// sentencia, así que la diferencia en minutos es exacta.
//
// Una sesión todavía abierta (`disconnected_at` NULL) cuenta hasta ahora.
async function getStudentSessionsInTranscriptClock(meetingCode, email) {
  const [rows] = await pool.query(
    `SELECT
       DATE_ADD(s.connected_at, INTERVAL (-180 - TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW())) MINUTE) AS connectedAt,
       DATE_ADD(COALESCE(s.disconnected_at, NOW()), INTERVAL (-180 - TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW())) MINUTE) AS disconnectedAt
     FROM connection_sessions s
     JOIN meetings r ON r.id = s.meeting_id
     JOIN users u ON u.id = s.user_id
     WHERE r.meeting_code = ? AND u.email = ?
     ORDER BY s.connected_at ASC`,
    [meetingCode, email]
  );
  return rows.map((row) => ({ from: row.connectedAt, to: row.disconnectedAt }));
}

module.exports = { openSession, closeSession, closeAllOpenSessions, getHistoryRows, getStudentSessionsInTranscriptClock };
