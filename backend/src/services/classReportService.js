const meetingRepository = require('../repositories/meetingRepository');
const questionAnswerRepository = require('../repositories/questionAnswerRepository');
const roleService = require('./roleService');
const questionService = require('./questionService');
const classReportCache = require('./classReportCache');
const documentAnalysisService = require('./documentAnalysisService');
const { openAIClassReportProvider } = require('../providers');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Arma la promesa que resuelve el análisis con IA — SIN cachear acá adentro
// (mismo criterio que `classSummaryService.buildCommonSummary`): quien
// llama (`getCachedAnalysis`) es quien decide cachear la promesa que ESTA
// función devuelve, antes de que resuelva.
async function buildAnalysis(meetingCode, email) {
  // Reusa `questionService.getFinishedQuestionsForMeeting` — ya hace la
  // validación de rol docente y devuelve exactamente la forma que necesita
  // el proveedor (`optionDistribution` con el conteo por opción, de donde
  // sale el "distractor más engañoso" sin que el modelo tenga que
  // calcularlo).
  const questions = await questionService.getFinishedQuestionsForMeeting(meetingCode, email);
  const studentAnswers = await questionAnswerRepository.getDetailedAnswersForMeeting(
    meetingCode.trim().toLowerCase()
  );

  return openAIClassReportProvider.analyze({ questions, studentAnswers });
}

// Lectura CACHEADA (con deduplicación de llamadas concurrentes) del
// análisis — mismo patrón que `classSummaryService.getCommonSummary`.
function getCachedAnalysis(meetingId, meetingCode, email) {
  const cached = classReportCache.get(meetingId);
  if (cached) return cached;

  const pending = buildAnalysis(meetingCode, email);
  classReportCache.set(meetingId, pending);
  // Si la generación falla, no queda una promesa RECHAZADA cacheada para
  // siempre — se saca del Map para que el próximo pedido dispare un
  // intento fresco.
  pending.catch(() => classReportCache.invalidate(meetingId));

  return pending;
}

// Punto de entrada — "Descargar reporte" (docente), Sección 5 del PDF.
// Autorización: solo el DOCENTE de esta reunión (a diferencia del resumen
// de clase, acá no hay una versión para el alumno) — reusa
// `roleService.getRole`, mismo criterio que `attentionSnapshotService`.
//
// A diferencia de `classSummaryService.getClassSummary`, NO exige que la
// clase esté detenida: el botón que dispara esto solo aparece con la clase
// ya terminada (ver `hooks/useLiveClass.js`, `reportAvailable`), así que
// esa validación ya la hace la UI — no hay necesidad de duplicarla acá
// (a diferencia del resumen del alumno, que si puede pedirse por otras vías
// mientras la clase sigue en curso).
async function getAIAnalysis(meetingCode, email) {
  const { role } = await roleService.getRole(meetingCode, email);
  if (role !== 'teacher') {
    throw httpError(403, 'Solo el docente de esta reunión puede generar este análisis.');
  }

  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const meetingId = await meetingRepository.getMeetingIdByCode(normalizedMeetingCode);
  if (!meetingId) throw httpError(404, 'La reunión no existe.');

  // Se lee ACÁ, a CALL-TIME — mismo criterio que el resto de los flags de
  // IA de esta app: permite prender/apagar sin reiniciar el proceso.
  const aiEnabled = process.env.ENABLE_AI_CLASS_REPORT === 'true';
  if (!aiEnabled) {
    return {
      aiAnalysisAvailable: false,
      reason: 'ai_disabled',
      strengths: null,
      weaknesses: null,
      questionDiagnostics: null,
      studentRecommendations: null,
      suggestedTopics: null,
    };
  }

  let analysis;
  try {
    analysis = await getCachedAnalysis(meetingId, normalizedMeetingCode, email);
  } catch (err) {
    // Mismo criterio que `classSummaryService.getClassSummary`: `err.message`
    // ya es un texto seguro para mostrar tal cual, 502 porque el fallo es
    // de un servicio upstream (OpenAI), no un bug de este backend.
    throw httpError(502, err.message);
  }

  return {
    aiAnalysisAvailable: true,
    reason: null,
    strengths: analysis.strengths,
    weaknesses: analysis.weaknesses,
    questionDiagnostics: analysis.questionDiagnostics,
    studentRecommendations: analysis.studentRecommendations,
    suggestedTopics: analysis.suggestedTopics,
  };
}

// "Temas abordados" (Resumen de la clase, portada del reporte) — sale del
// análisis con IA del DOCUMENTO que el docente cargó para esta reunión
// (`files.analysis_result.mainTopics`, ver
// `providers/openAIDocumentAnalysisProvider.js`), no de las preguntas en
// vivo: es la fuente más fiel a "de qué se trató la clase" cuando existe.
// Reusa `documentAnalysisService.getAnalysisSummary` — la MISMA función
// (con su MISMA caché en memoria) que ya usa `classSummaryService.
// buildCommonSummary` para el resumen de clase del alumno, así que no hay
// una segunda llamada real si ya se había pedido antes para esta reunión.
// `topics` viaja vacío (nunca un error) en cualquiera de estos casos —
// quien llama (`utils/generateClassReport.js`, frontend) decide caer de
// vuelta a los enunciados de las preguntas cuando esto no trae nada:
//   - no se cargó ningún documento para esta reunión,
//   - se cargó pero el análisis con IA nunca corrió (`ENABLE_AI_DOCUMENT_ANALYSIS`
//     apagado) o todavía no terminó,
//   - o terminó pero sin identificar ningún tema (`mainTopics` vacío).
async function getDocumentTopics(meetingCode, email) {
  const { role } = await roleService.getRole(meetingCode, email);
  if (role !== 'teacher') {
    throw httpError(403, 'Solo el docente de esta reunión puede consultar los temas del material.');
  }

  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const meetingId = await meetingRepository.getMeetingIdByCode(normalizedMeetingCode);
  if (!meetingId) throw httpError(404, 'La reunión no existe.');

  const summary = await documentAnalysisService.getAnalysisSummary(meetingId);
  const topics = Array.isArray(summary?.mainTopics) ? summary.mainTopics : [];

  return { topics };
}

module.exports = { getAIAnalysis, getDocumentTopics };
