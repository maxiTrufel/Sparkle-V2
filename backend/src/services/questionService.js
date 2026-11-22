const questionRepository = require('../repositories/questionRepository');
const questionAnswerRepository = require('../repositories/questionAnswerRepository');
const userRepository = require('../repositories/userRepository');
const participationRepository = require('../repositories/participationRepository');
const meetingRepository = require('../repositories/meetingRepository');
const transcriptRepository = require('../repositories/transcriptRepository');
const roleService = require('./roleService');
const classService = require('./classService');
const documentAnalysisService = require('./documentAnalysisService');
const { randomQuestionProvider, openAIQuestionProvider } = require('../providers');

// Reglas de negocio de las preguntas en vivo estilo Kahoot — mismo criterio
// que `classService.js`: la identidad del que llama (¿es el docente de esta
// reunión? ¿es alumno de ella?) se valida en `ws/handlers.js` (rol del
// socket + `roleService.otherTeacherExists`, mismo patrón que ya usan
// `start_class`/`end_class`) antes de llegar acá — este archivo asume que
// quien invoca cada función ya pasó ese primer filtro, y se concentra en
// las reglas propias de la pregunta en sí (validación de campos, vigencia,
// duplicados).

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const OPTION_LETTERS = ['a', 'b', 'c', 'd'];
// Corrección — únicas duraciones que el docente puede elegir (ver
// `TIME_PRESETS` en `frontend/src/screens/GenerateQuestion.jsx`, la ÚNICA
// fuente de este mismo listado del lado del cliente — se eliminó el campo
// de duración a medida que existía antes). Esta es la validación
// AUTORITATIVA: nunca se acepta otro valor, aunque se manipule el mensaje
// WS a mano (antes se aceptaba cualquier entero entre 3 y 600 segundos).
const ALLOWED_DURATION_SECONDS = [15, 30, 45, 60];
// Default cuando la IA no sugiere una duración válida (ver
// `generatePreview` y `suggestedDurationSeconds`, más abajo) — mismo
// valor que `DEFAULT_SECONDS` en `GenerateQuestion.jsx`.
const DEFAULT_DURATION_SECONDS = 30;
const MAX_PROMPT_LENGTH = 2000;
const MAX_OPTION_LENGTH = 500;

// Cuántos de los últimos enunciados YA generados en la reunión se le
// pasan al proveedor de IA como referencia para no repetir tema (ver
// `providers/openAIQuestionProvider.js`) — a diferencia de
// `AI_QUESTION_TRANSCRIPT_FRAGMENTS` (configurable por env, ver más
// abajo), este número no se expuso como variable de entorno: una clase
// normal no llega a generar tantas preguntas como para que el límite
// importe en la práctica, es solo un tope defensivo contra una clase
// excepcionalmente larga.
const PREVIOUS_PROMPTS_LIMIT = 20;
const DEFAULT_TRANSCRIPT_FRAGMENTS = 40;
// Tope defensivo sobre `discardedPrompts` (ver `generatePreview`, más
// abajo) — son enunciados que el CLIENTE manda (los previews que generó y
// descartó en la tanda actual, sin enviar ninguno todavía), a diferencia
// de `previousPrompts` (leídos de la base, bajo control propio). Mismo
// límite que `PREVIOUS_PROMPTS_LIMIT` — ninguna razón para tratarlos
// distinto, ambos terminan en la misma lista "no repitas" del prompt.
const DISCARDED_PROMPTS_LIMIT = 20;

// Sanea `discardedPrompts` — dato que viene del CLIENTE (a diferencia de
// `previousPrompts`, leído de la base): nunca se confía en su forma sin
// chequear. Filtra cualquier cosa que no sea un string no vacío dentro de
// un largo razonable (mismo `MAX_PROMPT_LENGTH` que un enunciado real,
// ver `validateQuestionInput`) y se queda con los últimos
// `DISCARDED_PROMPTS_LIMIT` — un array gigante o con basura no debería
// poder inflar el prompt que se manda a OpenAI.
function sanitizeDiscardedPrompts(discardedPrompts) {
  if (!Array.isArray(discardedPrompts)) return [];
  return discardedPrompts.filter((p) => typeof p === 'string' && p.trim().length > 0 && p.length <= MAX_PROMPT_LENGTH).slice(-DISCARDED_PROMPTS_LIMIT);
}

