const connectionSessionRepository = require('../repositories/connectionSessionRepository');

// Reglas de negocio del historial de sesiones de conexión (Etapa 68, Cambio
// 3) — ver `scripts/init-db.js` para el criterio completo de cuándo una
// fila de `connection_sessions` se abre/cierra (solo mientras la clase está
// activa, no cualquier conexión a la sala WS). Solo las consume
// `ws/handlers.js` (abrir/cerrar sesiones) y el controller REST (leer el
// historial completo).

async function openSession(meetingCode, email) {
  if (!email) return;
  try {
    await connectionSessionRepository.openSession(meetingCode, email);
  } catch (err) {
    console.error(`[Sparkle][WS] Error abriendo sesión de conexión para ${email} en "${meetingCode}":`, err.message);
  }
}

async function closeSession(meetingCode, email) {
  if (!email) return;
  try {
    await connectionSessionRepository.closeSession(meetingCode, email);
  } catch (err) {
    console.error(`[Sparkle][WS] Error cerrando sesión de conexión para ${email} en "${meetingCode}":`, err.message);
  }
}

// Cierra CUALQUIER sesión abierta de esta reunión de una — se usa cuando la
// clase entera termina (manual o automática) con uno o más alumnos todavía
// conectados.
async function closeAllOpenSessions(meetingCode) {
  try {
    await connectionSessionRepository.closeAllOpenSessions(meetingCode);
  } catch (err) {
    console.error(`[Sparkle][WS] Error cerrando sesiones de conexión de "${meetingCode}":`, err.message);
  }
}

// Historial de TODOS los alumnos que estuvieron conectados alguna vez a
// esta reunión (no solo los conectados ahora), agrupado por alumno — cada
// uno aparece una sola vez, con su lista de sesiones ordenada de la más
// reciente a la más vieja. El agrupamiento vive acá, no en el controller ni
// en el repositorio: es la forma final del dato de dominio, más allá de las
// filas crudas que devuelve la query.
async function getHistoryByMeeting(meetingCode) {
  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const rows = await connectionSessionRepository.getHistoryRows(normalizedMeetingCode);

  const byEmail = new Map();
  for (const row of rows) {
    if (!byEmail.has(row.email)) {
      byEmail.set(row.email, { email: row.email, name: row.name, sessions: [] });
    }
    byEmail.get(row.email).sessions.push({ connectedAt: row.connected_at, disconnectedAt: row.disconnected_at });
  }

  return [...byEmail.values()];
}

module.exports = { openSession, closeSession, closeAllOpenSessions, getHistoryByMeeting };
