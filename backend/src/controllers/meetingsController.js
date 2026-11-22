const roleService = require('../services/roleService');
const classService = require('../services/classService');
const sessionService = require('../services/sessionService');
const cameraService = require('../services/cameraService');
const questionService = require('../services/questionService');
const classSummaryService = require('../services/classSummaryService');
const recoverySummaryService = require('../services/recoverySummaryService');
const finalQuizService = require('../services/finalQuizService');
const attentionSnapshotService = require('../services/attentionSnapshotService');
const classReportService = require('../services/classReportService');

const VALID_ROLES = ['teacher', 'student'];

// Capa de controladores: valida la FORMA de lo que llegó (faltan params,
// tipo incorrecto), delega la operación real en el service que corresponde,
// y traduce el resultado a una respuesta HTTP. Ninguna función acá abajo
// hace una query SQL ni conoce una regla de negocio — si un service lanza
// un error con `.status` (ver `services/*.js`), ese código y ese mensaje
// son los que se usan tal cual; si no tiene `.status`, es un error
// inesperado y cae al 500 genérico de ese endpoint.

function missingParameter(name, source) {
  return { error: `Falta el parámetro "${name}" en ${source === 'query' ? 'la query string' : 'el body de la request'}.` };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

async function registerRole(req, res) {
  const { meetingCode, email, role } = req.body || {};

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'body'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'body'));
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'El parámetro "role" debe ser "teacher" o "student".' });
  }

  try {
    const result = await roleService.registerRole({ meetingCode, email, role });
    return res.status(200).json({ message: 'Rol registrado correctamente.', ...result });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message, role: null });
    return res.status(500).json({ error: 'Error interno registrando el rol.' });
  }
}

async function getHasTeacher(req, res) {
  const { meetingCode, email } = req.query;

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'query'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    // `otherTeacherExists` espera el meetingCode YA normalizado (ver
    // `services/roleService.js`) — el email lo normaliza internamente.
    const hasTeacher = await roleService.otherTeacherExists(meetingCode.trim().toLowerCase(), email);
    return res.status(200).json({ hasTeacher });
  } catch (err) {
    console.error('[Sparkle] Error consultando si ya hay un docente:', err.message);
    return res.status(500).json({ error: 'Error interno consultando si ya hay un docente.' });
  }
}

async function getRole(req, res) {
  const { meetingCode, email } = req.query;

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'query'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const result = await roleService.getRole(meetingCode, email);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[Sparkle] Error consultando rol de reunión:', err.message);
    return res.status(500).json({ error: 'Error interno consultando el rol.' });
  }
}

async function registerStudent(req, res) {
  const { meetingCode, email, name } = req.body || {};

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'body'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'body'));

  try {
    const result = await roleService.registerStudent({ meetingCode, email, name });
    return res.status(200).json({ message: 'Alumno registrado correctamente.', ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: 'Error interno registrando el alumno.' });
  }
}

async function getHistory(req, res) {
  const { meetingCode } = req.query;

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'query'));

  try {
    const students = await sessionService.getHistoryByMeeting(meetingCode);
    return res.status(200).json({ students });
  } catch (err) {
    console.error('[Sparkle] Error consultando historial de conexiones:', err.message);
    return res.status(500).json({ error: 'Error interno consultando el historial.' });
  }
}

async function updateCamera(req, res) {
  const { meetingCode, email, enabled } = req.body || {};

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'body'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'body'));
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El parámetro "enabled" debe ser un booleano.' });
  }

  try {
    const result = await cameraService.updatePreference(meetingCode, email, enabled);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error guardando preferencia de cámara:', err.message);
    return res.status(500).json({ error: 'Error interno guardando la preferencia de cámara.' });
  }
}

async function getCamera(req, res) {
  const { meetingCode, email } = req.query;

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'query'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const result = await cameraService.getPreference(meetingCode, email);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[Sparkle] Error consultando preferencia de cámara:', err.message);
    return res.status(500).json({ error: 'Error interno consultando la preferencia de cámara.' });
  }
}