// Vista previa SIN persistir — el docente puede pedir varias antes de
// decidir cuál enviar ("Generar otra pregunta"); no toca la base hasta que
// de verdad se envía (`createAndStartQuestion`).
//
// Requiere `email` (a diferencia de antes: este endpoint no validaba nada)
// porque, con el flag de IA activo, arma el contexto a partir de datos
// PRIVADOS de la reunión (resumen del documento, transcripción) — sin este
// chequeo, cualquiera que supiera/adivinara un `meetingCode` podría
// filtrarse esos datos vía una preview de pregunta. Mismo criterio que
// `getFinishedQuestionsForMeeting`, más abajo.
//
// Con el flag apagado (default), sigue exactamente el camino de antes:
// `RandomQuestionProvider` ignora la reunión por completo, elige de un
// banco fijo. Con el flag activo, arma el contexto (temas/conceptos del
// resumen YA cacheado — nunca `extractedText`, para no inflar el prompt
// en cada pulsación del botón —, los últimos fragmentos de transcripción,
// y los enunciados a evitar) y se lo pasa a `OpenAIQuestionProvider`. El
// flag se lee ACÁ, a CALL-TIME (no una vez al cargar `providers/index.js`),
// para poder prenderlo/apagarlo sin reiniciar el proceso.
//
// `discardedPrompts` (nuevo) — los enunciados de los previews que el
// docente ya vio y descartó EN ESTA MISMA TANDA, sin llegar a enviar
// ninguno (`GenerateQuestion.jsx` los acumula del lado del cliente y los
// limpia apenas se envía una pregunta de verdad). Sin esto,
// `questionRepository.getRecentPromptsForMeeting` (que solo ve preguntas
// YA ENVIADAS) no tiene forma de saber que "Generar otra pregunta" ya
// mostró tres veces casi la misma — el contexto le llegaba a OpenAI
// idéntico cada vez, y el modelo convergía en el mismo tema.
async function generatePreview(meetingCode, email, discardedPrompts) {
  const { role } = await roleService.getRole(meetingCode, email);
  if (role !== 'teacher') {
    throw httpError(403, 'Solo el docente de esta clase puede generar preguntas.');
  }

  const aiEnabled = process.env.ENABLE_AI_QUESTION_GENERATION === 'true';
  if (!aiEnabled) {
    return randomQuestionProvider.generateQuestion();
  }

  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const meetingId = await meetingRepository.getMeetingIdByCode(normalizedMeetingCode);
  if (!meetingId) {
    throw httpError(404, 'La reunión no existe.');
  }

  const transcriptFragments = Number.parseInt(process.env.AI_QUESTION_TRANSCRIPT_FRAGMENTS, 10) || DEFAULT_TRANSCRIPT_FRAGMENTS;

  // En paralelo — las tres lecturas son independientes entre sí (resumen
  // cacheado, transcripción indexada, preguntas previas), no hay ningún
  // motivo para esperarlas en serie.
  const [summary, transcriptSegments, sentPrompts] = await Promise.all([
    documentAnalysisService.getAnalysisSummary(meetingId),
    transcriptRepository.getRecentSegments(normalizedMeetingCode, transcriptFragments),
    questionRepository.getRecentPromptsForMeeting(normalizedMeetingCode, PREVIOUS_PROMPTS_LIMIT),
  ]);

  try {
    const result = await openAIQuestionProvider.generateQuestion({
      mainTopics: summary?.mainTopics ?? [],
      keyConcepts: summary?.keyConcepts ?? [],
      transcriptSegments,
      previousPrompts: [...sentPrompts, ...sanitizeDiscardedPrompts(discardedPrompts)],
    });

    // `suggestedDurationSeconds` es una RECOMENDACIÓN del modelo, nunca un
    // valor de confianza ciega — si no vino, o vino algo que no es uno de
    // los presets reales (ej. el modelo devolvió 25, o no devolvió nada),
    // cae al default sin romper la respuesta entera por eso: es una ayuda
    // para preseleccionar un chip en la UI, el docente igual puede
    // cambiarlo.
    const suggestedDurationSeconds = ALLOWED_DURATION_SECONDS.includes(result.suggestedDurationSeconds)
      ? result.suggestedDurationSeconds
      : DEFAULT_DURATION_SECONDS;

    return {
      prompt: result.prompt,
      options: result.options,
      correctOptionIndex: result.correctOptionIndex,
      suggestedDurationSeconds,
    };
  } catch (err) {
    // `err.message` YA es un mensaje seguro para mostrar tal cual (el
    // provider traduce cualquier error crudo del SDK antes de tirarlo,
    // ver `openAIQuestionProvider.js`) — sin este `httpError(502, ...)`,
    // el `catch` genérico del controller (`if (err.status) ... else 500
    // con un mensaje fijo`) LO DESCARTABA por completo, dejando al
    // docente con "Error interno generando la pregunta." en vez del
    // motivo real ("reintentá en unos segundos"). 502 (Bad Gateway, no
    // 500): el fallo es de un servicio upstream (OpenAI), no un bug de
    // este backend.
    throw httpError(502, err.message);
  }
}

