// Caché EN MEMORIA del resumen de análisis (`files.analysis_result`) por
// reunión — mismo patrón que `ws/rooms.js`/`ws/questionTimers.js`: un
// `Map` a nivel de módulo, sin ninguna consulta a la base acá adentro
// (esas viven en `documentAnalysisService.js`, que es quien orquesta
// caché + MySQL, igual que `ws/handlers.js` orquesta `rooms.js`/
// `questionTimers.js` + MySQL). MySQL sigue siendo la ÚNICA fuente de
// verdad (`files.analysis_result`, ver `scripts/init-db.js`) — este Map
// es pura optimización, nunca el único lugar donde vive el dato.
//
// Vive en `services/` (no en `ws/`, a diferencia de `rooms.js`/
// `questionTimers.js`) a propósito: no es un estado de CONEXIÓN WS, es un
// dato de negocio del dominio de documentos — lo va a consumir la futura
// generación de preguntas con IA sin pasar necesariamente por el
// WebSocket (ver `documentAnalysisService.getAnalysisSummary`).
//
// Si el backend se reinicia, este Map se vacía sin problema: el próximo
// pedido que lo necesite es un cache miss normal, que repuebla desde la
// base — no hace falta ningún mecanismo de recuperación especial (mismo
// criterio, documentado, que ya aplica `rooms`).
// meetingId -> analysisResult (objeto YA parseado — ver
// `documentAnalysisService.getAnalysisSummary`)
const cache = new Map();

function get(meetingId) {
  return cache.get(meetingId);
}

function set(meetingId, analysisResult) {
  cache.set(meetingId, analysisResult);
}

// Se llama cuando el docente reemplaza el documento de la reunión (ver
// `documentService.saveTeacherDocument`) — el resumen viejo ya no
// corresponde a ningún archivo real, así que no alcanza con dejarlo
// colgando hasta que algo lo pise: hay que sacarlo del Map de una. Un
// `Map.delete` sobre una clave que nunca se cacheó (ej. la primera carga
// de la reunión, sin resumen previo) es un no-op inofensivo — no hace
// falta chequear existencia antes de llamar.
function invalidate(meetingId) {
  cache.delete(meetingId);
}

module.exports = { get, set, invalidate };
