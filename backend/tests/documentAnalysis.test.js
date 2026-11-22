// Tests de integración del pipeline de documentos — servidor Express real,
// base de datos real (requiere `npm run init-db` corrido antes), mismo
// patrón que `questions.test.js`. Los DOS pasos del pipeline (ver
// `services/documentAnalysisService.js`) se MOCKEAN reemplazando
// `pdfTextExtractionProvider.extractText`/`documentSummaryProvider.summarize`
// (las instancias reales que exporta `../src/providers`) por funciones de
// prueba antes de cada test — nunca se llama a `pdf-parse` sobre un PDF de
// verdad ni a la red real de OpenAI, así que esto corre sin gastar saldo
// real ni necesitar `OPENAI_API_KEY`.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');
const { pdfTextExtractionProvider, documentSummaryProvider } = require('../src/providers');
const documentAnalysisService = require('../src/services/documentAnalysisService');
const documentRepository = require('../src/repositories/documentRepository');
const meetingRepository = require('../src/repositories/meetingRepository');
const documentService = require('../src/services/documentService');

let server;
let apiUrl;
let originalExtractText;
let originalSummarize;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  apiUrl = `http://localhost:${port}`;

  originalExtractText = pdfTextExtractionProvider.extractText.bind(pdfTextExtractionProvider);
  originalSummarize = documentSummaryProvider.summarize.bind(documentSummaryProvider);
});

test.after(async () => {
  pdfTextExtractionProvider.extractText = originalExtractText;
  documentSummaryProvider.summarize = originalSummarize;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function newMeetingCode() {
  const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `${letters(3)}-${letters(4)}-${letters(3)}`;
}

async function registerRole(meetingCode, email, role) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role }),
  });
  return resp.json();
}

// El contenido tiene que arrancar con la firma real de un PDF ("%PDF-") y
// pesar por lo menos `MIN_FILE_SIZE_BYTES` (ver `utils/uploadStorage.js`,
// `assertValidDocumentContent`) — desde que ese chequeo existe, un fixture
// más chico se rechaza en la carga misma, antes de llegar a los providers
// mockeados que prueba este archivo.
async function uploadDocument(meetingCode, email, { fileName = 'material.pdf', mimeType = 'application/pdf' } = {}) {
  const blob = new Blob([`%PDF-1.4 contenido de prueba de sobra para superar el tamaño mínimo válido ${'x'.repeat(60)}`], { type: mimeType });
  const formData = new FormData();
  formData.append('email', email);
  formData.append('file', blob, fileName);
  const resp = await fetch(`${apiUrl}/api/meetings/${meetingCode}/documents`, { method: 'POST', body: formData });
  return { status: resp.status, body: await resp.json() };
}

async function getDocument(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const resp = await fetch(`${apiUrl}/api/meetings/${meetingCode}/documents?${params.toString()}`);
  return resp.json();
}

async function waitForAnalysisStatus(meetingCode, email, statuses, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { document } = await getDocument(meetingCode, email);
    if (document && statuses.includes(document.analysisStatus)) return document;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`El análisis no llegó a [${statuses.join(', ')}] dentro de ${timeoutMs}ms.`);
}

