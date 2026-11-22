const { RandomQuestionProvider } = require('./randomQuestionProvider');
const { OpenAIQuestionProvider } = require('./openAIQuestionProvider');
const { OpenAIDocumentAnalysisProvider } = require('./openAIDocumentAnalysisProvider');
const { PdfTextExtractionProvider } = require('./pdfTextExtractionProvider');
const { OpenAIClassSummaryProvider } = require('./openAIClassSummaryProvider');
const { OpenAIRecoverySummaryProvider } = require('./openAIRecoverySummaryProvider');
const { OpenAIClassReportProvider } = require('./openAIClassReportProvider');
const { OpenAIFinalQuizProvider } = require('./openAIFinalQuizProvider');

// Preguntas: DOS proveedores, siempre instanciados acá (`OpenAIQuestionProvider`
// es perezoso — no crea el cliente de OpenAI ni exige `OPENAI_API_KEY`
// hasta que `generateQuestion()` se invoca de verdad), pero
// `services/questionService.js` decide en CADA pedido, leyendo
// `ENABLE_AI_QUESTION_GENERATION` de `process.env` en ese momento (no acá,
// una sola vez al cargar el módulo), cuál de los dos usar — mismo criterio
// que `ENABLE_AI_DOCUMENT_ANALYSIS` más abajo: permite prender/apagar sin
// reiniciar el proceso, y que los tests lo toggleen por caso.
//
// Los tests reemplazan el método (`generateQuestion`) de ESTAS MISMAS
// instancias exportadas en vez de mockear ningún SDK.
const randomQuestionProvider = new RandomQuestionProvider();
const openAIQuestionProvider = new OpenAIQuestionProvider();

// Documentos: DOS proveedores para DOS PASOS EN SECUENCIA (ver
// `services/documentAnalysisService.js`) — extraer texto y resumir con IA
// NO son alternativas entre las que se elige una, son etapas de un mismo
// pipeline. Por eso, a diferencia de las preguntas de arriba (donde se
// elige UNA de las dos), acá ambos proveedores se usan siempre juntos.
//
// `pdfTextExtractionProvider` corre en TODOS los casos, sin condicionar a
// ningún flag — no tiene costo ni llamada externa (ver
// `pdfTextExtractionProvider.js`).
//
// `documentSummaryProvider` también se instancia siempre acá (su
// constructor es perezoso — no crea el cliente de OpenAI ni exige
// `OPENAI_API_KEY` hasta que `summarize()` se invoca de verdad, ver
// `openAIDocumentAnalysisProvider.js`), pero `documentAnalysisService.js`
// decide en CADA análisis, leyendo `ENABLE_AI_DOCUMENT_ANALYSIS` de
// `process.env` en ese momento (no acá, una sola vez al cargar el
// módulo), si llega a invocarlo o no. Eso permite prender/apagar el
// resumen con solo cambiar la variable de entorno, sin reiniciar el
// proceso — y en ambos casos el resultado sigue incluyendo
// extractedText/pageCount/charCount, porque esos salen siempre del primer
// paso, nunca del segundo.
//
// Los tests reemplazan el método (`extractText`/`summarize`) de ESTAS
// MISMAS instancias exportadas en vez de mockear ningún SDK — no hace
// falta ninguna librería de mocking para eso.
const pdfTextExtractionProvider = new PdfTextExtractionProvider();
const documentSummaryProvider = new OpenAIDocumentAnalysisProvider();

// Resumen de clase: UN solo proveedor (no hay alternativa sin IA con
// sentido, a diferencia de preguntas) — se instancia EAGER acá igual que
// el resto (constructor perezoso, no exige `OPENAI_API_KEY` hasta
// `summarize()`), pero `services/classSummaryService.js` decide en CADA
// pedido, leyendo `ENABLE_AI_CLASS_SUMMARY` de `process.env` en ese
// momento, si corresponde invocarlo.
const openAIClassSummaryProvider = new OpenAIClassSummaryProvider();

// "Recuperar contenido" (alumno, alerta de fatiga) — mismo criterio que el
// resumen de clase de arriba: un solo proveedor, instanciado EAGER pero
// perezoso puertas adentro (no exige `OPENAI_API_KEY` hasta `summarize()`),
// y `services/recoverySummaryService.js` decide en CADA pedido, leyendo
// `RECOVERY_SUMMARY_ENABLED` de `process.env` en ese momento, si
// corresponde invocarlo.
const openAIRecoverySummaryProvider = new OpenAIRecoverySummaryProvider();

// Análisis con IA del reporte PDF de fin de clase (Sección 5) — mismo
// criterio que el resumen de clase/recuperación de arriba: un solo
// proveedor, instanciado EAGER pero perezoso puertas adentro, y
// `services/classReportService.js` decide en CADA pedido, leyendo
// `ENABLE_AI_CLASS_REPORT` de `process.env` en ese momento, si corresponde
// invocarlo.
const openAIClassReportProvider = new OpenAIClassReportProvider();

// "Quiz final" (alumno, clase ya detenida) — mismo criterio que los de arriba:
// instanciado EAGER pero perezoso puertas adentro. `services/finalQuizService.js`
// decide en CADA pedido si se llama, leyendo `ENABLE_AI_QUESTION_GENERATION`
// (el mismo flag que las preguntas en vivo, ver ese archivo).
const openAIFinalQuizProvider = new OpenAIFinalQuizProvider();

module.exports = {
  randomQuestionProvider,
  openAIQuestionProvider,
  pdfTextExtractionProvider,
  documentSummaryProvider,
  openAIClassSummaryProvider,
  openAIRecoverySummaryProvider,
  openAIClassReportProvider,
  openAIFinalQuizProvider,
};
