const pool = require('../db');

// Acceso a datos de la tabla `question_answers` — sin ninguna regla de
// negocio acá (ver `services/questionService.js`).

// El índice único `uq_question_answers_question_user` (ver
// `scripts/init-db.js`) es la garantía de base contra respuestas
// duplicadas — termina en `ER_DUP_ENTRY` si esta persona ya había
// respondido/saltado esta pregunta; el service lo traduce a un rechazo
// claro.
async function insertAnswer(questionId, userId, { selectedOption, isCorrect, skipped, responseTimeMs }) {
  await pool.query(
    `INSERT INTO question_answers (question_id, user_id, selected_option, is_correct, skipped, response_time_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [questionId, userId, selectedOption, isCorrect, skipped, responseTimeMs]
  );
}

async function getAnswer(questionId, userId) {
  const [rows] = await pool.query(
    'SELECT selected_option, is_correct, skipped FROM question_answers WHERE question_id = ? AND user_id = ?',
    [questionId, userId]
  );
  return rows[0] || null;
}

// Contadores agregados para el panel del docente — nunca quién respondió
// qué (ver DOCUMENTACION del feature: "no mostrar todavía quién respondió
// qué").
async function getStats(questionId) {
  const [rows] = await pool.query(
    `SELECT
       COALESCE(SUM(skipped = 0), 0) AS answeredCount,
       COALESCE(SUM(skipped = 1), 0) AS skippedCount
     FROM question_answers
     WHERE question_id = ?`,
    [questionId]
  );
  const row = rows[0] || {};
  return { answeredCount: Number(row.answeredCount) || 0, skippedCount: Number(row.skippedCount) || 0 };
}

// Distribución de respuestas POR OPCIÓN — agregada (cuántos eligieron cada
// una), nunca quién eligió qué. Se usa para las barras de progreso en vivo
// del panel del docente (`ui/QuestionCard.jsx`, vía
// `ws/handlers.js#buildQuestionStats`); distinto de `getStats` de arriba,
// que solo separa "respondió" vs. "saltó" sin desglosar por opción.
async function getOptionCounts(questionId) {
  const [rows] = await pool.query(
    `SELECT selected_option, COUNT(*) AS total
     FROM question_answers
     WHERE question_id = ? AND skipped = 0
     GROUP BY selected_option`,
    [questionId]
  );
  const counts = { a: 0, b: 0, c: 0, d: 0 };
  for (const row of rows) counts[row.selected_option] = Number(row.total);
  return counts;
}

// Historial PERSONAL de un alumno: Corrección — TODAS las preguntas ya
// FINALIZADAS de esta reunión (`q.status = 'finished'`), haya o no una
// respuesta suya — antes esto partía de `question_answers` (un `JOIN`
// normal), así que una pregunta que el alumno dejó vencer sin interactuar
// simplemente no aparecía en absoluto. Ahora se parte de `questions`
// (TODAS las finalizadas de la reunión) con un `LEFT JOIN` — primero a
// `users` por email (resuelve el `user_id` sin aceptar nunca uno crudo del
// cliente), después a `question_answers` filtrado por ESE `user_id` — así
// que las columnas `qa.*` quedan en NULL exactamente cuando no existe
// ninguna fila de respuesta suya para esa pregunta puntual; el service
// (`questionService.getStudentQuestionHistory`) usa esa ausencia para
// marcarla como "unanswered". Nunca revela la opción correcta de una
// pregunta que sigue activa (`q.status = 'finished'` la excluye de raíz) —
// mismo criterio de seguridad que ya regía acá.
async function getStudentQuestionHistory(meetingCode, email) {
  const [rows] = await pool.query(
    `SELECT
       q.id, q.prompt, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.finished_at,
       qa.selected_option, qa.is_correct, qa.skipped, qa.answered_at
     FROM questions q
     JOIN meetings m ON m.id = q.meeting_id
     LEFT JOIN users u ON u.email = ?
     LEFT JOIN question_answers qa ON qa.question_id = q.id AND qa.user_id = u.id
     WHERE m.meeting_code = ? AND q.status = 'finished'
     ORDER BY q.finished_at DESC`,
    [email, meetingCode]
  );
  return rows;
}

// Estadísticas agregadas POR ALUMNO de toda la reunión — "X/Y respuestas
// correctas" en la tab "Alumnos" del docente (ver
// `services/questionService.getStudentStatsForMeeting`). UNA sola consulta
// (nada de N+1 por alumno):
//   - se parte del PADRÓN de alumnos (`participations`, rol "student") con
//     un `LEFT JOIN questions` (solo las FINALIZADAS de esa reunión) y
//     después `LEFT JOIN question_answers` filtrado además por ese mismo
//     alumno — así cada alumno aparece con una fila por cada pregunta
//     finalizada, tenga o no una respuesta suya, y los `LEFT JOIN`
//     encadenados son los que garantizan que un alumno que nunca respondió
//     nada siga apareciendo con contadores en CERO en vez de directamente
//     no aparecer.
//   - `totalFinishedQuestions` es el mismo número para todas las filas
//     (subconsulta correlacionada por `m.id`, no depende del alumno) — se
//     pide en la misma consulta para no hacer un segundo viaje a la base.
async function getStudentStatsForMeeting(meetingCode) {
  const [rows] = await pool.query(
    `SELECT
       u.id AS studentId,
       u.email AS email,
       p.name AS name,
       COALESCE(SUM(qa.is_correct = 1), 0) AS correctAnswers,
       COALESCE(SUM(qa.skipped = 0), 0) AS answeredQuestions,
       COALESCE(SUM(qa.skipped = 1), 0) AS skippedQuestions,
       (SELECT COUNT(*) FROM questions fq WHERE fq.meeting_id = m.id AND fq.status = 'finished') AS totalFinishedQuestions
     FROM participations p
     JOIN meetings m ON m.id = p.meeting_id
     JOIN users u ON u.id = p.user_id
     LEFT JOIN questions q ON q.meeting_id = m.id AND q.status = 'finished'
     LEFT JOIN question_answers qa ON qa.question_id = q.id AND qa.user_id = u.id
     WHERE m.meeting_code = ? AND p.role = 'student'
     GROUP BY u.id, u.email, p.name, m.id`,
    [meetingCode]
  );
  return rows.map((row) => ({
    studentId: row.studentId,
    email: row.email,
    name: row.name,
    correctAnswers: Number(row.correctAnswers) || 0,
    answeredQuestions: Number(row.answeredQuestions) || 0,
    skippedQuestions: Number(row.skippedQuestions) || 0,
    totalFinishedQuestions: Number(row.totalFinishedQuestions) || 0,
  }));
}

// Reporte PDF de fin de clase, Sección 5 (análisis con IA) — detalle de
// respuesta de CADA alumno a CADA pregunta finalizada de la reunión, una
// fila por combinación. A diferencia de `getStudentStatsForMeeting` (solo
// contadores agregados) o `getOptionCounts`/`getStats` (agregados por
// pregunta, sin distinguir alumno), esto es lo único que le da al proveedor
// de IA la materia prima para armar recomendaciones PERSONALIZADAS por
// alumno — nunca se expone tal cual al PDF, solo se manda como contexto al
// modelo (ver `providers/openAIClassReportProvider.js`). Mismo patrón de
// `LEFT JOIN` encadenado que `getStudentStatsForMeeting`: un alumno que
// nunca respondió una pregunta puntual igual aparece, con las columnas de
// respuesta en NULL (en vez de faltar esa fila).
async function getDetailedAnswersForMeeting(meetingCode) {
  const [rows] = await pool.query(
    `SELECT
       q.id AS questionId,
       p.name AS studentName,
       qa.selected_option AS selectedOption,
       qa.is_correct AS isCorrect,
       qa.skipped AS skipped
     FROM questions q
     JOIN meetings m ON m.id = q.meeting_id
     JOIN participations p ON p.meeting_id = m.id AND p.role = 'student'
     LEFT JOIN question_answers qa ON qa.question_id = q.id AND qa.user_id = p.user_id
     WHERE m.meeting_code = ? AND q.status = 'finished'
     ORDER BY q.finished_at ASC, p.name ASC`,
    [meetingCode]
  );
  return rows.map((row) => ({
    questionId: row.questionId,
    studentName: row.studentName,
    selectedOption: row.selectedOption,
    isCorrect: row.isCorrect == null ? null : Boolean(row.isCorrect),
    skipped: row.skipped == null ? null : Boolean(row.skipped),
  }));
}

module.exports = {
  insertAnswer,
  getAnswer,
  getStats,
  getOptionCounts,
  getStudentQuestionHistory,
  getStudentStatsForMeeting,
  getDetailedAnswersForMeeting,
};
