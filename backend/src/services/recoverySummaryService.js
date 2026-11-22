const meetingRepository = require('../repositories/meetingRepository');
const transcriptRepository = require('../repositories/transcriptRepository');
const roleService = require('./roleService');
const documentAnalysisService = require('./documentAnalysisService');
const { openAIRecoverySummaryProvider } = require('../providers');

// Orquesta "Recuperar contenido" (botón de la alerta de fatiga,
// `ui/FatigueAlert.jsx`) — a diferencia de `classSummaryService.js` (una
// sola llamada por REUNIÓN, cacheada, disponible recién con la clase
// terminada), esto es PERSONAL y de MOMENTO: cada alumno que lo aprieta
// pide su propia ventana de los últimos minutos, en cualquier punto de la
// clase — por eso, a propósito, NO hay caché acá (cada pedido es distinto
// del anterior: la ventana de tiempo cambia en cada click).

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const DEFAULT_WINDOW_MINUTES = 3;
// Pedido explícito posterior — bajado de 150 a 25. Ya no es el ÚNICO piso
// que decide si se llama a la IA (ver `hasTranscript`/`hasDocumentInfo`
// más abajo: alcanza con CUALQUIERA de las dos fuentes, no solo esta) —
// pero sigue decidiendo si la transcripción EN PARTICULAR cuenta como una
// fuente válida.
const DEFAULT_MIN_CHARS = 25;

async function getRecoverySummary(meetingCode, email, windowMinutes = DEFAULT_WINDOW_MINUTES) {
  const { role } = await roleService.getRole(meetingCode, email);
  if (role !== 'teacher' && role !== 'student') {
    throw httpError(403, 'No participaste de esta clase.');
  }

  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const meetingId = await meetingRepository.getMeetingIdByCode(normalizedMeetingCode);
  if (!meetingId) throw httpError(404, 'La reunión no existe.');

  // Call-time, no al cargar el módulo — mismo criterio que
  // `ENABLE_AI_CLASS_SUMMARY`/`ENABLE_AI_DOCUMENT_ANALYSIS`: permite
  // prender/apagar sin reiniciar el proceso. Con el flag apagado, esto
  // NUNCA es un error — es el mismo estado neutral que "sin contenido
  // suficiente" (ver `summaryUnavailableReason` en `ClassSummary.jsx` para
  // el mismo criterio ya establecido: un "Reintentar" acá no cambiaría
  // nada).
  //
  // Pedido explícito posterior — renombrado de `ENABLE_AI_RECOVERY_SUMMARY`
  // a `RECOVERY_SUMMARY_ENABLED`: un solo flag para esto, no dos (evita el
  // riesgo de que alguien prenda uno y no el otro, o que quede uno de los
  // dos como código muerto sin que nadie lo note).
  const aiEnabled = process.env.RECOVERY_SUMMARY_ENABLED === 'true';
  if (!aiEnabled) {
    return {
      aiSummaryAvailable: false,
      unavailableReason: 'ai_disabled',
      bullets: null,
      windowMinutes,
      generatedAt: null,
    };
  }

  // En paralelo — mismo criterio que `classSummaryService.buildCommonSummary`:
  // el resumen cacheado del documento y la ventana de transcripción son
  // lecturas independientes entre sí.
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  const [documentSummary, transcriptSegments] = await Promise.all([
    documentAnalysisService.getAnalysisSummary(meetingId),
    transcriptRepository.getSegmentsSince(normalizedMeetingCode, since),
  ]);

  const mainTopics = documentSummary?.mainTopics ?? [];
  const keyConcepts = documentSummary?.keyConcepts ?? [];
  const totalChars = transcriptSegments.reduce((sum, segment) => sum + (segment.text ? segment.text.length : 0), 0);
  const minChars = Number.parseInt(process.env.OPENAI_RECOVERY_SUMMARY_MIN_CHARS, 10) || DEFAULT_MIN_CHARS;
  const hasTranscript = totalChars >= minChars;
  // Pedido explícito posterior — "si hay info del documento": esto lee el
  // ANÁLISIS ya procesado (`documentAnalysisService.getAnalysisSummary`,
  // cacheado por `meetingId`), nunca el archivo en sí — acá no hay ningún
  // archivo que abrir, `mainTopics`/`keyConcepts` YA son el resultado
  // final de ese análisis (o `[]` si no hay documento, o si el análisis
  // todavía no encontró nada útil). "Contenido útil" = alguno de los dos
  // arrays no está vacío.
  const hasDocumentInfo = mainTopics.length > 0 || keyConcepts.length > 0;

  console.log(
    `[Sparkle][IA] Recuperar contenido — reunión "${normalizedMeetingCode}": ventana=${windowMinutes}min, ` +
      `${transcriptSegments.length} segmento(s), ${totalChars} caracter(es) (mínimo configurado: ${minChars}) ` +
      `→ transcripción ${hasTranscript ? 'suficiente' : 'insuficiente'}, documento ${hasDocumentInfo ? 'con info' : 'sin info'}.`
  );

  // Pedido explícito posterior — se necesita AL MENOS UNA fuente real para
  // llamar a la IA: si ni la transcripción de la ventana ni el análisis
  // del documento tienen nada, no hay ninguna fuente de la que el prompt
  // pueda armar algo (ni siquiera vía su propia regla de FALLBACK, que
  // depende del documento) — cortar ACÁ, sin gastar una llamada a OpenAI
  // que solo podría devolver bullets vacíos. Con CUALQUIERA de las dos
  // presente (aunque sea solo una), sí se llama — el prompt de
  // `openAIRecoverySummaryProvider.js` decide cuál de las dos usar como
  // fuente principal (transcripción real si alcanza, documento como
  // FALLBACK si no).
  if (!hasTranscript && !hasDocumentInfo) {
    return {
      aiSummaryAvailable: false,
      unavailableReason: 'insufficient_content',
      bullets: null,
      windowMinutes,
      generatedAt: null,
    };
  }

  let result;
  try {
    result = await openAIRecoverySummaryProvider.summarize({
      mainTopics, keyConcepts, transcriptSegments, windowMinutes,
    });
  } catch (err) {
    // Mismo criterio que `classSummaryService.getClassSummary`: `err.message`
    // ya es un texto seguro para mostrar tal cual, 502 porque el fallo es
    // de un servicio upstream (OpenAI), no un bug de este backend.
    throw httpError(502, err.message);
  }

  // El modelo puede devolver CERO bullets aun con transcripción
  // "suficiente" en caracteres (mismo diagnóstico que
  // `classSummaryService.buildCommonSummary` documenta para el resumen de
  // clase completa) — no es un error, es la instrucción del propio prompt
  // cumpliéndose ante contenido real pero no sustancioso (ej. 2-3 minutos
  // de silencio o charla intrascendente).
  if (!result.bullets || result.bullets.length === 0) {
    return {
      aiSummaryAvailable: false,
      unavailableReason: 'insufficient_content',
      bullets: null,
      windowMinutes,
      generatedAt: new Date().toISOString(),
    };
  }

  return {
    aiSummaryAvailable: true,
    unavailableReason: null,
    bullets: result.bullets,
    windowMinutes,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getRecoverySummary };