function validateQuestionInput({ prompt, options, correctOptionIndex, durationSeconds }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw httpError(400, 'Falta el enunciado de la pregunta.');
  if (prompt.trim().length > MAX_PROMPT_LENGTH) throw httpError(400, 'El enunciado es demasiado largo.');

  if (!Array.isArray(options) || options.length !== 4 || options.some((o) => typeof o !== 'string' || !o.trim())) {
    throw httpError(400, 'Hacen falta exactamente 4 opciones, ninguna vacía.');
  }
  if (options.some((o) => o.trim().length > MAX_OPTION_LENGTH)) {
    throw httpError(400, 'Una de las opciones es demasiado larga.');
  }

  if (!Number.isInteger(correctOptionIndex) || correctOptionIndex < 0 || correctOptionIndex > 3) {
    throw httpError(400, 'Falta indicar cuál es la opción correcta.');
  }

  if (!ALLOWED_DURATION_SECONDS.includes(durationSeconds)) {
    throw httpError(
      400,
      `El tiempo para responder debe ser uno de estos valores: ${ALLOWED_DURATION_SECONDS.join(', ')} segundos.`
    );
  }
}

// Persiste y "arranca" la pregunta. El índice único
// `uq_questions_one_active_per_meeting` (ver `scripts/init-db.js`) es la
// garantía DE BASE, no solo de este service, contra dos preguntas activas
// a la vez en la misma clase — cubre un doble click en "Enviar pregunta",
// dos pestañas del docente, o una carrera genuina: cualquier intento de
// crear una segunda mientras la primera sigue activa termina en
// `ER_DUP_ENTRY`, que acá se traduce a un 409 claro.
//
// Corrección — solo se puede generar/enviar una pregunta con la clase EN
// CURSO (`meetings.active`). Antes esta función no validaba el estado de la
// clase a propósito (el docente podía "preparar" una pregunta con la clase
// detenida) — ahora se rechaza de una, sin persistir nada: no existe ningún
// mecanismo de "pregunta pendiente" que se dispare sola al reanudar, así
// que rechazar acá (en vez de aceptar y guardarla para después) es
// exactamente lo que corresponde. Esta es la validación AUTORITATIVA — la
// UI (`TeacherPanel.jsx`) ya deshabilita el botón para el caso común, pero
// esto cubre igual cualquier otro camino (WS a mano, una carrera con
// "Detener Clase" a mitad de camino).
async function createAndStartQuestion(meetingCode, payload) {
  const state = await classService.getClassState(meetingCode);
  if (!state || !state.active) {
    throw Object.assign(httpError(409, 'La clase no está en curso.'), { reason: 'class_not_active' });
  }

  validateQuestionInput(payload);
  const { prompt, options, correctOptionIndex, durationSeconds } = payload;

  try {
    const question = await questionRepository.createActiveQuestion(meetingCode, {
      prompt: prompt.trim(),
      optionA: options[0].trim(),
      optionB: options[1].trim(),
      optionC: options[2].trim(),
      optionD: options[3].trim(),
      correctOption: OPTION_LETTERS[correctOptionIndex],
      durationSeconds,
    });
    if (!question) throw httpError(404, 'La clase no existe.');
    return question;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw Object.assign(httpError(409, 'Ya hay una pregunta activa en esta clase.'), {
        reason: 'active_question_exists',
      });
    }
    throw err;
  }
}