// Vista previa de una pregunta generada (Etapa de preguntas en tiempo real)
// — sin persistencia: el docente puede pedir varias antes de decidir cuál
// enviar ("Generar otra pregunta" en `GenerateQuestion.jsx`); nada de esto
// toca la base todavía — eso ocurre recién por WS, al "Enviar pregunta" de
// verdad (ver `ws/handlers.js`, `handleSendQuestion`).
//
// `meetingCode`/`email` SÍ hacen falta ahora (antes este endpoint era
// agnóstico de la reunión, cuando el único proveedor era
// `RandomQuestionProvider`) — con `ENABLE_AI_QUESTION_GENERATION` activo,
// `questionService.generatePreview` arma el contexto a partir de datos
// PRIVADOS de la reunión (resumen del documento, transcripción), así que
// valida que quien pide sea el docente de esa reunión (403 si no, ver ese
// archivo) — mismo criterio que `getQuestionsHistory`, justo abajo.
//
// POST, no GET (ver `routes/meetings.js`) — `discardedPrompts` (opcional)
// es un array de texto arbitrario, no encaja en query string. Se sanea
// del lado del service (`questionService.js`, nunca se confía en la forma
// de algo que manda el cliente), acá solo se pasa tal cual.
async function generateQuestion(req, res) {
  const { meetingCode, email, discardedPrompts } = req.body || {};

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'body'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'body'));

  try {
    const question = await questionService.generatePreview(meetingCode, email, discardedPrompts);
    return res.status(200).json(question);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error generando una pregunta:', err.message);
    return res.status(500).json({ error: 'Error interno generando la pregunta.' });
  }
}

// Historial de preguntas FINALIZADAS de una reunión — "Preguntas
// realizadas" del panel del docente. La autorización ("¿es de verdad el
// docente de esta reunión?") vive en `questionService.
// getFinishedQuestionsForMeeting` (err.status === 403 si no lo es) — este
// controller solo valida la FORMA del request y traduce el resultado.
async function getQuestionsHistory(req, res) {
  const { meetingCode, email } = req.query;

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'query'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const questions = await questionService.getFinishedQuestionsForMeeting(meetingCode, email);
    return res.status(200).json({ questions });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error consultando el historial de preguntas:', err.message);
    return res.status(500).json({ error: 'Error interno consultando el historial de preguntas.' });
  }
}

// Historial PERSONAL de un alumno — "Preguntas respondidas" del panel del
// alumno. Corrección: trae TODAS las preguntas finalizadas de la reunión
// (respondidas, saltadas o nunca respondidas — ver
// `questionService.getStudentQuestionHistory`), cada una con su `status`
// ('correct'/'incorrect'/'skipped'/'unanswered') ya resuelto server-side.
// `email` es la única identidad que se acepta (nunca un id crudo) — eso ya
// alcanza para que nadie pueda leer el historial de otra persona.
async function getMyQuestionAnswers(req, res) {
  const { meetingCode, email } = req.query;

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'query'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const answers = await questionService.getStudentQuestionHistory(meetingCode, email);
    return res.status(200).json({ answers });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error consultando las respuestas del alumno:', err.message);
    return res.status(500).json({ error: 'Error interno consultando las respuestas.' });
  }
}

// Estadísticas agregadas POR ALUMNO ("X/Y respuestas correctas" en la tab
// "Alumnos") — SOLO para el docente de esa reunión (ver
// `questionService.getStudentStatsForMeeting`, err.status === 403 si no lo
// es). Nunca expone la opción elegida por cada alumno, solo contadores.
async function getStudentStats(req, res) {
  const { meetingCode, email } = req.query;

  if (!isNonEmptyString(meetingCode)) return res.status(400).json(missingParameter('meetingCode', 'query'));
  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const students = await questionService.getStudentStatsForMeeting(meetingCode, email);
    return res.status(200).json({ students });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error consultando estadísticas por alumno:', err.message);
    return res.status(500).json({ error: 'Error interno consultando estadísticas por alumno.' });
  }
}

// "Obtener resumen de la clase" (alumno) — botón de `ClassSummary.jsx`,
// visible recién cuando el alumno ve la clase detenida. La autorización
// (¿es alumno o docente de esta reunión? ¿ya terminó la clase?) vive
// entera en `classSummaryService.getClassSummary` — este controller solo
// valida la FORMA del request y traduce el resultado. `meetingCode` viaja
// por la URL (mismo patrón que `/:meetingCode/documents`), `email` por
// query string.
async function getClassSummary(req, res) {
  const { meetingCode } = req.params;
  const { email } = req.query;

  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const summary = await classSummaryService.getClassSummary(meetingCode, email);
    return res.status(200).json(summary);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error generando el resumen de la clase:', err.message);
    return res.status(500).json({ error: 'Error interno generando el resumen de la clase.' });
  }
}

