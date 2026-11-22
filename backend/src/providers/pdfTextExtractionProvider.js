const fs = require('fs/promises');
const { PDFParse } = require('pdf-parse');
const { TextExtractionProvider } = require('./textExtractionProvider');

// Único proveedor de extracción hoy, y corre SIEMPRE (ver
// `providers/index.js` y `services/documentAnalysisService.js`) — nunca
// detrás de ningún flag, a diferencia del resumen con IA que viene
// después: no llama a ningún servicio externo, solo abre el PDF ya
// guardado en disco y saca su texto plano, recorriendo todas las páginas
// y concatenando el resultado (`getText()` de `pdf-parse` ya concatena
// `pages[].text` en un único `text`, en orden).
class PdfTextExtractionProvider extends TextExtractionProvider {
  async extractText({ filePath }) {
    const buffer = await fs.readFile(filePath);
    const parser = new PDFParse({ data: buffer });
    try {
      const { text, total } = await parser.getText();
      return {
        extractedText: text,
        pageCount: total,
        charCount: text.length,
      };
    } finally {
      await parser.destroy();
    }
  }
}

module.exports = { PdfTextExtractionProvider };
