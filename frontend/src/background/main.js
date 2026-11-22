import {
  registerMeetingRole,
  getMeetingRole,
  registerStudent,
  getHistory,
  getHasTeacher,
  getCameraEnabled,
  updateCameraEnabled,
  generateQuestion,
  getQuestionsHistory,
  getMyQuestionAnswers,
  getStudentStats,
  uploadDocument,
  getCurrentDocument,
  getClassSummary,
  getRecoverySummary,
  getFinalQuiz,
  getAttentionSnapshots,
  getClassReportAnalysis,
  getReportDocumentTopics,
} from '../services/api.js';
import {
  joinRoom,
  keepRoomAlive,
  leaveRoom,
  startClass,
  endClass,
  resumeClass,
  setAttentionMode,
  cleanupTab,
  sendQuestion,
  finishQuestion,
  answerQuestion,
  skipQuestion,
  sendAttentionSnapshot,
  sendAttentionStopped,
} from '../services/wsClient.js';
import {
  startDetection,
  stopDetection,
  configureDetection,
  registerEventBridge,
  cleanupTab as cleanupDetectionTab,
} from './attentionOffscreen.js';

// Logging temporal de diagnóstico (Etapa 56, ver wsClient.js para el
// detalle completo de por qué). Este archivo es el ENTRY POINT real del
// bundle `background.js` (`vite.config.js`, `--mode background`) — todo el
// módulo (incluido `wsClient.js`, importado arriba) se evalúa desde cero
// cada vez que el service worker arranca, sea la primera vez o después de
// que Chrome lo suspendiera. `chrome.runtime.onSuspend` es la señal
// EXPLÍCITA de que Chrome está a punto de suspenderlo — pero ojo: solo
// dispara en una suspensión "prolija" (Chrome decide bajarlo por
// inactividad y le avisa); si el proceso del service worker directamente
// se cae (crash, memoria, etc.) puede no llegar a dispararse nunca — por
// eso el log de arranque de `wsClient.js` es el indicador más confiable de
// los dos (una suspensión que NO llegó a loguear `onSuspend` igual se
// nota, porque el próximo log de arranque aparece de la nada).
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    console.log(`[Sparkle][SW][${new Date().toISOString()}] chrome.runtime.onSuspend — Chrome está por suspender este service worker.`);
  });
}

