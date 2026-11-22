// Contrato del resumen de clase con IA — se invoca solo cuando
// `ENABLE_AI_CLASS_SUMMARY === 'true'` (chequeado en
// `services/classSummaryService.js`); a diferencia de preguntas/documento
// no hay un proveedor alternativo sin IA acá (no existe una versión
// "resumen al azar" con sentido) — con el flag apagado, el service
// simplemente no llama a esto, y devuelve `aiSummaryAvailable: false` en
// vez de un resumen (la sección "Para repasar", que no usa IA, sigue
// armándose igual).
//
// `summarize(context)` recibe `{ source, mainTopics, keyConcepts, transcriptSegments }`
// (mismos campos base que `providers/questionProvider.js`, salvo que acá
// `transcriptSegments` es la transcripción COMPLETA de la clase, no un
// recorte de los últimos fragmentos) y devuelve
// `{ bullets: string[], keyConcepts, model, inputTokens, outputTokens }`.
//
// `source` — decidido por `classSummaryService.buildCommonSummary` según
// cuánta transcripción hubo, NO por el proveedor:
//   - 'transcript' (default): resume lo que REALMENTE se dijo en clase —
//     la transcripción es la fuente principal, el documento es marco
//     temático. Requiere `transcriptSegments`.
//   - 'document': la clase no tuvo transcripción suficiente pero el
//     documento SÍ tiene temas/conceptos — resume el MATERIAL DE APOYO en
//     su lugar (`transcriptSegments` se ignora), con un prompt e
//     instrucciones DISTINTAS que evitan escribir como si el docente
//     hubiera explicado ese contenido.
//
// `bullets` puede venir un array VACÍO en cualquiera de los dos modos (no
// es un error: el modelo puede decidir, legítimamente, que no hay
// suficiente contenido real para resumir — ver
// `classSummaryService.buildCommonSummary`, que traduce eso a
// `summaryUnavailableReason: 'insufficient_transcript'`). `keyConcepts`
// viaja de vuelta tal cual (sin tocarlos) para que `classSummaryService`
// los reuse al armar la sección "Para repasar" sin tener que volver a leer
// `documentAnalysisService.getAnalysisSummary`.
class ClassSummaryProvider {
  async summarize(_context) {
    throw new Error('ClassSummaryProvider.summarize() no está implementado.');
  }
}

module.exports = { ClassSummaryProvider };
