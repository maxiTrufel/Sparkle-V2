// Contrato del paso OPCIONAL de RESUMEN con IA — se invoca solo cuando
// `ENABLE_AI_DOCUMENT_ANALYSIS === 'true'` (chequeado en
// `services/documentAnalysisService.js`), DESPUÉS del paso de extracción,
// y recibe el TEXTO YA EXTRAÍDO — nunca abre el PDF por su cuenta, eso es
// responsabilidad exclusiva de `textExtractionProvider.js`. Separar ambos
// contratos en dos archivos (en vez de uno solo con un método opcional)
// refleja que son dos PASOS EN SECUENCIA, no proveedores alternativos
// entre los que se elige.
//
// `summarize(text, { originalName })` devuelve un objeto cuya forma
// EXACTA depende del proveedor concreto — `documentAnalysisService.js` lo
// persiste tal cual, sin conocer sus campos uno por uno (solo separa
// `model`/`inputTokens`/`outputTokens`, que van a columnas propias, ver
// `repositories/documentAnalysisRepository.js`). Cualquier lógica que
// interprete la forma cruda de la respuesta del proveedor concreto (ej.
// parsear el JSON que devuelve el modelo, validar sus campos) vive DENTRO
// de la implementación — nunca en `documentAnalysisService.js` ni más
// abajo. Hoy (`openAIDocumentAnalysisProvider.js`):
// `{ mainTopics, keyConcepts, model, inputTokens, outputTokens }`.
class DocumentSummaryProvider {
  async summarize(_text, _params) {
    throw new Error('DocumentSummaryProvider.summarize() no está implementado.');
  }
}

module.exports = { DocumentSummaryProvider };
