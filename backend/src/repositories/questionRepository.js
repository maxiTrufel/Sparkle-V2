const pool = require('../db');

// Acceso a datos de la tabla `questions` — sin ninguna regla de negocio
// acá (validación de campos, autorización, etc.), solo las queries en sí
// (ver `services/questionService.js`).

// Crea la pregunta YA activa, atómicamente, a partir del `meeting_code`
// (sin un SELECT previo para resolver el `meeting_id`: el INSERT...SELECT
// lo resuelve en la misma sentencia). Devuelve `null` si la reunión no
// existe — quien llama decide qué hacer con eso (ver `questionService`).
//
// El índice único `uq_questions_one_active_per_meeting` (ver
// `scripts/init-db.js`) es quien de verdad impide dos preguntas activas a
// la vez para la misma reunión: si ya hay una activa, esta consulta
// termina en `ER_DUP_ENTRY` — se deja propagar tal cual, sin atraparlo acá
// (la traducción a un mensaje claro vive en el service).
async function createActiveQuestion(
  meetingCode,
  { prompt, optionA, optionB, optionC, optionD, correctOption, durationSeconds }
) {
  const [result] = await pool.query(
    `INSERT INTO questions
       (meeting_id, prompt, option_a, option_b, option_c, option_d, correct_option, duration_seconds, started_at, expires_at)
     SELECT m.id, ?, ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND)
     FROM meetings m
     WHERE m.meeting_code = ?`,
    [prompt, optionA, optionB, optionC, optionD, correctOption, durationSeconds, durationSeconds, meetingCode]
  );
  if (result.affectedRows === 0) return null;
  return getQuestionById(result.insertId);
}

async function getQuestionById(id) {
  const [rows] = await pool.query('SELECT * FROM questions WHERE id = ?', [id]);
  return rows[0] || null;
}

// La pregunta activa (si la hay) de una reunión — a lo sumo una, por el
// índice único de arriba.
async function getActiveQuestionForMeeting(meetingCode) {
  const [rows] = await pool.query(
    `SELECT q.*
     FROM questions q
     JOIN meetings m ON m.id = q.meeting_id
     WHERE m.meeting_code = ? AND q.status = 'active'
     LIMIT 1`,
    [meetingCode]
  );
  return rows[0] || null;
}

// Idempotente: `WHERE status = 'active'` hace que una segunda llamada (ej.
// el timer automático y un "finish_question" manual llegando casi a la
// vez) no afecte ninguna fila la segunda vez — `affectedRows > 0` es la
// forma en que quien llama sabe si ESTA llamada fue la que de verdad
// finalizó la pregunta (ver `ws/handlers.js`, evita un doble broadcast de
// "question_finished").
async function markQuestionFinished(id) {
  const [result] = await pool.query(
    `UPDATE questions SET status = 'finished', finished_at = NOW() WHERE id = ? AND status = 'active'`,
    [id]
  );
  return result.affectedRows > 0;
}

// Historial de preguntas YA FINALIZADAS de una reunión, con la
// distribución de respuestas por opción ya agregada en la misma consulta
// (un `LEFT JOIN` + `SUM` condicional, no N+1 queries por pregunta) — la
// usa el panel del docente, "Preguntas realizadas" (ver
// `services/questionService.getFinishedQuestionsForMeeting`). `LEFT JOIN`
// (no `JOIN`) porque una pregunta finalizada sin ninguna respuesta
// (nadie contestó a tiempo) tiene que seguir apareciendo, con contadores en
// cero, no desaparecer.
// "avgResponseTimeMs" (Reporte PDF de fin de clase, Sección 2 — "Análisis de
// preguntas") — promedio de `response_time_ms` SOLO entre respuestas
// efectivas (`skipped = 0`): un alumno que salteó no "respondió rápido", así
// que su tiempo no debe abaratar el promedio del grupo. `NULL` (vía
// `AVG` de un `CASE` que nunca matchea) si nadie respondió de verdad —
// distinto de `0`, que sería un promedio real de cero segundos.
async function getFinishedQuestionsForMeeting(meetingCode) {
  const [rows] = await pool.query(
    `SELECT
       q.id, q.prompt, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option,
       q.duration_seconds, q.created_at, q.finished_at,
       COALESCE(SUM(qa.skipped = 0), 0) AS answeredCount,
       COALESCE(SUM(qa.skipped = 1), 0) AS skippedCount,
       COALESCE(SUM(qa.selected_option = 'a' AND qa.skipped = 0), 0) AS countA,
       COALESCE(SUM(qa.selected_option = 'b' AND qa.skipped = 0), 0) AS countB,
       COALESCE(SUM(qa.selected_option = 'c' AND qa.skipped = 0), 0) AS countC,
       COALESCE(SUM(qa.selected_option = 'd' AND qa.skipped = 0), 0) AS countD,
       AVG(CASE WHEN qa.skipped = 0 THEN qa.response_time_ms END) AS avgResponseTimeMs
     FROM questions q
     JOIN meetings m ON m.id = q.meeting_id
     LEFT JOIN question_answers qa ON qa.question_id = q.id
     WHERE m.meeting_code = ? AND q.status = 'finished'
     GROUP BY q.id
     ORDER BY q.finished_at DESC`,
    [meetingCode]
  );
  return rows.map((row) => ({
    ...row,
    answeredCount: Number(row.answeredCount) || 0,
    skippedCount: Number(row.skippedCount) || 0,
    countA: Number(row.countA) || 0,
    countB: Number(row.countB) || 0,
    countC: Number(row.countC) || 0,
    countD: Number(row.countD) || 0,
    avgResponseTimeMs: row.avgResponseTimeMs != null ? Number(row.avgResponseTimeMs) : null,
  }));
}

// Enunciados de las preguntas ya generadas en esta reunión (activa O
// finalizada, cualquier estado — a diferencia de `getFinishedQuestionsForMeeting`,
// que solo trae las finalizadas para el historial del docente) — pensado
// como contexto para la generación de preguntas con IA (ver
// `providers/openAIQuestionProvider.js`), para que no repita el mismo
// tema si el docente aprieta "Generar pregunta" varias veces en la misma
// clase. `limit` acota cuántas de las MÁS RECIENTES se mandan (evita que
// una clase larga, con muchas preguntas ya hechas, infle el prompt sin
// límite) — no importa el orden en que lleguen, es una lista de
// referencia para el modelo, no algo que se muestre.
async function getRecentPromptsForMeeting(meetingCode, limit) {
  const [rows] = await pool.query(
    `SELECT q.prompt
     FROM questions q
     JOIN meetings m ON m.id = q.meeting_id
     WHERE m.meeting_code = ?
     ORDER BY q.created_at DESC
     LIMIT ?`,
    [meetingCode, limit]
  );
  return rows.map((row) => row.prompt);
}

module.exports = {
  createActiveQuestion,
  getQuestionById,
  getActiveQuestionForMeeting,
  markQuestionFinished,
  getFinishedQuestionsForMeeting,
  getRecentPromptsForMeeting,
};
