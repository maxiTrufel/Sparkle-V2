const pool = require('../db');

// Acceso a datos del análisis de documentos — vive sobre la MISMA fila de
// `files` que `documentRepository.js` (ver `scripts/init-db.js`), pero
// separado en su propio archivo porque es un momento distinto del ciclo de
// vida del documento (estado de análisis, no metadata de carga) con su
// propio consumidor (`services/documentAnalysisService.js`).

// Transición atómica 'uploaded' → 'processing' — es la garantía, A NIVEL
// DE BASE, de que un documento se analiza UNA SOLA VEZ: el `WHERE
// analysis_status = 'uploaded'` hace que una segunda llamada para el MISMO
// documento (ej. un reintento tras un reinicio del backend a mitad de
// análisis, o una carrera) no afecte ninguna fila la segunda vez.
// `affectedRows > 0` es cómo `documentAnalysisService` sabe si ESTA
// llamada fue la que de verdad arrancó el análisis — la garantía no
// depende de que el llamador nunca invoque esto dos veces.
async function markProcessing(documentId) {
  const [result] = await pool.query(
    `UPDATE files SET analysis_status = 'processing', analysis_started_at = NOW()
     WHERE id = ? AND analysis_status = 'uploaded'`,
    [documentId]
  );
  return result.affectedRows > 0;
}

// `result` es el objeto JSON completo (título, resumen, temas, conceptos,
// objetivos, términos, contenido visual) tal cual lo devolvió el proveedor
// — se guarda serializado en la columna `analysis_result` (JSON nativo de
// MySQL). `analysis_error` se limpia a propósito: si un documento se
// reemplaza y se vuelve a analizar, no debe quedar un error viejo
// conviviendo con un resultado nuevo exitoso.
//
// `model`/`inputTokens`/`outputTokens` que devuelve el proveedor (ver
// `services/documentAnalysisService.js`) ya NO se persisten acá — eran
// metadata técnica de la llamada a OpenAI (qué modelo, cuántos tokens), no
// contenido del análisis en sí (eliminadas las columnas correspondientes,
// ver `scripts/init-db.js`).
async function markProcessed(documentId, { result }) {
  await pool.query(
    `UPDATE files SET
       analysis_status = 'processed',
       analysis_result = ?,
       analysis_error = NULL,
       analysis_finished_at = NOW()
     WHERE id = ?`,
    [JSON.stringify(result), documentId]
  );
}

async function markFailed(documentId, { error }) {
  await pool.query(
    `UPDATE files SET
       analysis_status = 'failed',
       analysis_error = ?,
       analysis_finished_at = NOW()
     WHERE id = ?`,
    [error, documentId]
  );
}

module.exports = { markProcessing, markProcessed, markFailed };
