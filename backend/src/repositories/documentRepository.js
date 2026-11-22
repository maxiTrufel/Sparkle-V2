const pool = require('../db');

// Acceso a datos de la tabla `files` — sin ninguna regla de negocio acá
// (autorización, resolución de ids, qué hacer con el archivo viejo en
// disco al reemplazar, limpieza si algo falla: todo eso vive en
// `services/documentService.js`).

// Documento vigente de una reunión — a lo sumo uno, por `uq_files_meeting`
// (ver `scripts/init-db.js`). `null` si todavía no se cargó ninguno.
// Incluye las columnas de análisis (estado, error, resultado) —
// `documentService`/`documentAnalysisService` las necesitan para exponer el
// estado al frontend y para saber si ya corresponde analizar el documento.
async function getDocumentForMeeting(meetingId) {
  const [rows] = await pool.query(
    `SELECT id, meeting_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, uploaded_at,
            analysis_status, analysis_error, analysis_result, analysis_started_at, analysis_finished_at
     FROM files WHERE meeting_id = ? LIMIT 1`,
    [meetingId]
  );
  return rows[0] || null;
}

// Upsert por `meeting_id` (índice único `uq_files_meeting`): la primera
// carga de una reunión INSERTA la fila; cualquier carga posterior
// REEMPLAZA su metadata en el lugar — nunca acumula una fila por carga. El
// archivo físico VIEJO (si lo había) no se toca acá: `documentService` ya
// leyó su `stored_name` ANTES de llamar a esto, y es quien decide
// borrarlo del disco después.
//
// Las columnas de análisis se RESETEAN explícitamente a su estado inicial
// en el `ON DUPLICATE KEY UPDATE` — sin esto, reemplazar el documento
// dejaría el `analysis_result`/`analysis_status` del archivo VIEJO
// colgando sobre el archivo nuevo (ej. mostrar "processed" con el resumen
// de un PDF que ya no existe). Un documento nuevo siempre vuelve a
// arrancar en 'uploaded', sin importar en qué estado haya quedado el
// anterior.
async function upsertDocument({ meetingId, uploadedBy, originalName, storedName, mimeType, sizeBytes }) {
  await pool.query(
    `INSERT INTO files (meeting_id, uploaded_by, original_name, stored_name, mime_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       uploaded_by = VALUES(uploaded_by),
       original_name = VALUES(original_name),
       stored_name = VALUES(stored_name),
       mime_type = VALUES(mime_type),
       size_bytes = VALUES(size_bytes),
       uploaded_at = CURRENT_TIMESTAMP,
       analysis_status = 'uploaded',
       analysis_error = NULL,
       analysis_result = NULL,
       analysis_started_at = NULL,
       analysis_finished_at = NULL`,
    [meetingId, uploadedBy, originalName, storedName, mimeType, sizeBytes]
  );
}

module.exports = { getDocumentForMeeting, upsertDocument };
