const fs = require('fs/promises');
const path = require('path');
const meetingRepository = require('../repositories/meetingRepository');
const userRepository = require('../repositories/userRepository');
const documentRepository = require('../repositories/documentRepository');
const roleService = require('./roleService');
const documentAnalysisService = require('./documentAnalysisService');
const documentAnalysisCache = require('./documentAnalysisCache');
const { UPLOAD_DIR, assertValidDocumentContent } = require('../utils/uploadStorage');

// Reglas de negocio de la carga de documentos del docente — mismo criterio
// que `questionService.js`: la autorización ("¿es de verdad el docente de
// esta reunión?") se resuelve acá, contra `participations` (vía
// `roleService.getRole`), nunca confiando en un "soy docente" declarado
// por el cliente.

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Best-effort — si no se puede borrar un archivo del disco, el problema
// real (el que está disparando esta limpieza) ya se le devolvió a quien
// llamó; no tiene sentido taparlo con un error de limpieza de disco.
async function cleanupFile(filePath) {
  await fs.unlink(filePath).catch((err) => {
    if (err.code === 'ENOENT') return; // ya no estaba — nada que limpiar
    console.error('[Sparkle] No se pudo borrar un archivo de documentos:', err.message);
  });
}

// `analysis` viaja como `null` salvo que el análisis haya terminado OK
// (`analysis_result` solo se completa en `documentAnalysisRepository.
// markProcessed`) — a diferencia de otros drivers, `mysql2` NO deserializa
// una columna JSON a un objeto JS por sí solo (confirmado: devuelve el
// TEXTO crudo tal cual está guardado), así que hace falta un `JSON.parse`
// explícito acá. `analysisError` viaja igual, `null` salvo que
// `analysis_status === 'failed'`.
function toDocumentPayload(row) {
  return {
    id: row.id,
    fileName: row.original_name,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    uploadedAt: row.uploaded_at,
    analysisStatus: row.analysis_status,
    analysis: row.analysis_result ? JSON.parse(row.analysis_result) : null,
    analysisError: row.analysis_error || null,
  };
}

