// Contrato del paso de EXTRACCIÓN de texto de un documento — corre SIEMPRE
// (ver `services/documentAnalysisService.js` y `providers/index.js`), sea
// que el resumen con IA (`documentSummaryProvider.js`) esté activo o no:
// extraer y resumir son dos PASOS EN SECUENCIA del mismo pipeline, no
// proveedores alternativos entre los que se elige uno.
//
// `extractText({ filePath })` devuelve `{ extractedText, pageCount,
// charCount }` — sin metadata de modelo/tokens, porque este paso nunca
// llama a ningún servicio externo (hoy: extracción local con `pdf-parse`,
// ver `pdfTextExtractionProvider.js`).
class TextExtractionProvider {
  async extractText(_params) {
    throw new Error('TextExtractionProvider.extractText() no está implementado.');
  }
}

module.exports = { TextExtractionProvider };
