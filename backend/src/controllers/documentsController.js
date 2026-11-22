const fs = require('fs/promises');
const documentService = require('../services/documentService');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Multer (ver `routes/meetings.js`) ya corrió antes de este controller:
// `req.file` es el archivo YA escrito en la carpeta privada (o no existe,
// si no se mandó ninguno), `req.body` trae el resto de los campos del
// form-data. Acá solo se valida la FORMA del request — la autorización
// real (¿es el docente de esta reunión?) vive en `documentService`.
async function uploadDocument(req, res) {
  const { meetingCode } = req.params;
  const { email } = req.body || {};

  if (!isNonEmptyString(email) || !req.file) {
    // El archivo puede haber quedado escrito en disco aunque falte el
    // email (multer no depende de qué otros campos vengan) — se limpia
    // acá para no dejar un huérfano, mismo criterio que `documentService`.
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    if (!isNonEmptyString(email)) {
      return res.status(400).json({ error: 'Falta el parámetro "email" en el body de la request.' });
    }
    return res.status(400).json({ error: 'Falta el archivo a cargar.' });
  }

  try {
    const document = await documentService.saveTeacherDocument({ meetingCode, email, file: req.file });
    return res.status(201).json({ message: 'Documento cargado correctamente.', document });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error cargando un documento:', err.message);
    return res.status(500).json({ error: 'Error interno cargando el documento.' });
  }
}

// Documento vigente de una reunión — usado por el panel del docente para
// recuperar el estado ("¿ya hay un archivo cargado?") al abrirse o al
// recargar la extensión, ya que el estado de React no sobrevive ninguno de
// los dos casos. `document` viaja en `null` (nunca un error) cuando
// todavía no se cargó nada — la autorización real (¿es el docente de esta
// reunión?) vive en `documentService`.
async function getCurrentDocument(req, res) {
  const { meetingCode } = req.params;
  const { email } = req.query;

  if (!isNonEmptyString(email)) {
    return res.status(400).json({ error: 'Falta el parámetro "email" en la query string.' });
  }

  try {
    const document = await documentService.getCurrentDocument(meetingCode, email);
    return res.status(200).json({ document });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Sparkle] Error consultando el documento cargado:', err.message);
    return res.status(500).json({ error: 'Error interno consultando el documento cargado.' });
  }
}

module.exports = { uploadDocument, getCurrentDocument };
