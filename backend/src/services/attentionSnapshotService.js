const meetingRepository = require('../repositories/meetingRepository');
const attentionSnapshotRepository = require('../repositories/attentionSnapshotRepository');
const roleService = require('./roleService');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Historial de atención grupal para `ConcentrationStats.jsx` (docente) —
// solo el DOCENTE de la reunión puede consultarlo (mismo criterio de
// autorización que el resto de los endpoints de esta app: nunca confiar en
// que el `meetingCode` de la URL alcance por sí solo). A diferencia de
// `recoverySummaryService`/`classSummaryService` (docente O alumno), esto
// es exclusivamente para el panel del docente — no hay ninguna pantalla de
// alumno que lo consuma.
async function getAttentionSnapshots(meetingCode, email) {
  const { role } = await roleService.getRole(meetingCode, email);
  if (role !== 'teacher') {
    throw httpError(403, 'Solo el docente de esta reunión puede ver este historial.');
  }

  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const meetingId = await meetingRepository.getMeetingIdByCode(normalizedMeetingCode);
  if (!meetingId) throw httpError(404, 'La reunión no existe.');

  const rows = await attentionSnapshotRepository.getSnapshotsForMeeting(normalizedMeetingCode);
  // Ancla de fase de la sesión de clase ACTUAL (ver
  // `meetingRepository.setAttentionWindowStart`/`ws/attentionState.js`) —
  // el cliente (`ConcentrationStats.jsx`) la usa para alinear sus propias
  // ventanas de 10s a la misma grilla que ya usó el servidor al persistir
  // estos snapshots. `null` en reuniones que todavía no pasaron por un
  // `startClass` posterior a este cambio.
  const windowStartedAt = await meetingRepository.getAttentionWindowStart(normalizedMeetingCode);

  // Traducido a la forma que consume el frontend — `pct_attentive`/
  // `pct_no_face` vienen de MySQL como STRING (columnas DECIMAL, driver
  // `mysql2`), nunca number: se convierten acá, la única capa que conoce el
  // detalle de la fila cruda. `group_inattentive` (TINYINT(1) en MySQL) ya
  // llega como 0/1 desde `mysql2`, `Boolean(...)` lo deja explícito.
  return {
    snapshots: rows.map((row) => ({
      timestamp: row.timestamp,
      pctAttentive: Number(row.pct_attentive),
      pctNoFace: Number(row.pct_no_face),
      totalStudents: row.total_students,
      groupInattentive: Boolean(row.group_inattentive),
    })),
    windowStartedAt,
  };
}

module.exports = { getAttentionSnapshots };
