const meetingRepository = require('../repositories/meetingRepository');
const transcriptRepository = require('../repositories/transcriptRepository');
const questionAnswerRepository = require('../repositories/questionAnswerRepository');
const connectionSessionRepository = require('../repositories/connectionSessionRepository');
const roleService = require('./roleService');
const classService = require('./classService');
const documentAnalysisService = require('./documentAnalysisService');
const { openAIFinalQuizProvider } = require('../providers');

// "Quiz final" del alumno — botón al lado de "Obtener resumen de la clase",
// con la clase detenida. 3 preguntas (opción múltiple o verdadero/falso)
// generadas con IA y PERSONALES de cada alumno.
//
// Decisiones de producto (ver DOCUMENTACION.md, Etapa 80):
//   - NO se persiste nada — ni el quiz ni las respuestas. No hay tabla nueva:
//     cada pedido genera un quiz nuevo, y la corrección la hace el frontend
//     con `correctOptionIndex`, que viaja en la respuesta (no hay nada que
//     proteger: el resultado no se guarda ni lo ve nadie más).
//   - Solo para alumnos. El docente nunca lo ve (403).
//   - Sin caché: a diferencia del resumen de clase (uno por reunión), acá
//     cada alumno pide el suyo.
//
// La personalización sale de datos que YA están en la base, sin tocar el
// esquema:
//   1. Cómo le fue en las preguntas de la clase (`question_answers`).
//   2. Qué se explicó mientras NO estaba conectado (`connection_sessions`
//      cruzado con `transcript_segments`, ver el aviso de reloj en
//      `connectionSessionRepository.getStudentSessionsInTranscriptClock`).
//   3. La transcripción y el material de la clase, comunes a todos.
// La atención individual NO se usa: en la base solo queda la del grupo
// (`attention_snapshots`).

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Topes de caracteres para no inflar el prompt (y el costo) en una clase
// larga. Constantes y no variables de entorno a propósito: el quiz no suma
// configuración nueva al despliegue.
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_MISSED_CHARS = 4000;
// Solo se usa si el documento se procesó SIN resumen con IA
// (`ENABLE_AI_DOCUMENT_ANALYSIS` apagado al cargarlo): sin temas ni
// conceptos, el texto crudo es lo único que hay del material. A diferencia
// de las preguntas en vivo (que nunca mandan `extractedText` porque corren en
// cada click), el quiz es una llamada por alumno, así que el costo es acotado.
const MAX_DOCUMENT_EXCERPT_CHARS = 8000;
// Por debajo de esto la transcripción no alcanza sola para armar preguntas;
// igual se genera si el material tiene temas o conceptos.
const MIN_TRANSCRIPT_CHARS = 200;

function totalChars(segments) {
  return segments.reduce((sum, segment) => sum + (segment.text ? segment.text.length : 0), 0);
}

// Si la transcripción se pasa del tope, se toma uno de cada N segmentos en
// vez de cortar el final: el quiz es sobre TODA la clase, no sobre el
// principio.
function fitToChars(segments, maxChars) {
  const chars = totalChars(segments);
  if (chars <= maxChars) return segments;
  const stride = Math.ceil(chars / maxChars);
  return segments.filter((_, index) => index % stride === 0);
}

// Un segmento sin hora no se puede ubicar — se lo cuenta como "estaba", para
// no inventarle al alumno una ausencia que no se sabe si existió.
function wasConnectedAt(time, sessions) {
  if (!time) return true;
  const t = new Date(time).getTime();
  return sessions.some((s) => t >= new Date(s.from).getTime() && t <= new Date(s.to).getTime());
}

// Mismo criterio que `classSummaryService.classifyRow`.
function classifyRow(row) {
  if (row.answered_at == null) return 'unanswered';
  if (row.skipped) return 'skipped';
  return row.is_correct ? 'correct' : 'incorrect';
}

