// Timers en memoria (uno por pregunta activa) que hacen que el vencimiento
// de una pregunta sea un evento del SERVIDOR, no algo que dependa de que
// algún cliente siga conectado o mande algo (ver DOCUMENTACION del feature:
// "no iniciar la sincronización únicamente con un setInterval local"). No
// son la única fuente de verdad del vencimiento — `services/
// questionService.js` revalida `expires_at` contra el reloj en cada lectura
// y en cada intento de respuesta, así que si el backend se reinicia (y con
// él, este `Map`) una pregunta vencida igual se corta sola en el próximo
// join/respuesta; este timer solo evita depender de que alguien más
// interactúe para que el broadcast de "question_finished" salga a tiempo.
// questionId -> timeout handle
const timers = new Map();

function schedule(questionId, delayMs, callback) {
  clear(questionId);
  const handle = setTimeout(() => {
    timers.delete(questionId);
    Promise.resolve(callback()).catch((err) => {
      console.error(`[Sparkle][WS] Error en el vencimiento automático de la pregunta ${questionId}:`, err.message);
    });
  }, delayMs);
  timers.set(questionId, handle);
  // Etapa 84 — mismo criterio que el resto de los timers del backend
  // (`ws/handlers.js`, `ws/attentionState.js`): no mantiene vivo el proceso
  // por sí solo. En producción no cambia nada (el servidor HTTP ya lo
  // mantiene vivo); en los tests, un proceso ya terminado no queda esperando
  // el vencimiento de una pregunta que quedó activa.
  if (typeof handle.unref === 'function') handle.unref();
}

// Se llama tanto cuando el docente finaliza la pregunta a mano (evita que
// el timer dispare un segundo "question_finished" de más) como, por
// higiene, si alguna vez hiciera falta cancelar un timer sin reemplazarlo.
function clear(questionId) {
  const handle = timers.get(questionId);
  if (!handle) return;
  clearTimeout(handle);
  timers.delete(questionId);
}

module.exports = { schedule, clear };
