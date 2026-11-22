// El content script no puede llamar al backend directamente (bloqueado por
// Private Network Access, ver DOCUMENTACION.md Etapa 8): en vez de fetch,
// le pide el trabajo al service worker de la extensión por mensaje, que es
// quien de verdad hace el fetch (src/background/main.js).
//
// Etapa de traducción (Paso 1/3) — los `type` de estos mensajes
// (`SPARKLE_*`) y la forma del `payload` son 100% internos a la extensión
// (content script ↔ background, nunca salen por la red) — se traducen acá
// mismo, en este paso, sin esperar al contrato REST/WS con el backend real
// (ver DOCUMENTACION.md, Etapa 4).
function requestFromBackground(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('El background script no respondió.'));
        return;
      }
      if (!response.success) {
        reject(new Error(response.error || 'Error desconocido del background script.'));
        return;
      }
      resolve(response.data);
    });
  });
}

export function registerMeetingRole(meetingCode, email, role) {
  return requestFromBackground('SPARKLE_REGISTER_ROLE', { meetingCode, email, role });
}

export function getMeetingRole(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_ROLE', { meetingCode, email });
}

// Etapa 68, Cambio 1 — devuelve `{ status, body }` (no solo el body): a
// diferencia de `registerMeetingRole` (best-effort, nadie mira su
// resultado), acá `StudentName.jsx` necesita distinguir un 200 (rol
// asignado) de un 409 (nombre repetido en esta reunión) para decidir qué
// mostrar — ver `services/api.js`.
export function registerStudent(meetingCode, email, name) {
  return requestFromBackground('SPARKLE_REGISTER_STUDENT', { meetingCode, email, name });
}

// Etapa 68, Cambio 3 — historial de sesiones de conexión para el botón
// "Ver historial de participantes" de `TeacherPanel.jsx`.
export function getHistory(meetingCode) {
  return requestFromBackground('SPARKLE_GET_HISTORY', { meetingCode });
}

// Etapa 71 — ¿ya hay un docente permanente registrado para esta reunión,
// con un email distinto? Ver `services/api.js` para el detalle de las dos
// capas que lo usan (Welcome.jsx / App.jsx).
export function getHasTeacher(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_HAS_TEACHER', { meetingCode, email });
}

// Preferencia del toggle de la prueba de preview de cámara (Etapa 63, ver
// `hooks/useCameraPreference.js`): herramienta de PRUEBA, pensada para
// eliminarse por completo antes de las funcionalidades reales de IA — ver
// DOCUMENTACION.md.
export function getCameraEnabled(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_CAMERA', { meetingCode, email });
}

export function updateCameraEnabled(meetingCode, email, enabled) {
  return requestFromBackground('SPARKLE_UPDATE_CAMERA', { meetingCode, email, enabled });
}

// Comunicación en tiempo real (Etapa 44): el WebSocket en sí vive en el
// background (`services/wsClient.js`), igual que el fetch — el content
// script solo le pide que se una a la sala de esta reunión (una vez
// resueltos meetingCode + rol) o que avise que el docente inició la clase.
// `role` acá es "teacher" | "student" — ya alineado con la nomenclatura
// del backend (Etapa 4). `email`
// (Etapa 46) es lo que ve el docente en el listado de alumnos conectados —
// solo tiene efecto si `role === 'student'`.
export function joinRoom(meetingCode, role, email) {
  return requestFromBackground('SPARKLE_WS_JOIN_ROOM', { meetingCode, role, email });
}

// Etapa 57: versión liviana de `joinRoom`, para el tick periódico de
// keepalive de `App.jsx` (ambos roles, cada 15s) — no reenvía un "join"
// completo si la sala ya está conectada (evita el broadcast de
// `students_updated` que eso dispararía), solo verifica/repara la
// conexión y, de paso, cuenta como actividad de la extensión ante Chrome
// (evita que el service worker se suspenda por inactividad — ver
// DOCUMENTACION.md, Etapa 57). Ver `keepRoomAlive()` en
// `services/wsClient.js`.
export function keepRoomAlive(meetingCode, role, email) {
  return requestFromBackground('SPARKLE_WS_KEEP_ALIVE', { meetingCode, role, email });
}

// Etapa 47: el pedido simétrico de "salirse" — App.jsx lo llama cuando
// `callStage` deja de ser 'en-llamada' (lobby, sala de espera, salida). Sin
// esto, la conexión WS (y con ella, la aparición en el listado de alumnos
// conectados del docente) quedaba atada solo al `meetingCode`, no al estado
// de contexto real — ver DOCUMENTACION.md, Etapa 47.
export function leaveRoom(meetingCode) {
  return requestFromBackground('SPARKLE_WS_LEAVE_ROOM', { meetingCode });
}

