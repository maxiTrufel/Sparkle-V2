const path = require('path');
const documentAnalysisRepository = require('../repositories/documentAnalysisRepository');
const documentRepository = require('../repositories/documentRepository');
const documentAnalysisCache = require('./documentAnalysisCache');
const { pdfTextExtractionProvider, documentSummaryProvider } = require('../providers');
const { UPLOAD_DIR } = require('../utils/uploadStorage');

// Orquesta el procesamiento de un documento YA guardado en disco y en la
// base (`files`, ver `scripts/init-db.js`) — un pipeline de DOS PASOS EN
// SECUENCIA, nunca importa el SDK de OpenAI directo (esa integración vive
// aislada en `providers/openAIDocumentAnalysisProvider.js`):
//
//   1. Extracción de texto plano del PDF (`pdfTextExtractionProvider`) —
//      SIEMPRE, sin condicionar a ningún flag.
//   2. Resumen con IA a partir de ESE TEXTO (`documentSummaryProvider`) —
//      OPCIONAL, solo si `ENABLE_AI_DOCUMENT_ANALYSIS === 'true'`.
//
// `document` es la fila de `files` tal cual la devuelve
// `documentRepository.getDocumentForMeeting` — se recibe completa (no solo
// el id) porque quien llama (`documentService.saveTeacherDocument`) ya la
// tiene en mano tras el upsert, evitando una consulta redundante.
//
// Fire-and-forget A PROPÓSITO: quien llama no espera a que esto termine —
// el docente ve la carga confirmada (201) sin esperar el round-trip a
// OpenAI; el panel se entera del resultado consultando el estado por
// separado (`GET /:meetingCode/documents`, con polling del lado del
// cliente mientras el estado no sea terminal — ver
// `frontend/src/hooks/useDocumentUpload.js`).
// Todo el cuerpo vive adentro de un único try/catch, incluida la propia
// transición atómica de arranque — esta función NUNCA rechaza (siempre
// resuelve `undefined`), a propósito: se invoca fire-and-forget desde
// `documentService.saveTeacherDocument` (sin `await`), así que un reject
// acá terminaría como una promise rejection no manejada. Cualquier fallo,
// sea de la transición inicial, de cualquiera de los dos pasos, o de
// guardar el resultado, se loguea y (si ya se alcanzó a marcar
// 'processing') se persiste como `analysis_status = 'failed'`.
async function analyzeDocument(document) {
  let started = false;
  try {
    // Transición atómica — ver el comentario de `markProcessing` en el
    // repositorio: si esto devuelve `false`, alguna otra llamada YA está
    // procesando (o ya procesó) este documento puntual, así que no se hace
    // nada más acá. Ésta es la garantía real de "se procesa una sola vez"
    // — no depende de que el código que llama a esta función nunca la
    // invoque dos veces para el mismo documento.
    started = await documentAnalysisRepository.markProcessing(document.id);
    if (!started) return;

    const filePath = path.join(UPLOAD_DIR, document.stored_name);

    // Paso 1 — SIEMPRE: extracción de texto plano, recorriendo todas las
    // páginas del PDF (ver `providers/pdfTextExtractionProvider.js`). Es
    // la base del resultado final, tanto si el resumen con IA está
    // activo como si no.
    const { extractedText, pageCount, charCount } = await pdfTextExtractionProvider.extractText({ filePath });

    // Paso 2 — OPCIONAL: resumen con IA a partir del TEXTO YA EXTRAÍDO
    // (nunca vuelve a abrir el PDF, ver `providers/
    // openAIDocumentAnalysisProvider.js#summarize`). El flag se lee ACÁ,
    // a CALL-TIME (no una vez al cargar el módulo en `providers/index.js`)
    // para poder prenderlo/apagarlo sin reiniciar el proceso.
    const aiSummaryEnabled = process.env.ENABLE_AI_DOCUMENT_ANALYSIS === 'true';

    // `model`/`inputTokens`/`outputTokens` que devuelve el proveedor son
    // metadata técnica de la llamada a OpenAI — ya no se persiste (ver
    // `documentAnalysisRepository.markProcessed`), así que se descartan acá
    // mismo (se destructuran fuera de `summaryFields` a propósito, para que
    // no terminen colándose en `analysis_result` vía el spread de abajo).
    // `model` se conserva solo para el log de esta función.
    let model = null;
    let summaryFields = {};

    if (aiSummaryEnabled) {
      // El resumen es un paso OPCIONAL que corre DESPUÉS del que de verdad
      // sostiene el panel hoy (la extracción, paso 1, ya resuelta arriba)
      // — si falla (cuota de OpenAI, red, JSON inválido devuelto por el
      // modelo, lo que sea), el docente igual tiene que poder seguir
      // inspeccionando el texto YA EXTRAÍDO. Por eso este paso tiene su
      // PROPIO try/catch, en vez de dejar que un error acá tire todo el
      // resultado a la basura (marcando 'failed' un documento cuyo texto
      // sí se extrajo bien) — mismo criterio pedido explícitamente: "en
      // ambos casos [flag prendido o apagado] el panel sigue mostrando el
      // texto extraído".
      try {
        const summarized = await documentSummaryProvider.summarize(extractedText, {
          originalName: document.original_name,
        });
        // eslint-disable-next-line no-unused-vars -- se descartan a propósito, ver el comentario de arriba.
        const { model: summarizedModel, inputTokens, outputTokens, ...rest } = summarized;
        model = summarizedModel;
        summaryFields = rest;
      } catch (err) {
        console.error(
          `[Sparkle][IA] El resumen con IA falló para el documento ${document.id} — se guarda igual con el texto ` +
            `ya extraído, sin resumen:`,
          err.message
        );
      }
    }

    // El resultado SIEMPRE incluye extractedText/pageCount/charCount — los
    // campos del resumen (hoy: mainTopics/keyConcepts, ver el contrato
    // genérico de `providers/documentSummaryProvider.js`) se suman
    // encima solo cuando el flag está activo, sin listar sus nombres acá:
    // si mañana cambia el proveedor de resumen, este archivo no se toca.
    const analysisSummary = { extractedText, pageCount, charCount, ...summaryFields };

    await documentAnalysisRepository.markProcessed(document.id, { result: analysisSummary });

    // Actualiza la caché en memoria con el resultado FRESCO — evita que la
    // primera consulta de la futura generación de preguntas para esta
    // reunión sea un cache miss innecesario justo después de terminar de
    // procesar (ver `documentAnalysisCache.js`). MySQL ya tiene el mismo
    // valor (recién guardado arriba); esto solo adelanta la caché para no
    // depender de que alguien la repueble con una lectura de más.
    documentAnalysisCache.set(document.meeting_id, analysisSummary);

    // Basado en si el resumen SALIÓ BIEN (`model` solo se completa si
    // `summarize` resolvió), no en si el flag estaba prendido — con el
    // flag prendido pero el resumen fallando (ver el `catch` de arriba),
    // el resultado es el mismo que con el flag apagado, y el log tiene
    // que decir eso, no aparentar que sí hubo resumen.
    console.log(
      `[Sparkle][IA] Documento ${document.id} procesado OK` +
        (model ? ` (texto extraído + resumen con modelo="${model}").` : ' (solo texto extraído, sin resumen con IA).')
    );
  } catch (err) {
    console.error(`[Sparkle][IA] Error procesando el documento ${document.id}:`, err.message);
    if (!started) return; // la transición ni siquiera llegó a confirmarse — nada que marcar "failed"
    await documentAnalysisRepository.markFailed(document.id, { error: err.message }).catch((cleanupErr) => {
      console.error(
        `[Sparkle][IA] Además, no se pudo guardar el estado "failed" del documento ${document.id}:`,
        cleanupErr.message
      );
    });
  }
}

