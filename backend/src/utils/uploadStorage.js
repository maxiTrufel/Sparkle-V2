const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Carpeta PRIVADA del backend para los documentos que carga el docente —
// a propósito fuera de cualquier directorio servido por Express (no hay
// ningún `express.static` en `server.js`): el único acceso a estos
// archivos es a través del código del backend, nunca por URL directa.
// Se crea al cargar este módulo (no en cada request) porque `multer` con
// `diskStorage` necesita que el directorio ya exista antes de escribir —
// `mkdirSync` con `recursive: true` es un no-op silencioso si ya existe.
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'documents');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Único formato aceptado: PDF. Validado por EXTENSIÓN y por el `mimetype`
// REAL que reporta el cliente — no alcanza con ninguno de los dos por
// separado (un archivo `malware.exe` renombrado a `.pdf` pasaría la
// extensión; un cliente que mienta el mimetype pasaría ese chequeo) — el
// chequeo AUTORITATIVO de verdad son los magic bytes en
// `assertValidDocumentContent`, más abajo, que corre después sobre el
// contenido ya escrito en disco.
const ALLOWED_EXTENSIONS = new Set(['.pdf']);
const ALLOWED_MIME_TYPES = new Set(['application/pdf']);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(Object.assign(new Error('Solo se permiten archivos PDF.'), { status: 400 }));
    return;
  }
  cb(null, true);
}

// `fileFilter` de arriba solo mira EXTENSIÓN/mimetype declarados por el
// cliente — nada de eso confirma que el contenido sea de verdad un PDF (un
// archivo vacío, truncado, o directamente de otro formato renombrado a
// `.pdf`, pasa igual). Sin este chequeo, un archivo así llegaba hasta el
// análisis/extracción, que lo rechazaba recién ahí con un error opaco —
// mucho después de la carga, y sin que el docente entendiera que el
// problema era su propio archivo.
//
// Firma ("magic bytes") de un PDF: todo PDF arranca, literalmente, con los
// bytes "%PDF-".
const PDF_MAGIC = Buffer.from('%PDF-');

// Un PDF real, aunque esté prácticamente vacío, nunca pesa menos que esto —
// la propia estructura del formato (xref/trailer) ya ocupa varios cientos
// de bytes. Un archivo más chico que esto es, con certeza, basura: vacío,
// truncado, o directamente no es un documento.
const MIN_FILE_SIZE_BYTES = 100;

// Se llama DESPUÉS de que multer ya escribió el archivo en disco (`file` es
// el mismo objeto que deja `upload.single('file')`, ver `routes/meetings.js`)
// — confirma que el contenido de verdad es un PDF, no solo el nombre/mimetype
// declarados. Tira un error con `status: 400` (mismo criterio que
// `fileFilter`) si el archivo está vacío/es demasiado chico o no empieza con
// la firma "%PDF-"; quien llama (`services/documentService.js`) ya sabe
// limpiar el archivo del disco ante cualquier error de acá en más.
async function assertValidDocumentContent(file) {
  if (file.size < MIN_FILE_SIZE_BYTES) {
    throw Object.assign(
      new Error('El archivo está vacío o es demasiado chico para ser un documento válido.'),
      { status: 400 }
    );
  }

  const handle = await fs.promises.open(file.path, 'r');
  try {
    const magic = Buffer.alloc(PDF_MAGIC.length);
    await handle.read(magic, 0, PDF_MAGIC.length, 0);
    if (!magic.equals(PDF_MAGIC)) {
      throw Object.assign(
        new Error('El archivo no es un PDF válido — parece estar corrupto o dañado.'),
        { status: 400 }
      );
    }
  } finally {
    await handle.close();
  }
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, UPLOAD_DIR);
  },
  // Nombre en disco DESACOPLADO del nombre original — evita colisiones
  // entre dos docentes subiendo un archivo con el mismo nombre, y evita
  // cualquier problema de path traversal o caracteres raros en el nombre
  // que el usuario haya elegido. El nombre original se guarda aparte, en
  // la base (`files.original_name`, ver `repositories/documentRepository.js`)
  // — es el que ve el docente en el panel.
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE_BYTES } });

module.exports = { upload, UPLOAD_DIR, MAX_FILE_SIZE_BYTES, ALLOWED_EXTENSIONS, assertValidDocumentContent };