// `email` (Etapa 52) viaja en los tres comandos, no solo en `joinRoom`: si
// el background perdió el estado de la sala (service worker reiniciado)
// necesita poder reconstruirla con el mismo email de siempre para volver a
// unirse antes de mandar el comando — ver `waitForSocketOpen` en
// `services/wsClient.js`.
export function startClass(meetingCode, email) {
  return requestFromBackground('SPARKLE_WS_START_CLASS', { meetingCode, email });
}

// Etapa 45: simétrico a `startClass`.
export function endClass(meetingCode, email) {
  return requestFromBackground('SPARKLE_WS_END_CLASS', { meetingCode, email });
}

// Etapa 50: el docente elige "Reanudar" en el prompt de "¿Reanudar la clase
// anterior?" (Etapa 52: ahora aparece tras CUALQUIER finalización reciente,
// manual o automática — ver DOCUMENTACION.md).
export function resumeClass(meetingCode, email) {
  return requestFromBackground('SPARKLE_WS_RESUME_CLASS', { meetingCode, email });
}

// El docente elige un modo de clase en el selector de la pantalla pre-clase
// (`ui/AttentionModeSelector.jsx`) — `modeId` es 1-5 (ver
// `constants/attentionModes.js`, del lado del frontend eso es solo
// nombre/descripción; el backend resuelve el preset completo y lo manda de
// vuelta por WS, ver `hooks/useAttentionModeSync.js`).
export function setAttentionMode(meetingCode, email, modeId) {
  return requestFromBackground('SPARKLE_WS_SET_ATTENTION_MODE', { meetingCode, email, modeId });
}

// Preguntas en tiempo real (estilo Kahoot) — `generateQuestion` es REST
// (vista previa sin persistir, ver `services/api.js`); el resto viaja por
// WebSocket, mismo patrón que `startClass`/`endClass`/`resumeClass` de
// arriba.
export function generateQuestion(meetingCode, email, discardedPrompts = []) {
  return requestFromBackground('SPARKLE_GENERATE_QUESTION', { meetingCode, email, discardedPrompts });
}

export function sendQuestion(meetingCode, email, question) {
  return requestFromBackground('SPARKLE_WS_SEND_QUESTION', { meetingCode, email, question });
}

export function finishQuestion(meetingCode, email, questionId) {
  return requestFromBackground('SPARKLE_WS_FINISH_QUESTION', { meetingCode, email, questionId });
}

export function answerQuestion(meetingCode, email, questionId, selectedOptionIndex) {
  return requestFromBackground('SPARKLE_WS_ANSWER_QUESTION', { meetingCode, email, questionId, selectedOptionIndex });
}

export function skipQuestion(meetingCode, email, questionId) {
  return requestFromBackground('SPARKLE_WS_SKIP_QUESTION', { meetingCode, email, questionId });
}

// Monitoreo de atención en vivo (panel del docente, `ConcentrationStats.jsx`)
// — a diferencia de `startAttentionDetection`/`stopAttentionDetection` (más
// abajo, que solo hablan con el documento offscreen local), estos DOS SÍ
// llegan al backend por WebSocket: son el snapshot periódico que arma el
// roster que ve el docente. Ver `hooks/useAttentionBroadcast.js` para el
// detalle completo de privacidad (anonId generado del lado del cliente,
// nunca el email/nombre real).
export function sendAttentionSnapshot(meetingCode, email, snapshot) {
  return requestFromBackground('SPARKLE_WS_SEND_ATTENTION_SNAPSHOT', { meetingCode, email, snapshot });
}

export function sendAttentionStopped(meetingCode, email, anonId) {
  return requestFromBackground('SPARKLE_WS_SEND_ATTENTION_STOPPED', { meetingCode, email, anonId });
}

// Historial real de preguntas (REST, ver `services/api.js`) — "Preguntas
// realizadas" (docente) y "Preguntas respondidas" (alumno). Se piden al
// montar cada panel y de nuevo cada vez que una pregunta finaliza (ver
// `screens/TeacherPanel.jsx`/`StudentPanel.jsx`) — el WebSocket avisa
// CUÁNDO recargar, pero el contenido siempre sale de este pedido a la
// base de datos, nunca del propio mensaje WS.
export function getQuestionsHistory(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_QUESTIONS_HISTORY', { meetingCode, email });
}

export function getMyQuestionAnswers(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_MY_QUESTION_ANSWERS', { meetingCode, email });
}

// Estadísticas agregadas por alumno ("X/Y respuestas correctas", tab
// "Alumnos" del docente) — ver `services/api.js`.
export function getStudentStats(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_STUDENT_STATS', { meetingCode, email });
}

