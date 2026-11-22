// Contrato del resumen de "Recuperar contenido" con IA — se invoca solo
// cuando `RECOVERY_SUMMARY_ENABLED === 'true'` (chequeado en
// `services/recoverySummaryService.js`), mismo criterio que
// `classSummaryProvider.js`. No hay proveedor alternativo sin IA (no
// existe una versión "resumen al azar" con sentido para esto).
//
// `summarize(context)` recibe `{ mainTopics, keyConcepts, transcriptSegments,
// windowMinutes }` — `transcriptSegments` es SOLO la ventana reciente (los
// últimos `windowMinutes` minutos, ver
// `repositories/transcriptRepository.getSegmentsSince`), nunca la clase
// completa (a diferencia de `classSummaryProvider`). Devuelve
// `{ bullets: string[] }`.
//
// `bullets` puede venir un array VACÍO — no es un error: el modelo puede
// decidir, legítimamente, que no hay contenido real que resumir en esa
// ventana (mismo criterio que `classSummaryProvider`, ver ese archivo).
class RecoverySummaryProvider {
  async summarize(_context) {
    throw new Error('RecoverySummaryProvider.summarize() no está implementado.');
  }
}

module.exports = { RecoverySummaryProvider };
