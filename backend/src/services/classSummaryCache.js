// Caché EN MEMORIA del resumen de clase por reunión — mismo patrón base
// que `documentAnalysisCache.js` (un `Map` a nivel de módulo, sin ninguna
// consulta a la base ni al SDK de OpenAI acá adentro, eso vive en
// `classSummaryService.js`), con UNA diferencia clave: acá se cachea la
// PROMESA en curso, no solo el resultado ya resuelto.
//
// Por qué: el resumen de documento se genera UNA vez, disparado por la
// carga del archivo (fire-and-forget, nadie más compite por generarlo). El
// resumen de clase, en cambio, lo dispara la LECTURA — potencialmente
// treinta alumnos apretando "Obtener resumen de la clase" casi al mismo
// tiempo apenas termina la clase. Si acá solo se cacheara el resultado ya
// resuelto, los primeros N pedidos que lleguen ANTES de que el primero
// termine verían todos un cache miss, y cada uno dispararía su PROPIA
// llamada a OpenAI — exactamente lo que hay que evitar (una sola llamada,
// no treinta). Cacheando la promesa desde el instante en que se crea (ver
// `classSummaryService.getCommonSummary`, que hace el chequeo+creación en
// una sola función SIN ningún `await` en el medio, así que no hay ventana
// para que dos pedidos concurrentes se crucen), todos los pedidos que
// lleguen mientras la primera llamada sigue en vuelo esperan esa MISMA
// promesa en vez de disparar la suya.
//
// meetingId -> Promise<{ bullets, keyConcepts, generatedAt }>
const cache = new Map();

function get(meetingId) {
  return cache.get(meetingId);
}

function set(meetingId, summaryPromise) {
  cache.set(meetingId, summaryPromise);
}

// Se llama cuando la clase (re)arranca (`services/classService.js`,
// `startClass`/`resumeClass`) — un resumen cacheado para esa reunión ya no
// corresponde a la sesión que viene: o es de una clase ANTERIOR que
// reusó el mismo `meeting_code` (el link de Meet, y con él `meetingId`, se
// reutiliza entre clases distintas — ver `meetingRepository.upsertMeeting`),
// o es de la MISMA clase reanudada, cuya transcripción va a seguir
// creciendo hasta que se vuelva a finalizar. En ambos casos, servir el
// resumen viejo sería mostrarle al alumno contenido de una clase que no
// es (o no es toda) la que acaba de terminar. Un `Map.delete` sobre una
// clave sin entrada (reunión que nunca pidió un resumen) es un no-op
// inofensivo.
function invalidate(meetingId) {
  cache.delete(meetingId);
}

module.exports = { get, set, invalidate };
