const pool = require('../db');

// Acceso a datos de la tabla `attention_snapshots` — sin ninguna regla de
// negocio acá, solo las queries en sí (mismo criterio que
// `transcriptRepository.js`). Quien calcula los porcentajes/el veredicto de
// "grupo desatento" es `backend/src/ws/attentionState.js` (el intervalo de
// 10 segundos, `SNAPSHOT_INTERVAL_MS`); esto solo inserta la fila ya
// calculada y la lee de vuelta.

async function insertSnapshot(meetingCode, {
  pctAttentive, pctNoFace, totalStudents, groupInattentive,
}) {
  await pool.query(
    `INSERT INTO attention_snapshots
       (meeting_code, pct_attentive, pct_no_face, total_students, group_inattentive)
     VALUES (?, ?, ?, ?, ?)`,
    [meetingCode, pctAttentive, pctNoFace, totalStudents, groupInattentive]
  );
}

// Todos los snapshots de una reunión, en orden CRONOLÓGICO — usa el índice
// compuesto `idx_attention_snapshots_meeting_time` (mismo criterio que
// `transcriptRepository.getAllSegments`, sin `LIMIT`: la base histórica
// completa de la línea temporal/mapa de calor del docente, no un recorte).
async function getSnapshotsForMeeting(meetingCode) {
  const [rows] = await pool.query(
    `SELECT timestamp, pct_attentive, pct_no_face, total_students, group_inattentive
     FROM attention_snapshots
     WHERE meeting_code = ?
     ORDER BY timestamp ASC`,
    [meetingCode]
  );
  return rows;
}

module.exports = { insertSnapshot, getSnapshotsForMeeting };
