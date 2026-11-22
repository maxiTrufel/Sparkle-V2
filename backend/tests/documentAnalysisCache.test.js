// Tests del caché en memoria del resultado de análisis
// (`src/services/documentAnalysisCache.js`) — sin servidor HTTP/WS: se
// prueba directo contra los services/repositories, con base de datos real
// (requiere `npm run init-db` corrido antes, igual que el resto de
// `backend/tests/`). El paso de extracción se MOCKEA (mismo mecanismo que
// `documentAnalysis.test.js`: se reemplaza el método de la instancia real
// que exporta `../src/providers`) para poblar un análisis 'processed' sin
// necesitar un PDF real ni gastar saldo de OpenAI — el resumen con IA
// queda apagado (default) en todo este archivo, así que solo importa el
// paso de extracción.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const pool = require('../src/db');
const { pdfTextExtractionProvider, documentSummaryProvider } = require('../src/providers');
const documentAnalysisCache = require('../src/services/documentAnalysisCache');
const documentAnalysisService = require('../src/services/documentAnalysisService');
const documentService = require('../src/services/documentService');
const documentRepository = require('../src/repositories/documentRepository');
const meetingRepository = require('../src/repositories/meetingRepository');
const roleService = require('../src/services/roleService');

let originalExtractText;
let originalSummarize;
// Dentro del repo (no `os.tmpdir()`, mismo criterio que
// `documentUpload.test.js`) — evita depender de permisos de escritura fuera
// del proyecto en entornos de CI/sandbox restringidos.
const TMP_DIR = path.join(__dirname, `.tmp-${process.pid}`);

test.before(async () => {
  originalExtractText = pdfTextExtractionProvider.extractText.bind(pdfTextExtractionProvider);
  originalSummarize = documentSummaryProvider.summarize.bind(documentSummaryProvider);
  await fs.mkdir(TMP_DIR, { recursive: true });
});

test.after(async () => {
  pdfTextExtractionProvider.extractText = originalExtractText;
  documentSummaryProvider.summarize = originalSummarize;
  await fs.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await pool.end();
});

function newMeetingCode() {
  const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `${letters(3)}-${letters(4)}-${letters(3)}`;
}