// Todo lo que se le manda al proveedor, en la forma que espera
// `openAIFinalQuizProvider.buildUserMessage`. Exportada para los tests.
async function buildQuizContext(meetingId, meetingCode, email) {
  const [summary, segments, historyRows, sessions] = await Promise.all([
    documentAnalysisService.getAnalysisSummary(meetingId),
    transcriptRepository.getAllSegments(meetingCode),
    questionAnswerRepository.getStudentQuestionHistory(meetingCode, email),
    connectionSessionRepository.getStudentSessionsInTranscriptClock(meetingCode, email),
  ]);

  // `getStudentQuestionHistory` viene de la más nueva a la más vieja; al
  // modelo se le pasa en el orden en que se hicieron.
  const classQuestions = [...historyRows].reverse().map((row) => ({
    prompt: row.prompt,
    correctAnswer: row[`option_${row.correct_option}`],
    outcome: classifyRow(row),
  }));

  // Si no se perdió nada, o no estuvo nunca (todo "perdido"), la sección
  // aparte no aporta: en el segundo caso la transcripción completa ya es
  // todo lo que se perdió.
  let missedSegments = segments.filter((segment) => !wasConnectedAt(segment.absolute_start_time, sessions));
  if (missedSegments.length === segments.length) missedSegments = [];

  const mainTopics = summary?.mainTopics ?? [];
  const keyConcepts = summary?.keyConcepts ?? [];
  const documentExcerpt =
    mainTopics.length === 0 && keyConcepts.length === 0 && typeof summary?.extractedText === 'string'
      ? summary.extractedText.slice(0, MAX_DOCUMENT_EXCERPT_CHARS).trim()
      : '';

  return {
    mainTopics,
    keyConcepts,
    documentExcerpt,
    classQuestions,
    missedSegments: fitToChars(missedSegments, MAX_MISSED_CHARS),
    transcriptSegments: fitToChars(segments, MAX_TRANSCRIPT_CHARS),
    transcriptChars: totalChars(segments),
  };
}

function unavailable(reason) {
  return { quizAvailable: false, unavailableReason: reason, questions: null };
}

async function getFinalQuiz(meetingCode, email) {
  const { role } = await roleService.getRole(meetingCode, email);
  if (role !== 'student') {
    throw httpError(403, 'El quiz final es solo para los alumnos de esta clase.');
  }

  const state = await classService.getClassState(meetingCode);
  if (!state) throw httpError(404, 'La reunión no existe.');
  if (state.active) {
    throw httpError(409, 'La clase todavía está en curso — el quiz está disponible cuando se detenga.');
  }

  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const meetingId = await meetingRepository.getMeetingIdByCode(normalizedMeetingCode);
  if (!meetingId) throw httpError(404, 'La reunión no existe.');

  // Mismo flag que las preguntas en vivo, leído a CALL-TIME: quien apaga la
  // generación de preguntas con IA apaga también el quiz. Apagado no es un
  // error, es un estado neutral (mismo criterio que `ClassSummary.jsx`).
  if (process.env.ENABLE_AI_QUESTION_GENERATION !== 'true') return unavailable('ai_disabled');

  const { transcriptChars, ...context } = await buildQuizContext(meetingId, normalizedMeetingCode, email);

  const hasDocument = context.mainTopics.length > 0 || context.keyConcepts.length > 0 || context.documentExcerpt.length > 0;
  if (transcriptChars < MIN_TRANSCRIPT_CHARS && !hasDocument) return unavailable('insufficient_content');

  console.log(
    `[Sparkle][IA] Quiz final — reunión "${normalizedMeetingCode}": ${context.classQuestions.length} pregunta(s) de la clase, ` +
      `${context.missedSegments.length} segmento(s) mientras el alumno no estaba, ${transcriptChars} caracter(es) de transcripción.`
  );

  let questions;
  try {
    questions = await openAIFinalQuizProvider.generateQuiz(context);
  } catch (err) {
    // El proveedor ya tradujo el error a un texto mostrable. 502: falló un
    // servicio de afuera, y acá "Reintentar" sí puede funcionar.
    throw httpError(502, err.message);
  }

  return { quizAvailable: true, unavailableReason: null, questions };
}

module.exports = { getFinalQuiz, buildQuizContext };
