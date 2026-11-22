// Caché EN MEMORIA del análisis con IA del reporte de fin de clase, por
// reunión — mismo patrón exacto que `classSummaryCache.js` (se cachea la
// PROMESA en curso, no solo el resultado ya resuelto, para deduplicar
// pedidos concurrentes). Acá el motivo no es "treinta alumnos apretando el
// mismo botón" (solo el docente pide el reporte), sino evitar pagar una
// llamada nueva a OpenAI cada vez que descarga el PDF de la MISMA clase
// (ej. lo descarga, lo revisa, lo vuelve a descargar un minuto después).
//
// meetingId -> Promise<{ strengths, weaknesses, questionDiagnostics, studentRecommendations, suggestedTopics }>
const cache = new Map();

function get(meetingId) {
  return cache.get(meetingId);
}

function set(meetingId, analysisPromise) {
  cache.set(meetingId, analysisPromise);
}

// Se llama cuando la clase (re)arranca (`services/classService.js`,
// `startClass`/`resumeClass`) — mismo criterio que `classSummaryCache.
// invalidate`: un análisis cacheado para esta reunión deja de corresponder
// a la sesión que viene, sea porque es de una clase ANTERIOR que reusó el
// mismo `meeting_code`, o porque la MISMA clase se reanudó y va a seguir
// acumulando preguntas/respuestas hasta que se vuelva a finalizar.
function invalidate(meetingId) {
  cache.delete(meetingId);
}

module.exports = { get, set, invalidate };