// Lee la pregunta activa de esta clase — si su `expires_at` ya pasó pero
// sigue marcada "active" (ej. el backend se reinició y perdió el timer en
// memoria de `ws/questionTimers.js`), se finaliza acá mismo antes de
// devolver nada: el vencimiento lo decide el RELOJ del servidor contra la
// base, nunca un timer que puede haberse perdido en un reinicio.
async function getActiveQuestion(meetingCode) {
  const question = await questionRepository.getActiveQuestionForMeeting(meetingCode);
  if (!question) return null;
  if (new Date(question.expires_at).getTime() <= Date.now()) {
    await questionRepository.markQuestionFinished(question.id);
    return null;
  }
  return question;
}

function getQuestionById(id) {
  return questionRepository.getQuestionById(id);
}

// `true` solo si ESTA llamada fue la que de verdad finalizó la pregunta
// (`markQuestionFinished` es idempotente — no afecta filas si ya estaba
// finalizada) — evita que una carrera entre el timer automático y un
// "finish_question" manual dispare el broadcast de "question_finished" dos
// veces (ver `ws/handlers.js`).
function finishQuestion(id) {
  return questionRepository.markQuestionFinished(id);
}

function countStudents(meetingCode) {
  return participationRepository.countStudentsForMeeting(meetingCode);
}

function getAnswerCounts(questionId) {
  return questionAnswerRepository.getStats(questionId);
}

// Distribución por opción (agregada) para las barras en vivo del docente —
// ver `questionAnswerRepository.getOptionCounts`.
function getOptionCounts(questionId) {
  return questionAnswerRepository.getOptionCounts(questionId);
}

// Estado de la respuesta de ESTE alumno para una pregunta puntual — usado
// para el catch-up de un alumno que se une tarde o se reconecta (ver
// `ws/handlers.js`, `sendQuestionStateCatchUp`): `null` si todavía no
// respondió ni saltó. `correctOptionIndex` viaja igual que en
// `submitAnswer`/`skipAnswer` — si esta función devuelve algo, es porque
// YA existe una fila de respuesta suya (persistida, sin vuelta atrás), así
// que revelársela en la reconexión es tan seguro como revelarla en el
// momento mismo de responder.
async function getAnswerState(questionId, email) {
  const userId = await userRepository.getUserIdByEmail(email);
  if (!userId) return null;
  const answer = await questionAnswerRepository.getAnswer(questionId, userId);
  if (!answer) return null;
  const question = await questionRepository.getQuestionById(questionId);
  return {
    answered: !answer.skipped,
    skipped: Boolean(answer.skipped),
    isCorrect: answer.is_correct === null ? null : Boolean(answer.is_correct),
    correctOptionIndex: question ? OPTION_LETTERS.indexOf(question.correct_option) : null,
  };
}

// Punto de entrada común de `submitAnswer`/`skipAnswer`: confirma que quien
// responde es alumno de ESTA clase (reusa `roleService.getStudentName`, la
// misma fuente que ya usa el WS al unirse — nunca se confía en el rol que
// declare el propio socket más allá de lo que `ws/handlers.js` ya filtró) y
// que la pregunta que referencia el cliente sigue siendo la ACTIVA de esta
// clase, sin haber vencido — un `questionId` de una pregunta anterior, ya
// finalizada, se rechaza acá igual que una que nunca existió.
async function loadActiveQuestionForAnswer(meetingCode, email, questionId) {
  const studentName = await roleService.getStudentName(meetingCode, email);
  if (!studentName) throw httpError(403, 'No sos alumno de esta clase.');

  const question = await questionRepository.getActiveQuestionForMeeting(meetingCode);
  if (!question || question.id !== questionId) throw httpError(409, 'Esta pregunta ya no está activa.');

  if (new Date(question.expires_at).getTime() <= Date.now()) {
    await questionRepository.markQuestionFinished(question.id);
    throw httpError(409, 'El tiempo para responder ya venció.');
  }

  return question;
}