// Acceso CACHEADO al resultado de análisis de una reunión — pensado para la
// futura generación de preguntas con IA (todavía no implementada): en vez
// de leer `files.analysis_result` de MySQL en cada pregunta generada,
// primero consulta la caché en memoria (`documentAnalysisCache.js`); solo
// si no está ahí (cache miss — primer pedido de esta reunión, o backend
// recién reiniciado) lee la base, la parsea y la deja cacheada para los
// pedidos siguientes de la MISMA reunión.
//
// Devuelve `null` (sin cachear ese `null`) si todavía no hay un análisis
// 'processed' para completar — es un estado transitorio válido (el
// análisis puede seguir en curso), no tiene sentido cachear "todavía no
// hay nada" de forma indefinida: en cuanto `analyzeDocument` termine OK,
// deja la caché poblada por su cuenta (ver más arriba), sin que nadie
// tenga que volver a llamar acá para que dejen de verse desactualizados.
async function getAnalysisSummary(meetingId) {
  const cached = documentAnalysisCache.get(meetingId);
  if (cached) return cached;

  const document = await documentRepository.getDocumentForMeeting(meetingId);
  if (!document || document.analysis_status !== 'processed' || !document.analysis_result) {
    return null;
  }

  const analysisSummary = JSON.parse(document.analysis_result);
  documentAnalysisCache.set(meetingId, analysisSummary);
  return analysisSummary;
}

module.exports = { analyzeDocument, getAnalysisSummary };