// "Recuperar contenido" (alumno, botón de `ui/FatigueAlert.jsx`) — mismo
// patrón que `getClassSummary` de arriba: `meetingCode` por la URL,
// `email` por query string, autorización/lógica entera en
// `services/recoverySummaryService.js`. A diferencia del resumen final, no
// exige que la clase haya terminado — tiene sentido pedirlo justo A MITAD
// de una clase en curso, que es el caso de uso real.
async function getRecoverySummary(req, res) {
  const { meetingCode } = req.params;
  const { email } = req.query;

  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const summary = await recoverySummaryService.getRecoverySummary(meetingCode, email);
    return res.status(200).json(summary);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error generando el resumen de recuperación:', err.message);
    return res.status(500).json({ error: 'Error interno generando el resumen de recuperación.' });
  }
}

// "Quiz final" (alumno) — mismo patrón que `getRecoverySummary` de arriba;
// autorización, estado de la clase y flag de IA viven en
// `services/finalQuizService.js`.
async function getFinalQuiz(req, res) {
  const { meetingCode } = req.params;
  const { email } = req.query;

  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const quiz = await finalQuizService.getFinalQuiz(meetingCode, email);
    return res.status(200).json(quiz);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error generando el quiz final:', err.message);
    return res.status(500).json({ error: 'Error interno generando el quiz final.' });
  }
}

// Historial de "fotos" periódicas del estado grupal de atención
// (`ConcentrationStats.jsx`, docente) — mismo patrón que `getRecoverySummary`
// de arriba: `meetingCode` por la URL, `email` por query string,
// autorización/lógica entera en `services/attentionSnapshotService.js`
// (solo el docente de la reunión puede verlo).
async function getAttentionSnapshots(req, res) {
  const { meetingCode } = req.params;
  const { email } = req.query;

  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const { snapshots, windowStartedAt } = await attentionSnapshotService.getAttentionSnapshots(meetingCode, email);
    return res.status(200).json({ snapshots, windowStartedAt });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error consultando el historial de atención grupal:', err.message);
    return res.status(500).json({ error: 'Error interno consultando el historial de atención grupal.' });
  }
}

// Análisis con IA del reporte PDF de fin de clase (docente, Sección 5 del
// reporte) — mismo patrón que `getAttentionSnapshots`/`getRecoverySummary`:
// `meetingCode` por la URL, `email` por query string, autorización/lógica
// entera en `services/classReportService.js` (solo el docente de la
// reunión puede pedirlo). Con `ENABLE_AI_CLASS_REPORT` apagado, el service
// devuelve `aiAnalysisAvailable: false` con status 200 (nunca un error) —
// el resto del reporte se arma igual, solo esa sección queda marcada como
// no disponible.
async function getClassReportAnalysis(req, res) {
  const { meetingCode } = req.params;
  const { email } = req.query;

  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const analysis = await classReportService.getAIAnalysis(meetingCode, email);
    return res.status(200).json(analysis);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error generando el análisis del reporte de clase:', err.message);
    return res.status(500).json({ error: 'Error interno generando el análisis del reporte de clase.' });
  }
}

// Temas abordados según el DOCUMENTO cargado por el docente (reporte PDF de
// fin de clase, sección "Resumen de la clase") — mismo patrón que
// `getClassReportAnalysis` de arriba. `topics` viaja vacío (nunca un error)
// si no hay documento, no se analizó, o no identificó temas — ver
// `services/classReportService.getDocumentTopics`.
async function getReportDocumentTopics(req, res) {
  const { meetingCode } = req.params;
  const { email } = req.query;

  if (!isNonEmptyString(email)) return res.status(400).json(missingParameter('email', 'query'));

  try {
    const result = await classReportService.getDocumentTopics(meetingCode, email);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error consultando los temas del documento para el reporte:', err.message);
    return res.status(500).json({ error: 'Error interno consultando los temas del documento.' });
  }
}

module.exports = {
  registerRole,
  getHasTeacher,
  getRole,
  registerStudent,
  getHistory,
  updateCamera,
  getCamera,
  generateQuestion,
  getQuestionsHistory,
  getMyQuestionAnswers,
  getStudentStats,
  getClassSummary,
  getRecoverySummary,
  getFinalQuiz,
  getAttentionSnapshots,
  getClassReportAnalysis,
  getReportDocumentTopics,
};
