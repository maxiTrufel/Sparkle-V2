const pool = require('../db');

// Acceso a datos de la tabla `transcript_segments` — sin ninguna regla de
// negocio acá, solo las queries en sí (ver `services/vexaService.js` para
// la persistencia de segmentos nuevos, que sigue viviendo ahí; esta
// función es la única lectura que hoy vive en un repositorio propio).

// Últimos `limit` segmentos de una reunión, en orden CRONOLÓGICO (más
// viejo primero) — pensado como contexto para la generación de preguntas
// con IA (ver `providers/openAIQuestionProvider.js`), no para mostrar el
// historial completo (eso lo sigue cubriendo `vexaService.
// listStoredSegments`, sin `LIMIT`, para el endpoint de transcripción
// completa). El `ORDER BY ... DESC LIMIT ?` trae los N más RECIENTES —
// se invierte en JS (`.reverse()`) para que el texto le llegue al modelo
// en el orden real en que se dijo, no del más nuevo al más viejo.
//
// A propósito SIN caché (ver el índice compuesto en
// `scripts/init-db.js` que sostiene esta query): la transcripción cambia
// todo el tiempo mientras la clase sigue en vivo — un caché acá
// necesitaría invalidarse en cada segmento nuevo que llega (cada pocos
// segundos, ver `vexaService.startPolling`), lo que termina costando más
// mantenerlo coherente que simplemente dejar que MySQL resuelva la
// consulta ya indexada en cada pedido.
async function getRecentSegments(meetingCode, limit) {
  const [rows] = await pool.query(
    `SELECT speaker, text, absolute_start_time, absolute_end_time
     FROM transcript_segments
     WHERE meeting_code = ?
     ORDER BY absolute_start_time DESC
     LIMIT ?`,
    [meetingCode, limit]
  );
  return rows.reverse();
}

// TODOS los segmentos de una reunión, en orden CRONOLÓGICO — a diferencia
// de `getRecentSegments` (pensada para el contexto acotado de "Generar
// pregunta", en vivo), esta es para el resumen de clase (ver
// `providers/openAIClassSummaryProvider.js`): ahí hace falta la
// transcripción COMPLETA, no un recorte de los últimos fragmentos. Sin
// `LIMIT`, así que no tiene sentido el truco DESC+reverse de la otra
// función (no hay nada que "los últimos N" optimice acá) — se ordena
// ASC directo, usando el mismo índice compuesto
// (`idx_transcript_segments_meeting_time`) solo para el filtro+orden, sin
// aprovechar ningún LIMIT.
async function getAllSegments(meetingCode) {
  const [rows] = await pool.query(
    `SELECT speaker, text, absolute_start_time, absolute_end_time
     FROM transcript_segments
     WHERE meeting_code = ?
     ORDER BY absolute_start_time ASC`,
    [meetingCode]
  );
  return rows;
}

// Segmentos de una reunión desde `sinceDate` (objeto `Date`) en adelante,
// en orden CRONOLÓGICO — pensada para "Recuperar contenido"
// (`services/recoverySummaryService.js`): a diferencia de
// `getRecentSegments` (últimos N por CANTIDAD) y `getAllSegments` (toda la
// clase), acá el corte es por VENTANA DE TIEMPO ("los últimos 2-3
// minutos"), calculada por quien llama (`new Date(Date.now() - ms)`), no
// acá adentro — mismo criterio que el resto de este archivo, sin ninguna
// regla de negocio en el repositorio. Usa el mismo índice compuesto
// `(meeting_code, absolute_start_time)` que ya sostiene las otras dos
// queries, sin necesitar ningún cambio de schema.
async function getSegmentsSince(meetingCode, sinceDate) {
  const [rows] = await pool.query(
    `SELECT speaker, text, absolute_start_time, absolute_end_time
     FROM transcript_segments
     WHERE meeting_code = ? AND absolute_start_time >= ?
     ORDER BY absolute_start_time ASC`,
    [meetingCode, sinceDate]
  );
  return rows;
}

module.exports = { getRecentSegments, getAllSegments, getSegmentsSince };