// Carga de documentos (PDF) desde el panel del docente — `fileData` es
// `{ name, type, size, buffer }` (el `ArrayBuffer` ya leído del `File`
// elegido/soltado, ver `hooks/useDocumentUpload.js` para el porqué de no
// mandar el `File` tal cual). Devuelve `{ status, body }`, mismo patrón
// que `registerStudent` — quien llama necesita distinguir 201 (cargado)
// de un 400/403/413 con mensaje claro (ver `services/api.js`).
export function uploadDocument(meetingCode, email, fileData) {
  return requestFromBackground('SPARKLE_UPLOAD_DOCUMENT', { meetingCode, email, fileData });
}

// Documento vigente de una reunión — ver `services/api.js`. Mismo patrón
// simple que `getQuestionsHistory` (el body resuelve directo, sin
// `{status, body}`): un `.error` en el body es lo único que distingue un
// fallo de un éxito con `document: null`.
export function getCurrentDocument(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_DOCUMENT', { meetingCode, email });
}

// Resumen de la clase (alumno) — ver `services/api.js`. Mismo patrón que
// `registerStudent`/`uploadDocument` (`{status, body}`, no solo el body):
// `ClassSummary.jsx` necesita distinguir un 200 (resumen listo) de un
// 409/503/502 con mensaje claro (clase en curso / IA apagada / falló
// OpenAI) para decidir qué mostrar.
export function getClassSummary(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_CLASS_SUMMARY', { meetingCode, email });
}

// "Recuperar contenido" (alumno) — ver `services/api.js`. Mismo patrón
// `{status, body}` que `getClassSummary`: `RecoverySummary.jsx` necesita
// distinguir un 200 (con `aiSummaryAvailable` true/false) de un 502 (falló
// la llamada a OpenAI en sí) para decidir si mostrar "Reintentar".
export function getRecoverySummary(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_RECOVERY_SUMMARY', { meetingCode, email });
}

// "Quiz final" (alumno) — ver `services/api.js`. Mismo patrón `{status, body}`.
export function getFinalQuiz(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_FINAL_QUIZ', { meetingCode, email });
}

// Historial de atención grupal (docente) — ver `services/api.js`. Mismo
// patrón `{status, body}` que los dos de arriba.
export function getAttentionSnapshots(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_ATTENTION_SNAPSHOTS', { meetingCode, email });
}

// Análisis con IA del reporte PDF de fin de clase (docente, botón
// "Descargar reporte") — ver `services/api.js`/`utils/generateClassReport.js`.
// Mismo patrón `{status, body}` que `getAttentionSnapshots`.
export function getClassReportAnalysis(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_CLASS_REPORT_ANALYSIS', { meetingCode, email });
}

// Temas abordados según el documento cargado por el docente — ver
// `services/api.js`/`utils/generateClassReport.js`. Mismo patrón
// `{status, body}` que `getClassReportAnalysis`.
export function getReportDocumentTopics(meetingCode, email) {
  return requestFromBackground('SPARKLE_GET_REPORT_DOCUMENT_TOPICS', { meetingCode, email });
}

// Detección de atención en vivo — a diferencia de todo lo de arriba, estos dos
// NO llegan al backend: el service worker los usa para crear o cerrar el
// documento offscreen donde corre el modelo, que es local por completo (ver
// `hooks/useAttentionDetection.js` y `background/attentionOffscreen.js`).
// Tampoco llevan `meetingCode`/`email`: la detección no distingue reuniones ni
// personas, solo procesa el video de la cámara de esta pestaña.
//
// Las predicciones NO vuelven por acá: llegan como mensajes
// `SPARKLE_ATTENTION_EVENT` que el service worker empuja a la pestaña, porque
// son un flujo continuo y no la respuesta a una petición puntual.
export function startAttentionDetection() {
  return requestFromBackground('SPARKLE_ATTENTION_START', {});
}

export function stopAttentionDetection() {
  return requestFromBackground('SPARKLE_ATTENTION_STOP', {});
}

// Panel de ajuste rápido — ajusta umbral (Y, `pInattention` para marcar
// `inattentive`) y/o cadencia de predicción (X, en ms) del documento offscreen
// EN CALIENTE, sin reiniciar nada (ver `offscreen/detector.js#configure`).
// `config` es `{ threshold?, predictionIntervalMs? }` — cualquiera de los dos
// puede omitirse, y el que se mande se valida por separado del otro lado.
export function configureAttentionDetection(config) {
  return requestFromBackground('SPARKLE_ATTENTION_CONFIGURE', config);
}