async function submitAnswer(meetingCode, email, questionId, selectedOptionIndex) {
  if (!Number.isInteger(selectedOptionIndex) || selectedOptionIndex < 0 || selectedOptionIndex > 3) {
    throw httpError(400, 'Opción inválida.');
  }

  const question = await loadActiveQuestionForAnswer(meetingCode, email, questionId);
  const userId = await userRepository.getUserIdByEmail(email);
  if (!userId) throw httpError(403, 'No sos alumno de esta clase.');

  const selectedOption = OPTION_LETTERS[selectedOptionIndex];
  // Nunca se confía en que el cliente diga si acertó — se recalcula acá
  // contra `correct_option`, que jamás salió del servidor mientras la
  // pregunta estuvo activa.
  const isCorrect = selectedOption === question.correct_option;
  const responseTimeMs = Math.max(0, Date.now() - new Date(question.started_at).getTime());

  try {
    await questionAnswerRepository.insertAnswer(question.id, userId, {
      selectedOption,
      isCorrect,
      skipped: false,
      responseTimeMs,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'Ya respondiste esta pregunta.');
    throw err;
  }

  // `correctOptionIndex` viaja de vuelta acá — Corrección (panel del
  // alumno, tarjeta final inmediata): a diferencia de `toPublicQuestion`
  // (que nunca la incluye, porque ESE mensaje llega a TODOS los alumnos
  // por igual antes de responder), esto es la respuesta DIRECTA y
  // UNICAST al socket que acaba de mandar SU PROPIA respuesta — ya no
  // puede cambiarla (el índice único de `question_answers` lo impide), así
  // que revelársela a partir de acá no le sirve para nada más que ver su
  // propio resultado. Nunca se broadcastea a nadie más.
  return { questionId: question.id, isCorrect, correctOptionIndex: OPTION_LETTERS.indexOf(question.correct_option) };
}

async function skipAnswer(meetingCode, email, questionId) {
  const question = await loadActiveQuestionForAnswer(meetingCode, email, questionId);
  const userId = await userRepository.getUserIdByEmail(email);
  if (!userId) throw httpError(403, 'No sos alumno de esta clase.');

  const responseTimeMs = Math.max(0, Date.now() - new Date(question.started_at).getTime());

  try {
    await questionAnswerRepository.insertAnswer(question.id, userId, {
      selectedOption: null,
      isCorrect: null,
      skipped: true,
      responseTimeMs,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'Ya respondiste esta pregunta.');
    throw err;
  }

  return { questionId: question.id, correctOptionIndex: OPTION_LETTERS.indexOf(question.correct_option) };
}

// Convierte una fila cruda de `questionRepository.getFinishedQuestionsForMeeting`
// (columnas SQL + contadores ya agregados) a la forma pública que consume
// `TeacherPanel.jsx` — mismo criterio que `ws/handlers.js#toPublicQuestion`:
// la opción correcta SÍ viaja acá (la pregunta ya terminó, y este endpoint
// ya validó que quien pregunta es el docente de la clase).
function toTeacherHistoryEntry(row) {
  const options = [row.option_a, row.option_b, row.option_c, row.option_d];
  const correctOptionIndex = OPTION_LETTERS.indexOf(row.correct_option);
  const optionCounts = [row.countA, row.countB, row.countC, row.countD];
  const answeredCount = row.answeredCount;

  return {
    id: row.id,
    prompt: row.prompt,
    options,
    correctOptionIndex,
    responseCount: answeredCount,
    skippedCount: row.skippedCount,
    finishedAt: row.finished_at,
    // Reporte PDF de fin de clase, Sección 2 — segundos (no ms), redondeado
    // a un decimal; `null` si nadie llegó a responder (ver
    // `questionRepository.getFinishedQuestionsForMeeting`).
    avgResponseTimeSeconds:
      row.avgResponseTimeMs != null ? Math.round(row.avgResponseTimeMs / 100) / 10 : null,
    optionDistribution: options.map((label, i) => ({
      label,
      count: optionCounts[i],
      percent: answeredCount > 0 ? Math.round((optionCounts[i] / answeredCount) * 100) : 0,
      correct: i === correctOptionIndex,
    })),
  };
}

// Historial de preguntas finalizadas de una reunión — SOLO para el docente
// de esa reunión puntual. `requestingEmail` se resuelve contra
// `participations` (mismo mecanismo que ya usa `ws/handlers.js` para
// validar quién puede enviar/finalizar preguntas) — jamás se acepta un
// "soy docente" declarado sin más por el cliente.
async function getFinishedQuestionsForMeeting(meetingCode, requestingEmail) {
  const { role } = await roleService.getRole(meetingCode, requestingEmail);
  if (role !== 'teacher') {
    throw httpError(403, 'Solo el docente de esta clase puede consultar este historial.');
  }
  const rows = await questionRepository.getFinishedQuestionsForMeeting(meetingCode);
  return rows.map(toTeacherHistoryEntry);
}

// Corrección — cada fila cruda de `questionAnswerRepository.
// getStudentQuestionHistory` (LEFT JOIN: puede o no tener una respuesta de
// este alumno) se traduce a UNO de cuatro estados textuales — el frontend
// ya no tiene que derivar nada de `isCorrect`/`skipped` por su cuenta,
// consume `status` tal cual:
//   - 'unanswered': no existe NINGUNA fila de `question_answers` para este
//     alumno + esta pregunta (ni respondió, ni saltó — dejó vencer el
//     tiempo o nunca llegó a interactuar). Se distingue por `answered_at`
//     en NULL, la única columna que el `LEFT JOIN` deja así exactamente
//     cuando no hay fila — a diferencia de `skipped`, que si hay fila
//     siempre viene como `0`/`1`, nunca NULL.
//   - 'skipped': eligió "Prefiero no responder".
//   - 'correct'/'incorrect': respondió una opción, evaluada server-side.
function toStudentHistoryEntry(row) {
  const options = [row.option_a, row.option_b, row.option_c, row.option_d];
  const correctOptionIndex = OPTION_LETTERS.indexOf(row.correct_option);
  const hasAnswerRow = row.answered_at != null;

  let status;
  if (!hasAnswerRow) status = 'unanswered';
  else if (row.skipped) status = 'skipped';
  else status = row.is_correct ? 'correct' : 'incorrect';

  return {
    id: row.id,
    prompt: row.prompt,
    options,
    correctOptionIndex,
    selectedOptionIndex: row.selected_option ? OPTION_LETTERS.indexOf(row.selected_option) : null,
    status,
    finishedAt: row.finished_at,
  };
}

// Historial personal de UN alumno — Corrección: ahora trae TODAS las
// preguntas finalizadas de la reunión, no solo las que respondió (ver
// `questionAnswerRepository.getStudentQuestionHistory`). La identidad
// viaja siempre como `email` (igual que el resto de la app, ver
// `roleService.getStudentName`), nunca como un `studentId`/`userId` crudo
// mandado por el cliente — la query resuelve el `user_id` internamente vía
// JOIN por email, así que no hay forma de pedir el historial de otra
// persona pasando un id ajeno.
async function getStudentQuestionHistory(meetingCode, email) {
  const rows = await questionAnswerRepository.getStudentQuestionHistory(meetingCode, email);
  return rows.map(toStudentHistoryEntry);
}

// Estadísticas agregadas POR ALUMNO ("X/Y respuestas correctas" en la tab
// "Alumnos") — SOLO para el docente de esa reunión puntual, mismo chequeo
// de autorización que `getFinishedQuestionsForMeeting`. Nunca expone qué
// opción eligió cada alumno ni respuestas individuales — solo los cuatro
// contadores agregados que ya devuelve la consulta.
async function getStudentStatsForMeeting(meetingCode, requestingEmail) {
  const { role } = await roleService.getRole(meetingCode, requestingEmail);
  if (role !== 'teacher') {
    throw httpError(403, 'Solo el docente de esta clase puede consultar estas estadísticas.');
  }
  return questionAnswerRepository.getStudentStatsForMeeting(meetingCode);
}

module.exports = {
  generatePreview,
  createAndStartQuestion,
  getActiveQuestion,
  getQuestionById,
  finishQuestion,
  countStudents,
  getAnswerCounts,
  getOptionCounts,
  getAnswerState,
  submitAnswer,
  skipAnswer,
  getFinishedQuestionsForMeeting,
  getStudentQuestionHistory,
  getStudentStatsForMeeting,
};
