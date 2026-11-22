const express = require('express');
const controller = require('../controllers/meetingsController');
const vexaService = require('../services/vexaService');
const documentsController = require('../controllers/documentsController');
const { upload, MAX_FILE_SIZE_BYTES } = require('../utils/uploadStorage');

// Capa de rutas: solo declara el mapeo verbo+path → función del controller.
// Sin validación, sin SQL, sin reglas de negocio — eso vive en
// `controllers/meetingsController.js` y las capas de abajo.
const router = express.Router();

router.post('/register-role', controller.registerRole);
router.get('/has-teacher', controller.getHasTeacher);
router.get('/role', controller.getRole);
router.post('/register-student', controller.registerStudent);
router.get('/history', controller.getHistory);
router.post('/camera', controller.updateCamera);
router.get('/camera', controller.getCamera);
// POST (no GET) a propósito — sigue siendo una vista previa SIN
// persistencia (ver `questionService.generatePreview`), pero desde que
// acepta `discardedPrompts` (el frontend manda los enunciados de los
// previews ya descartados en esta tanda, para que la IA no repita tema)
// el payload es un array de texto arbitrario que puede crecer bastante —
// no encaja bien en query string (límites de longitud de URL, escapes),
// y de paso el verbo queda más honesto: este endpoint SIEMPRE tiene un
// efecto secundario real y con costo (llama a OpenAI con el flag activo).
router.post('/generate-question', controller.generateQuestion);
router.get('/questions/history', controller.getQuestionsHistory);
router.get('/questions/my-answers', controller.getMyQuestionAnswers);
router.get('/questions/student-stats', controller.getStudentStats);

// Carga de documentos (PDF) del docente para una reunión puntual —
// multipart/form-data con un campo "file" y un campo "email" (docente
// autenticado). `upload.single('file')` (multer, ver
// `utils/uploadStorage.js`) valida tipo y tamaño ANTES de que el archivo
// termine de escribirse en la carpeta privada del backend — se envuelve a
// mano (en vez de pasarlo directo como middleware) para traducir sus
// errores a JSON: por defecto, un error de multer cae al manejador de
// errores genérico de Express, que no devuelve JSON. La autorización real
// (¿es el docente de esta reunión?) y el registro en la base viven en
// `documentsController`/`services/documentService.js`.
router.post('/:meetingCode/documents', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `El archivo supera el tamaño máximo permitido (${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB).`,
      });
    }
    return res.status(err.status || 400).json({ error: err.message || 'No se pudo procesar el archivo.' });
  });
}, documentsController.uploadDocument);

// Documento vigente de una reunión (o `null` si todavía no se cargó
// ninguno) — el panel del docente lo consulta al montarse para recuperar
// el estado sin depender de la sesión de React (ver
// `documentsController.getCurrentDocument`).
router.get('/:meetingCode/documents', documentsController.getCurrentDocument);

// Resumen de la clase (alumno) — "Obtener resumen de la clase" en
// `ClassSummary.jsx`. Solo disponible con la clase ya finalizada (ver
// `services/classSummaryService.getClassSummary`); UNA sola llamada a
// OpenAI por reunión gracias al caché de `services/classSummaryCache.js`,
// sin importar cuántos alumnos lo pidan.
router.get('/:meetingCode/summary', controller.getClassSummary);

// "Recuperar contenido" (alumno) — botón de la alerta de fatiga
// (`ui/FatigueAlert.jsx`), disponible EN CUALQUIER MOMENTO de la clase (a
// diferencia de `/summary` arriba): resume solo los últimos 2-3 minutos de
// transcripción, sin caché (cada pedido es personal y de ese instante, ver
// `services/recoverySummaryService.js`).
router.get('/:meetingCode/recovery-summary', controller.getRecoverySummary);

// "Quiz final" (alumno) — 3 preguntas personales con IA, solo con la clase
// ya detenida y solo para alumnos (el docente nunca lo ve). Sin caché ni
// persistencia: cada pedido genera un quiz nuevo, ver
// `services/finalQuizService.js`.
router.get('/:meetingCode/final-quiz', controller.getFinalQuiz);

// Historial de atención grupal (docente, `ConcentrationStats.jsx`) — cada
// fila es un snapshot de 10 segundos persistido por
// `backend/src/ws/attentionState.js`. Ver
// `services/attentionSnapshotService.js` para la autorización (solo el
// docente de esta reunión) y la forma exacta de cada fila devuelta.
router.get('/:meetingCode/attention-snapshots', controller.getAttentionSnapshots);

// Análisis con IA del reporte PDF de fin de clase (docente, botón
// "Descargar reporte" de `TeacherPanel.jsx`) — Sección 5 del reporte. Ver
// `services/classReportService.js` para la autorización (solo el docente
// de esta reunión) y el flag `ENABLE_AI_CLASS_REPORT`.
router.get('/:meetingCode/report/ai-analysis', controller.getClassReportAnalysis);

// Temas abordados según el documento cargado por el docente (reporte PDF
// de fin de clase, sección "Resumen de la clase") — ver
// `services/classReportService.getDocumentTopics`.
router.get('/:meetingCode/report/document-topics', controller.getReportDocumentTopics);

// Transcripción de Vexa para una reunión: trae los segmentos nuevos de
// Vexa, los persiste, y devuelve todo lo acumulado hasta ahora en orden
// cronológico. Ver `services/vexaService.js`.
router.get('/:meetingCode/transcript', async (req, res) => {
  const { meetingCode } = req.params;

  try {
    const segments = await vexaService.getTranscript(meetingCode);
    await vexaService.saveSegments(meetingCode, segments);
    const stored = await vexaService.listStoredSegments(meetingCode);
    return res.status(200).json({ segments: stored });
  } catch (err) {
    console.error('[Vexa] Error consultando la transcripción:', err.message);
    return res.status(500).json({ error: 'Error interno consultando la transcripción.' });
  }
});

module.exports = router;