// Registra la metadata de un documento YA escrito en disco (multer lo
// procesó — validó tipo y tamaño — antes de llegar acá, ver
// `routes/meetings.js` y `utils/uploadStorage.js`) y decide si de verdad
// corresponde persistirlo. Como mucho un documento vigente por reunión
// (`uq_files_meeting`, ver `scripts/init-db.js`): si ya había uno, esta
// carga lo REEMPLAZA — se borra el archivo físico VIEJO del disco recién
// después de que el reemplazo en la base se confirma. Si CUALQUIER paso de
// acá en más falla (no es el docente de esta reunión, la reunión no
// existe, la escritura en la base falla), el archivo NUEVO se borra del
// disco antes de propagar el error — nunca debe quedar un archivo en
// `uploads/` sin una fila en `files` que lo describa.
async function saveTeacherDocument({ meetingCode, email, file }) {
  try {
    // Chequeo de CONTENIDO (no solo extensión/mimetype declarados, que ya
    // validó `fileFilter` en `utils/uploadStorage.js`) — antes de gastar
    // ninguna consulta a la base, ver el comentario de
    // `assertValidDocumentContent` para el porqué completo.
    await assertValidDocumentContent(file);

    const { role } = await roleService.getRole(meetingCode, email);
    if (role !== 'teacher') {
      throw httpError(403, 'Solo el docente de esta clase puede cargar documentos.');
    }

    const normalizedMeetingCode = meetingCode.trim().toLowerCase();
    const meetingId = await meetingRepository.getMeetingIdByCode(normalizedMeetingCode);
    if (!meetingId) {
      throw httpError(404, 'La reunión no existe.');
    }

    // Ya sabemos que hay una fila de docente para este email en esta
    // reunión (el chequeo de arriba), así que el usuario tiene que existir
    // — se resuelve igual por las dudas, en vez de asumirlo.
    const userId = await userRepository.getUserIdByEmail(email.trim().toLowerCase());
    if (!userId) {
      throw httpError(403, 'Solo el docente de esta clase puede cargar documentos.');
    }

    const previous = await documentRepository.getDocumentForMeeting(meetingId);

    await documentRepository.upsertDocument({
      meetingId,
      uploadedBy: userId,
      originalName: file.originalname,
      storedName: file.filename,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    });

    if (previous && previous.stored_name !== file.filename) {
      await cleanupFile(path.join(UPLOAD_DIR, previous.stored_name));
    }

    // El resumen cacheado (si lo había) corresponde al documento VIEJO —
    // sea que este upsert haya reemplazado un documento anterior o que sea
    // la primera carga de la reunión (en cuyo caso esto es un no-op
    // inofensivo, ver `documentAnalysisCache.invalidate`), nunca debe
    // quedar un resumen colgando en memoria para un archivo que ya no es
    // el vigente.
    documentAnalysisCache.invalidate(meetingId);

    const saved = await documentRepository.getDocumentForMeeting(meetingId);

    // Fire-and-forget A PROPÓSITO — no se espera al análisis para
    // responder la carga (ver `services/documentAnalysisService.js`).
    // `analyzeDocument` ya atrapa sus propios errores y los persiste como
    // `analysis_status = 'failed'`, así que este `.catch` es una red de
    // seguridad extra, no el camino esperado — solo cubre un fallo
    // ANTES de esa protección interna (ej. la propia transición atómica a
    // 'processing' no pudo escribir en la base).
    documentAnalysisService.analyzeDocument(saved).catch((err) => {
      console.error(`[Sparkle][IA] Error inesperado disparando el análisis del documento ${saved.id}:`, err.message);
    });

    return toDocumentPayload(saved);
  } catch (err) {
    await cleanupFile(file.path);
    throw err;
  }
}

// Documento vigente de una reunión — SOLO para el docente de esa reunión
// (mismo chequeo de autorización que `questionService.
// getFinishedQuestionsForMeeting`). `null` si todavía no cargó ninguno —
// nunca un error, es un estado válido. La usa `GET /:meetingCode/documents`
// para que el panel del docente recupere el documento ya cargado al volver
// a abrirse o al recargar la extensión (el estado de React no sobrevive
// ninguno de los dos).
async function getCurrentDocument(meetingCode, email) {
  const { role } = await roleService.getRole(meetingCode, email);
  if (role !== 'teacher') {
    throw httpError(403, 'Solo el docente de esta clase puede consultar el documento cargado.');
  }

  const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode.trim().toLowerCase());
  if (!meetingId) return null;

  const row = await documentRepository.getDocumentForMeeting(meetingId);
  return row ? toDocumentPayload(row) : null;
}

// Sin autenticar por email a propósito — la usa `ws/handlers.js` justo
// antes de arrancar la clase, donde el socket que manda "start_class" YA
// pasó por el chequeo de rol "teacher" de esta reunión al unirse (ver
// `handleStartClass`); acá solo hace falta saber si el documento está
// LISTO, no volver a validar quién pregunta.
//
// Requisito de producto — no alcanza con "existe un documento": tiene que
// haber terminado de analizarse OK (`analysis_status === 'processed'`).
// Mientras esté en 'uploaded'/'processing' (o haya terminado en 'failed'),
// la clase no puede arrancar — mismo criterio que ya aplica
// `hooks/useDocumentUpload.js` del lado del cliente para habilitar
// "Comenzar Clase".
async function isDocumentReadyForMeeting(meetingCode) {
  const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode.trim().toLowerCase());
  if (!meetingId) return false;
  const row = await documentRepository.getDocumentForMeeting(meetingId);
  return Boolean(row) && row.analysis_status === 'processed';
}

module.exports = { saveTeacherDocument, getCurrentDocument, isDocumentReadyForMeeting };