async function cleanupMeeting(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

// Carga un documento SIN pasar por multer/HTTP — llama directo a
// `documentService.saveTeacherDocument` con un archivo "multer-like" falso
// (mismo shape que arma `utils/uploadStorage.js`), así se ejercita el
// disparo REAL del análisis (y, con él, el `documentAnalysisCache.
// invalidate`/`.set` agregados en esta etapa) en vez de sembrar la fila
// directo por SQL. `file.path` SÍ necesita existir y apuntar a contenido
// válido (firma "%PDF-" + tamaño mínimo): `saveTeacherDocument` ahora lo lee
// para confirmar que es un documento real ANTES de tocar la base (ver
// `utils/uploadStorage.js`, `assertValidDocumentContent`) — el paso de
// extracción sigue mockeado, así que nunca se abre el PDF de verdad.
async function cargarDocumento(meetingCode, email, { fileName = 'material.pdf' } = {}) {
  await roleService.registerRole({ meetingCode, email, role: 'teacher' });
  const sufijo = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const filePath = path.join(TMP_DIR, `${fileName}-${sufijo}`);
  await fs.writeFile(filePath, `%PDF-1.4 contenido de prueba de sobra para superar el tamaño mínimo válido ${'x'.repeat(60)}`);
  return documentService.saveTeacherDocument({
    meetingCode,
    email,
    file: {
      originalname: fileName,
      filename: `${fileName}-${sufijo}`,
      mimetype: 'application/pdf',
      size: 1024,
      path: filePath,
    },
  });
}

async function esperarAnalisisTerminado(meetingId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let row;
  while (Date.now() < deadline) {
    row = await documentRepository.getDocumentForMeeting(meetingId);
    if (row?.analysis_status === 'processed' || row?.analysis_status === 'failed') return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`El análisis no terminó dentro de ${timeoutMs}ms. Fila: ${JSON.stringify(row)}`);
}

// Solo `extractedText`/`pageCount`/`charCount` — son los ÚNICOS campos que
// `documentAnalysisService.analyzeDocument` toma del paso de extracción
// (ver ese archivo); cualquier otro campo que se agregue acá se
// descartaría en silencio, así que no tiene sentido simular más que esto.
function extraccionFalsa(overrides = {}) {
  return {
    extractedText: 'Texto de prueba',
    pageCount: 1,
    charCount: 16,
    ...overrides,
  };
}

test('primitivas del Map — get/set/invalidate en aislamiento (sin base de datos)', () => {
  const meetingIdFicticio = -1; // no toca la base -- esto es puramente el Map
  assert.equal(documentAnalysisCache.get(meetingIdFicticio), undefined, 'No debería haber nada cacheado para un id nunca usado.');

  const valor = { extractedText: 'x' };
  documentAnalysisCache.set(meetingIdFicticio, valor);
  assert.equal(documentAnalysisCache.get(meetingIdFicticio), valor);

  documentAnalysisCache.invalidate(meetingIdFicticio);
  assert.equal(documentAnalysisCache.get(meetingIdFicticio), undefined, 'Debería haberse borrado tras invalidate.');

  // invalidate sobre una clave que NUNCA se cacheó no debería tirar error.
  assert.doesNotThrow(() => documentAnalysisCache.invalidate(-2));
});

test('cache MISS — getAnalysisSummary lee de MySQL y deja la caché poblada', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-cache-miss@test.com';
  const extraccion = extraccionFalsa({ extractedText: 'Documento de prueba' });
  pdfTextExtractionProvider.extractText = async () => extraccion;

  try {
    await cargarDocumento(meetingCode, email);
    const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
    const row = await esperarAnalisisTerminado(meetingId);
    assert.equal(row.analysis_status, 'processed');

    // `analyzeDocument` ya deja la caché poblada al terminar (ver
    // `documentAnalysisService.js`) — se limpia acá a mano para
    // garantizar que ESTE assert prueba de verdad el camino de cache
    // MISS (leer de MySQL), no el de "ya estaba cacheada".
    documentAnalysisCache.invalidate(meetingId);
    assert.equal(documentAnalysisCache.get(meetingId), undefined, 'Precondición: no debería haber nada cacheado.');

    const result = await documentAnalysisService.getAnalysisSummary(meetingId);
    assert.deepEqual(result, extraccion);
    assert.deepEqual(documentAnalysisCache.get(meetingId), extraccion, 'Debería haber quedado cacheado tras el miss.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('cache HIT — una segunda consulta NO vuelve a leer MySQL (devuelve el valor cacheado aunque la fila cambie)', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-cache-hit@test.com';
  const extraccion = extraccionFalsa({ extractedText: 'Original' });
  pdfTextExtractionProvider.extractText = async () => extraccion;

  try {
    await cargarDocumento(meetingCode, email);
    const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
    await esperarAnalisisTerminado(meetingId);

    const first = await documentAnalysisService.getAnalysisSummary(meetingId);
    assert.deepEqual(first, extraccion);

    // Se pisa la fila en MySQL DIRECTO, sin pasar por la caché — si el
    // segundo `getAnalysisSummary` volviera a leer la base, vería este
    // valor nuevo. Que devuelva el viejo es la prueba de que sirvió del
    // Map, no de una lectura fresca.
    await pool.query('UPDATE files SET analysis_result = ? WHERE meeting_id = ?', [
      JSON.stringify(extraccionFalsa({ extractedText: 'MUTADO EN LA BASE, NO DEBERÍA VERSE' })),
      meetingId,
    ]);

    const second = await documentAnalysisService.getAnalysisSummary(meetingId);
    assert.deepEqual(second, extraccion, 'Debería devolver el valor CACHEADO, no el que se acaba de mutar en MySQL.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('invalidación + repoblado — tras invalidar, la siguiente consulta vuelve a leer MySQL con el valor actualizado', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-cache-repoblado@test.com';
  const extraccionVieja = extraccionFalsa({ extractedText: 'Viejo' });
  pdfTextExtractionProvider.extractText = async () => extraccionVieja;

  try {
    await cargarDocumento(meetingCode, email);
    const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
    await esperarAnalisisTerminado(meetingId);
    await documentAnalysisService.getAnalysisSummary(meetingId); // deja cacheado "Viejo"

    const extraccionNueva = extraccionFalsa({ extractedText: 'Nuevo (actualizado directo en MySQL)' });
    await pool.query('UPDATE files SET analysis_result = ? WHERE meeting_id = ?', [JSON.stringify(extraccionNueva), meetingId]);

    documentAnalysisCache.invalidate(meetingId);
    const result = await documentAnalysisService.getAnalysisSummary(meetingId);
    assert.deepEqual(result, extraccionNueva, 'Tras invalidar, debería repoblarse con el valor ACTUAL de MySQL.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('reemplazar el documento invalida la entrada vieja de inmediato, y la nueva consulta refleja el análisis del documento nuevo', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-cache-reemplazo@test.com';
  const extraccionA = extraccionFalsa({ extractedText: 'Documento viejo' });
  const extraccionB = extraccionFalsa({ extractedText: 'Documento nuevo' });
  let respuestaMock = extraccionA;
  pdfTextExtractionProvider.extractText = async () => respuestaMock;

  try {
    await cargarDocumento(meetingCode, email, { fileName: 'viejo.pdf' });
    const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
    await esperarAnalisisTerminado(meetingId);

    const cachedA = await documentAnalysisService.getAnalysisSummary(meetingId);
    assert.deepEqual(cachedA, extraccionA);

    respuestaMock = extraccionB;
    await cargarDocumento(meetingCode, email, { fileName: 'nuevo.pdf' });

    // `documentService.saveTeacherDocument` invalida la caché ANTES de
    // disparar el análisis nuevo (fire-and-forget) — en este punto exacto
    // el análisis nuevo puede no haber terminado todavía, pero la entrada
    // VIEJA ya no debería estar. Probar esto acá (no solo el resultado
    // final) es lo que distingue "el reemplazo invalida" de "el análisis
    // nuevo eventualmente sobreescribe" — ambas dejan el mismo resultado
    // final, pero son garantías distintas.
    assert.equal(
      documentAnalysisCache.get(meetingId),
      undefined,
      'Cargar un documento nuevo debería invalidar la entrada vieja de inmediato, sin esperar el análisis nuevo.'
    );

    await esperarAnalisisTerminado(meetingId);
    const cachedB = await documentAnalysisService.getAnalysisSummary(meetingId);
    assert.deepEqual(cachedB, extraccionB, 'Debería reflejar el resumen del documento NUEVO, nunca el del reemplazado.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

// Con el resumen con IA ACTIVO — a diferencia de todos los tests de
// arriba (flag apagado, default), acá se confirma que `mainTopics`/
// `keyConcepts` (el resumen) se persisten en MySQL JUNTO CON
// `extractedText`/`pageCount`/`charCount` (la extracción), en la MISMA
// columna `analysis_result`, y que `getAnalysisSummary` — la función
// pensada para la futura generación de preguntas con IA, ver el
// comentario de `documentAnalysisService.js` — los devuelve completos al
// leerlos de vuelta. Se lee la fila de MySQL DIRECTO (sin pasar por la
// caché ni por `getAnalysisSummary`) para confirmar que lo persistido de
// verdad incluye ambos, no solo lo que devuelve la capa de caché.
test('con el resumen con IA activo, mainTopics/keyConcepts se guardan en MySQL junto con extractedText/pageCount/charCount, y se pueden releer completos por documento', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-cache-resumen-ia@test.com';
  const extraccion = extraccionFalsa({ extractedText: 'Texto completo extraído del PDF de prueba.' });
  const resumen = {
    mainTopics: ['Período Jurásico', 'Extinción del Cretácico'],
    keyConcepts: [{ term: 'Asteroide de Chicxulub', definition: 'Impacto asociado a la extinción masiva del Cretácico.' }],
    model: 'gpt-4o-mini-mock',
    inputTokens: 321,
    outputTokens: 44,
  };
  pdfTextExtractionProvider.extractText = async () => extraccion;
  documentSummaryProvider.summarize = async () => resumen;

  const previousFlag = process.env.ENABLE_AI_DOCUMENT_ANALYSIS;
  process.env.ENABLE_AI_DOCUMENT_ANALYSIS = 'true';

  try {
    await cargarDocumento(meetingCode, email);
    const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
    await esperarAnalisisTerminado(meetingId);

    // 1) Lo que quedó de verdad en MySQL (columna `analysis_result`),
    // leído directo, sin pasar por ningún caché. `model`/`inputTokens`/
    // `outputTokens` que devuelve el proveedor (mock `resumen` de arriba)
    // ya no se persisten en ninguna columna — son metadata técnica de la
    // llamada a OpenAI, no contenido del análisis (ver
    // `documentAnalysisRepository.markProcessed`).
    const [rows] = await pool.query('SELECT analysis_result FROM files WHERE meeting_id = ?', [
      meetingId,
    ]);
    const persisted = JSON.parse(rows[0].analysis_result);
    assert.equal(persisted.extractedText, extraccion.extractedText);
    assert.equal(persisted.pageCount, extraccion.pageCount);
    assert.equal(persisted.charCount, extraccion.charCount);
    assert.deepEqual(persisted.mainTopics, resumen.mainTopics);
    assert.deepEqual(persisted.keyConcepts, resumen.keyConcepts);

    // 2) La función pensada para la futura generación de preguntas —
    // invalidando la caché primero, para confirmar que también LEE bien
    // de MySQL (no solo sirve lo que ya tenía en memoria).
    documentAnalysisCache.invalidate(meetingId);
    const summaryForQuestions = await documentAnalysisService.getAnalysisSummary(meetingId);
    assert.deepEqual(summaryForQuestions, {
      extractedText: extraccion.extractedText,
      pageCount: extraccion.pageCount,
      charCount: extraccion.charCount,
      mainTopics: resumen.mainTopics,
      keyConcepts: resumen.keyConcepts,
    });
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_AI_DOCUMENT_ANALYSIS;
    else process.env.ENABLE_AI_DOCUMENT_ANALYSIS = previousFlag;
    await cleanupMeeting(meetingCode);
  }
});