async function cleanupMeeting(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

const FAKE_EXTRACTION_RESULT = {
  extractedText: 'Texto de prueba extraído del PDF.',
  pageCount: 3,
  charCount: 34,
};

const FAKE_SUMMARY_RESULT = {
  mainTopics: ['Tema A', 'Tema B'],
  keyConcepts: [{ term: 'Concepto A', definition: 'Definición breve de prueba.' }],
  model: 'gpt-4o-mini-mock',
  inputTokens: 123,
  outputTokens: 45,
};

test('el documento se procesa automáticamente tras la carga y termina en "processed" con extractedText/pageCount/charCount (resumen con IA apagado, default)', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-analisis@test.com';
  let extractCallCount = 0;
  let summarizeCallCount = 0;
  pdfTextExtractionProvider.extractText = async () => {
    extractCallCount += 1;
    return FAKE_EXTRACTION_RESULT;
  };
  documentSummaryProvider.summarize = async () => {
    summarizeCallCount += 1;
    return FAKE_SUMMARY_RESULT;
  };

  await registerRole(meetingCode, email, 'teacher');

  try {
    const { status, body } = await uploadDocument(meetingCode, email);
    assert.equal(status, 201, `La carga debería confirmar 201. Body: ${JSON.stringify(body)}`);
    // Fire-and-forget — la respuesta de la carga en sí nunca debería
    // llegar ya "processed" (el procesamiento todavía no tuvo tiempo de correr).
    assert.notEqual(body.document.analysisStatus, 'processed');

    const processed = await waitForAnalysisStatus(meetingCode, email, ['processed', 'failed']);
    assert.equal(processed.analysisStatus, 'processed', `Debería terminar "processed". Doc: ${JSON.stringify(processed)}`);
    assert.equal(processed.analysis.extractedText, FAKE_EXTRACTION_RESULT.extractedText);
    assert.equal(processed.analysis.pageCount, FAKE_EXTRACTION_RESULT.pageCount);
    assert.equal(processed.analysis.charCount, FAKE_EXTRACTION_RESULT.charCount);
    assert.equal(processed.analysis.mainTopics, undefined, 'Sin el flag de IA, no debería haber campos de resumen.');
    assert.equal(extractCallCount, 1, 'El paso de extracción debería haberse llamado exactamente una vez.');
    assert.equal(summarizeCallCount, 0, 'Con el flag de IA apagado, el paso de resumen NO debería llamarse.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('con ENABLE_AI_DOCUMENT_ANALYSIS="true", el resultado incluye extractedText/pageCount/charCount Y ADEMÁS los campos del resumen, con modelo y tokens guardados', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-analisis-ia@test.com';
  let summarizeCallCount = 0;
  let receivedText;
  pdfTextExtractionProvider.extractText = async () => FAKE_EXTRACTION_RESULT;
  documentSummaryProvider.summarize = async (text) => {
    summarizeCallCount += 1;
    receivedText = text;
    return FAKE_SUMMARY_RESULT;
  };

  await registerRole(meetingCode, email, 'teacher');
  const previousFlag = process.env.ENABLE_AI_DOCUMENT_ANALYSIS;
  process.env.ENABLE_AI_DOCUMENT_ANALYSIS = 'true';

  try {
    await uploadDocument(meetingCode, email);
    const processed = await waitForAnalysisStatus(meetingCode, email, ['processed', 'failed']);

    assert.equal(processed.analysisStatus, 'processed', `Debería terminar "processed". Doc: ${JSON.stringify(processed)}`);
    // Los campos de extracción siguen presentes — el resumen se SUMA,
    // nunca reemplaza el texto extraído.
    assert.equal(processed.analysis.extractedText, FAKE_EXTRACTION_RESULT.extractedText);
    assert.equal(processed.analysis.pageCount, FAKE_EXTRACTION_RESULT.pageCount);
    assert.equal(processed.analysis.charCount, FAKE_EXTRACTION_RESULT.charCount);
    assert.deepEqual(processed.analysis.mainTopics, FAKE_SUMMARY_RESULT.mainTopics);
    assert.deepEqual(processed.analysis.keyConcepts, FAKE_SUMMARY_RESULT.keyConcepts);
    assert.equal(summarizeCallCount, 1, 'Con el flag prendido, el paso de resumen debería llamarse.');
    // El resumen recibe el TEXTO YA EXTRAÍDO — nunca el PDF/filePath.
    assert.equal(receivedText, FAKE_EXTRACTION_RESULT.extractedText);
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_AI_DOCUMENT_ANALYSIS;
    else process.env.ENABLE_AI_DOCUMENT_ANALYSIS = previousFlag;
    await cleanupMeeting(meetingCode);
  }
});

test('un fallo del paso de extracción queda registrado como "failed" con el mensaje de error, sin tumbar la carga', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-analisis-fallo@test.com';
  pdfTextExtractionProvider.extractText = async () => {
    throw new Error('Fallo simulado de extracción.');
  };

  await registerRole(meetingCode, email, 'teacher');

  try {
    const { status } = await uploadDocument(meetingCode, email);
    assert.equal(status, 201, 'La carga en sí debe seguir confirmando 201 aunque el procesamiento después falle.');

    const failed = await waitForAnalysisStatus(meetingCode, email, ['processed', 'failed']);
    assert.equal(failed.analysisStatus, 'failed');
    assert.equal(failed.analysisError, 'Fallo simulado de extracción.');
    assert.equal(failed.analysis, null, 'No debería haber resultado guardado si el procesamiento falló.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('el documento se procesa UNA SOLA VEZ — reinvocar el servicio para el mismo documento ya "processed" no vuelve a llamar al provider de extracción', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-analisis-unico@test.com';
  let callCount = 0;
  pdfTextExtractionProvider.extractText = async () => {
    callCount += 1;
    return FAKE_EXTRACTION_RESULT;
  };

  await registerRole(meetingCode, email, 'teacher');

  try {
    await uploadDocument(meetingCode, email);
    await waitForAnalysisStatus(meetingCode, email, ['processed', 'failed']);
    assert.equal(callCount, 1);

    // Reinvoca el servicio DIRECTO para el mismo documento — simula una
    // carrera o un reintento accidental (ej. el backend se reinicia a
    // mitad de análisis y algo vuelve a disparar el mismo documento).
    const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
    const row = await documentRepository.getDocumentForMeeting(meetingId);
    await documentAnalysisService.analyzeDocument(row);

    assert.equal(callCount, 1, 'El provider NO debería haberse vuelto a llamar — el documento ya estaba "processed".');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('reemplazar el documento resetea el análisis anterior y dispara un análisis nuevo', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-analisis-reemplazo@test.com';
  let callCount = 0;
  pdfTextExtractionProvider.extractText = async () => {
    callCount += 1;
    return { ...FAKE_EXTRACTION_RESULT, extractedText: `Texto #${callCount}` };
  };

  await registerRole(meetingCode, email, 'teacher');

  try {
    await uploadDocument(meetingCode, email, { fileName: 'primero.pdf' });
    const first = await waitForAnalysisStatus(meetingCode, email, ['processed', 'failed']);
    assert.equal(first.analysis.extractedText, 'Texto #1');

    await uploadDocument(meetingCode, email, { fileName: 'segundo.pdf' });
    const second = await waitForAnalysisStatus(meetingCode, email, ['processed', 'failed']);
    assert.equal(second.fileName, 'segundo.pdf');
    assert.equal(second.analysis.extractedText, 'Texto #2', 'El análisis debería ser del documento NUEVO, no arrastrar el viejo.');
    assert.equal(callCount, 2);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('isDocumentReadyForMeeting refleja el estado real del análisis (en curso => false, processed => true)', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-listo@test.com';
  let resolveExtraction;
  // ⚠️ `uploadDocument` responde ANTES de que el análisis arranque: el
  // procesamiento sigue en segundo plano. Sin esperar a que el mock haya
  // sido llamado de verdad, `resolveExtraction` todavía es `undefined` y el
  // test muere con "resolveExtraction is not a function" — un mensaje que
  // no dice en ningún lado que el problema es de tiempos. Local nunca pasa
  // (el análisis arranca en milisegundos); en el runner del CI, sí.
  let marcarExtraccionEmpezada;
  const extraccionEmpezada = new Promise((resolve) => {
    marcarExtraccionEmpezada = resolve;
  });
  pdfTextExtractionProvider.extractText = () =>
    new Promise((resolve) => {
      resolveExtraction = resolve;
      marcarExtraccionEmpezada();
    });

  await registerRole(meetingCode, email, 'teacher');

  try {
    await uploadDocument(meetingCode, email);

    // Con un timeout explícito: si el análisis nunca arranca, el error tiene
    // que decir eso y no reventar más abajo por una variable sin asignar.
    // El timer se cancela y además lleva `unref()`: sin eso, el proceso de
    // `node --test` se queda vivo hasta que venza, y la suite entera tarda
    // cinco segundos de más por un timeout que nunca hizo falta.
    let timer;
    await Promise.race([
      extraccionEmpezada,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('El análisis del documento nunca llamó a extractText')),
          5000
        );
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    clearTimeout(timer);

    // El procesamiento todavía no resolvió (la promesa del mock sigue
    // pendiente) — la clase no puede arrancar.
    const readyWhileAnalyzing = await documentService.isDocumentReadyForMeeting(meetingCode);
    assert.equal(readyWhileAnalyzing, false);

    resolveExtraction(FAKE_EXTRACTION_RESULT);
    await waitForAnalysisStatus(meetingCode, email, ['processed', 'failed']);

    const readyAfterProcessed = await documentService.isDocumentReadyForMeeting(meetingCode);
    assert.equal(readyAfterProcessed, true);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});