// El service worker de la extensión corre en su propio origen
// (chrome-extension://...), no en el origen de la página de Meet, así que
// sus fetch no quedan sujetos a Private Network Access ni al CORS "de
// página" — solo a los host_permissions declarados en manifest.json (ver
// DOCUMENTACION.md, Etapa 8). Por eso las llamadas reales al backend viven
// acá, y el content script les pide el trabajo por mensaje.
// Los handlers de WS (Etapa 44) necesitan `sender.tab.id` para saber a qué
// pestaña reenviarle los eventos que lleguen del servidor más adelante
// (`wsClient.js`), así que reciben `sender` además de `payload` — los
// handlers de `api.js` lo ignoran (no lo necesitan).
const MESSAGE_HANDLERS = {
  SPARKLE_REGISTER_ROLE: (payload) => registerMeetingRole(payload.meetingCode, payload.email, payload.role),
  SPARKLE_GET_ROLE: (payload) => getMeetingRole(payload.meetingCode, payload.email),
  // Etapa 68 — ver `services/api.js`/`services/backendMessaging.js` para el
  // detalle de por qué estos dos devuelven forma distinta a los demás.
  SPARKLE_REGISTER_STUDENT: (payload) => registerStudent(payload.meetingCode, payload.email, payload.name),
  SPARKLE_GET_HISTORY: (payload) => getHistory(payload.meetingCode),
  // Etapa 71 — ver `services/api.js` para el detalle de las dos capas que lo usan.
  SPARKLE_GET_HAS_TEACHER: (payload) => getHasTeacher(payload.meetingCode, payload.email),
  // Etapa 63 — herramienta de PRUEBA (preview de cámara), ver
  // `hooks/useCameraPreference.js`.
  SPARKLE_GET_CAMERA: (payload) => getCameraEnabled(payload.meetingCode, payload.email),
  SPARKLE_UPDATE_CAMERA: (payload) => updateCameraEnabled(payload.meetingCode, payload.email, payload.enabled),
  SPARKLE_WS_JOIN_ROOM: (payload, sender) => {
    joinRoom(sender.tab.id, payload.meetingCode, payload.role, payload.email);
    return Promise.resolve({ ok: true });
  },
  // Etapa 57: el tick periódico de keepalive de `App.jsx` (ambos roles,
  // cada 15s) — ver `keepRoomAlive()` en `wsClient.js` para el porqué
  // completo (verificación/reparación de la conexión + mantener despierto
  // al service worker ante Chrome).
  SPARKLE_WS_KEEP_ALIVE: (payload, sender) => {
    keepRoomAlive(sender.tab.id, payload.meetingCode, payload.role, payload.email);
    return Promise.resolve({ ok: true });
  },
  // Etapa 47: el content script lo pide cuando `callStage` deja de ser
  // 'en-llamada' (lobby, sala de espera, o pantalla de salida) — ver
  // App.jsx y wsClient.js para el detalle de por qué esto ya alcanza sin
  // necesitar un mensaje "leave" nuevo en el protocolo WS.
  SPARKLE_WS_LEAVE_ROOM: (payload, sender) => {
    leaveRoom(sender.tab.id, payload.meetingCode);
    return Promise.resolve({ ok: true });
  },
  // `sender.tab.id` + `payload.email` (Etapa 52): si el service worker
  // perdió el estado de la sala (se reinició, ver `waitForSocketOpen` en
  // wsClient.js) estos comandos ya no dependen de que algún otro mensaje la
  // haya reconstruido antes — traen lo necesario para reconstruirla ellos
  // mismos, de una.
  SPARKLE_WS_START_CLASS: (payload, sender) => startClass(sender.tab.id, payload.meetingCode, payload.email),
  SPARKLE_WS_END_CLASS: (payload, sender) => endClass(sender.tab.id, payload.meetingCode, payload.email),
  SPARKLE_WS_RESUME_CLASS: (payload, sender) => resumeClass(sender.tab.id, payload.meetingCode, payload.email),
  // Modo de clase (pantalla pre-clase del docente) — ver
  // `ui/AttentionModeSelector.jsx`/`hooks/useAttentionModeSync.js`.
  SPARKLE_WS_SET_ATTENTION_MODE: (payload, sender) =>
    setAttentionMode(sender.tab.id, payload.meetingCode, payload.email, payload.modeId),
  // Preguntas en tiempo real — `SPARKLE_GENERATE_QUESTION` es REST (vista
  // previa sin persistir); el resto son comandos WS, mismo patrón que los
  // tres de arriba.
  SPARKLE_GENERATE_QUESTION: (payload) => generateQuestion(payload.meetingCode, payload.email, payload.discardedPrompts),
  SPARKLE_WS_SEND_QUESTION: (payload, sender) => sendQuestion(sender.tab.id, payload.meetingCode, payload.email, payload.question),
  SPARKLE_WS_FINISH_QUESTION: (payload, sender) => finishQuestion(sender.tab.id, payload.meetingCode, payload.email, payload.questionId),
  SPARKLE_WS_ANSWER_QUESTION: (payload, sender) =>
    answerQuestion(sender.tab.id, payload.meetingCode, payload.email, payload.questionId, payload.selectedOptionIndex),
  SPARKLE_WS_SKIP_QUESTION: (payload, sender) => skipQuestion(sender.tab.id, payload.meetingCode, payload.email, payload.questionId),
  // Historial real de preguntas (REST) — "Preguntas realizadas"/"Preguntas
  // respondidas", ver `services/api.js`.
  SPARKLE_GET_QUESTIONS_HISTORY: (payload) => getQuestionsHistory(payload.meetingCode, payload.email),
  SPARKLE_GET_MY_QUESTION_ANSWERS: (payload) => getMyQuestionAnswers(payload.meetingCode, payload.email),
  SPARKLE_GET_STUDENT_STATS: (payload) => getStudentStats(payload.meetingCode, payload.email),
  // Carga de documentos (PDF) — ver `services/api.js`/`hooks/useDocumentUpload.js`.
  SPARKLE_UPLOAD_DOCUMENT: (payload) => uploadDocument(payload.meetingCode, payload.email, payload.fileData),
  SPARKLE_GET_DOCUMENT: (payload) => getCurrentDocument(payload.meetingCode, payload.email),
  // Resumen de la clase (alumno) — ver `services/api.js`/`screens/ClassSummary.jsx`.
  SPARKLE_GET_CLASS_SUMMARY: (payload) => getClassSummary(payload.meetingCode, payload.email),
  // "Recuperar contenido" (alumno) — ver `services/api.js`/`screens/RecoverySummary.jsx`.
  SPARKLE_GET_RECOVERY_SUMMARY: (payload) => getRecoverySummary(payload.meetingCode, payload.email),
  // "Quiz final" (alumno) — ver `services/api.js`/`screens/FinalQuiz.jsx`.
  SPARKLE_GET_FINAL_QUIZ: (payload) => getFinalQuiz(payload.meetingCode, payload.email),
  // Historial de atención grupal (docente) — ver `services/api.js`/
  // `screens/ConcentrationStats.jsx`.
  SPARKLE_GET_ATTENTION_SNAPSHOTS: (payload) => getAttentionSnapshots(payload.meetingCode, payload.email),
  // Análisis con IA del reporte PDF de fin de clase (docente) — ver
  // `services/api.js`/`utils/generateClassReport.js`.
  SPARKLE_GET_CLASS_REPORT_ANALYSIS: (payload) => getClassReportAnalysis(payload.meetingCode, payload.email),
  // Temas abordados según el documento cargado por el docente — ver
  // `services/api.js`/`utils/generateClassReport.js`.
  SPARKLE_GET_REPORT_DOCUMENT_TOPICS: (payload) => getReportDocumentTopics(payload.meetingCode, payload.email),
  // Detección de atención: comandos hacia el documento offscreen, que es el
  // único contexto de la extensión donde puede correr WebAssembly con acceso a
  // cámara (ver `background/attentionOffscreen.js`). Los eventos vuelven por el
  // puente que registra `registerEventBridge()`, no por estas respuestas.
  SPARKLE_ATTENTION_START: (payload, sender) => startDetection(sender.tab.id),
  SPARKLE_ATTENTION_STOP: (payload, sender) => stopDetection(sender.tab.id),
  // Panel de ajuste rápido (N/X/Y) — X (cadencia) e Y (umbral) viajan hasta
  // acá; N (rachas consecutivas) es lógica pura del content script
  // (`hooks/useFatigueAlert.js`) y nunca necesita cruzar hacia el offscreen.
  SPARKLE_ATTENTION_CONFIGURE: (payload) => configureDetection(payload),
  // Monitoreo de atención en vivo (panel del docente) — a diferencia de los
  // tres de arriba, estos SÍ viajan al backend por WebSocket (comandos de
  // alumno, mismo patrón que `SPARKLE_WS_ANSWER_QUESTION`) — ver
  // `hooks/useAttentionBroadcast.js`.
  SPARKLE_WS_SEND_ATTENTION_SNAPSHOT: (payload, sender) =>
    sendAttentionSnapshot(sender.tab.id, payload.meetingCode, payload.email, payload.snapshot),
  SPARKLE_WS_SEND_ATTENTION_STOPPED: (payload, sender) =>
    sendAttentionStopped(sender.tab.id, payload.meetingCode, payload.email, payload.anonId),
};

registerEventBridge();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = MESSAGE_HANDLERS[message?.type];

  if (!handler) return false; // mensaje que no nos interesa: no respondemos

  handler(message.payload, sender)
    .then((data) => sendResponse({ success: true, data }))
    .catch((error) => sendResponse({ success: false, error: error.message }));

  return true; // respuesta asíncrona: mantiene abierto el canal de sendResponse
});

// Si se cierra la pestaña de Meet, se saca de todas las salas WS donde
// figuraba (Etapa 44) — evita mantener conexiones abiertas contra el
// backend por pestañas que ya no existen.
chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTab(tabId);
  // La detección de atención tiene su propio registro de pestañas suscritas y
  // mantiene abierta la cámara mientras quede alguna: si la pestaña se cierra
  // sin pasar por el "detener" del panel, hay que soltarla acá o el documento
  // offscreen queda vivo con el stream tomado.
  cleanupDetectionTab(tabId);
});
