const meetingRepository = require('../repositories/meetingRepository');
const classSummaryCache = require('./classSummaryCache');
const classReportCache = require('./classReportCache');

// Reglas de negocio del ciclo de vida de la clase (iniciar/finalizar/
// reanudar). Hoy solo las consume `ws/handlers.js` (no hay un endpoint REST
// equivalente para estas tres acciones) — viven acá, no ahí, para que
// cualquier futuro consumidor las reuse sin duplicar el criterio, mismo
// motivo por el que `roleService.js` es compartido entre REST y WS.

// Ventana de tiempo (Etapa 50) durante la cual una finalización AUTOMÁTICA
// (por desconexión del docente, no un "Finalizar Clase" a propósito) sigue
// ofreciendo el prompt de "¿Reanudar la clase anterior?" al reconectarse. 5
// minutos: cubre el caso real que motivó este feature (un F5 accidental,
// una llamada que se cuelga sola, un wifi que tarda un rato en volver) sin
// llegar a ofrecer "reanudar" una clase que en los hechos ya terminó hace
// rato. Es más corto que el intervalo de heartbeat (30s) varias veces, así
// que no hay riesgo de que el propio heartbeat lo vuelva irrelevante.
const RESUME_THRESHOLD_MS = 5 * 60 * 1000;

// `state` es la fila de `meetings` tal cual la devuelve
// `getClassState` (con `last_ended_type`/
// `last_ended_at`, además de `active`). Reanudable si: la clase NO
// está activa ahora, y la última finalización ocurrió dentro de la ventana
// de arriba — SIN IMPORTAR el tipo (Etapa 52: manual o automática habilitan
// el mismo prompt de reanudar por igual). `last_ended_type` se
// sigue completando igual en cada finalización — por si sirve para
// analítica más adelante — pero ya no determina esta decisión.
function isResumable(state) {
  if (!state || state.active) return false;
  if (!state.last_ended_at) return false;
  const elapsedMs = Date.now() - new Date(state.last_ended_at).getTime();
  return elapsedMs >= 0 && elapsedMs <= RESUME_THRESHOLD_MS;
}

function getClassState(meetingCode) {
  return meetingRepository.getClassState(meetingCode);
}

// El resumen de clase cacheado (si lo había) corresponde a la sesión
// ANTERIOR de esta reunión — `meeting_code` (y con él `meetingId`, ver
// `meetingRepository.upsertMeeting`) se reutiliza entre clases distintas
// (es el link de Meet, el docente lo reusa), así que arrancar de nuevo la
// clase es la señal de que cualquier resumen cacheado para esta reunión ya
// no corresponde a la clase que está por darse (ver
// `services/classSummaryCache.js` para el detalle completo). Best-effort:
// si la reunión no llega a resolverse (no debería pasar, el `upsertClass`
// de `activateClass` ya la garantiza), no hay nada que invalidar.
// Reporte PDF de fin de clase — el análisis con IA cacheado (si lo había)
// tiene la MISMA relación con "la clase que está por arrancar" que el
// resumen de clase de arriba: corresponde a la sesión ANTERIOR de esta
// reunión, nunca a la que viene. Se invalida en el mismo momento, por el
// mismo motivo — ver `classReportCache.invalidate`.
async function invalidateCachedSummary(meetingCode) {
  const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
  if (!meetingId) return;
  classSummaryCache.invalidate(meetingId);
  classReportCache.invalidate(meetingId);
}

async function startClass(meetingCode) {
  await meetingRepository.activateClass(meetingCode);
  // Ancla de fase para la curva de atención (ver
  // `meetingRepository.setAttentionWindowStart`) — se resetea ACÁ, mismo
  // gatillo que usa el cliente (`classStartedSignal`) para vaciar su propio
  // historial, nunca en `resumeClass`.
  await meetingRepository.setAttentionWindowStart(meetingCode, new Date());
  await invalidateCachedSummary(meetingCode);
}

function endClassManual(meetingCode) {
  return meetingRepository.markClassEnded(meetingCode, 'manual');
}

// Etapa 50 — mismo efecto que `endClassManual`, pero con
// `type='automatic'`: se dispara cuando el ÚLTIMO profesor conectado a la
// sala se desconecta (colgó, F5, cerró la pestaña, perdió la red) mientras
// la clase estaba activa. La decisión de CUÁNDO llamar a esto (¿sigue
// habiendo otro profesor conectado?) depende del estado en memoria de la
// sala WS, que este service no conoce — la toma `ws/handlers.js`.
function endClassAutomatic(meetingCode) {
  return meetingRepository.markClassEnded(meetingCode, 'automatic');
}

// Etapa 50 — el docente elige "Reanudar" en el prompt. Se revalida
// `isResumable()` en este mismo momento (no solo cuando se mandó el
// prompt): si pasó el umbral entre que se mostró y que el docente hizo
// click, o si por alguna carrera la clase ya se finalizó MANUALMENTE en el
// medio, no corresponde reactivarla a ciegas. Devuelve `false` sin tocar la
// base si ya no corresponde — quien llama decide qué hacer con eso.
async function resumeClass(meetingCode) {
  const state = await getClassState(meetingCode);
  if (!isResumable(state)) return false;
  await meetingRepository.reactivateClass(meetingCode);
  // Ajuste — invalida el resumen cacheado de la finalización anterior: una
  // clase reanudada sigue acumulando transcripción, así que si vuelve a
  // finalizarse el resumen tiene que regenerarse con esa parte final
  // incluida, nunca servir el que ya se había generado (y cacheado) para
  // la finalización previa.
  await invalidateCachedSummary(meetingCode);
  return true;
}

// Persiste el modo de atención elegido por el docente — ver
// `constants/attentionModes.js` para los 5 presets y `ws/handlers.js`,
// `handleSetAttentionMode` para la validación + el broadcast a la sala.
function setAttentionMode(meetingCode, modeId) {
  return meetingRepository.setAttentionMode(meetingCode, modeId);
}

module.exports = {
  isResumable,
  getClassState,
  startClass,
  endClassManual,
  endClassAutomatic,
  resumeClass,
  setAttentionMode,
};
