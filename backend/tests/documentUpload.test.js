// Reproduce dos bugs puntuales de la carga de documentos (ver
// DOCUMENTACION del arreglo): (1) un archivo vacío/corrupto (pero con
// extensión .pdf válida) se aceptaba igual — se guardaba una fila de
// `files` con `size_bytes` chico ("15 B" en el panel) y recién fallaba
// mucho después, al procesarlo; (2) un error crudo del SDK de OpenAI (ej.
// "500 Unknown error while validating file ownership.", nada que ver con
// la autorización de esta app) llegaba tal cual hasta `files.analysis_error`
// — visible directo para el docente en el panel.
//
// Cambio 1 (mismo patrón que `documentAnalysis.test.js`): servidor Express
// real + base de datos real (`npm run init-db` corrido antes).
// Cambio 2: unitario sobre `OpenAIDocumentAnalysisProvider`, con el
// `client` de OpenAI reemplazado por un stub — nunca llama a la red real.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-fake-key-para-este-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');
const { pdfTextExtractionProvider } = require('../src/providers');
const { OpenAIDocumentAnalysisProvider } = require('../src/providers/openAIDocumentAnalysisProvider');

let server;
let apiUrl;
let originalExtractText;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  apiUrl = `http://localhost:${port}`;

  originalExtractText = pdfTextExtractionProvider.extractText.bind(pdfTextExtractionProvider);
});

test.after(async () => {
  pdfTextExtractionProvider.extractText = originalExtractText;
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

async function uploadRawFile(meetingCode, email, contents, fileName = 'material.pdf') {
  const formData = new FormData();
  formData.append('email', email);
  formData.append('file', new Blob([contents], { type: 'application/pdf' }), fileName);
  const resp = await fetch(`${apiUrl}/api/meetings/${meetingCode}/documents`, { method: 'POST', body: formData });
  return { status: resp.status, body: await resp.json() };
}

async function cleanupMeeting(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

test('un archivo de 15 bytes con extensión .pdf (vacío/corrupto, no un PDF real) se rechaza en la carga con un 400 controlado, sin crear ninguna fila en "files"', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-archivo-corrupto@test.com';
  await registerRole(meetingCode, email, 'teacher');

  try {
    // Mismo tamaño (15 bytes) que se vio en producción — ni siquiera
    // arranca con la firma "%PDF-" de un PDF real.
    const { status, body } = await uploadRawFile(meetingCode, email, 'contenido basura');
    assert.equal(status, 400, `Debería rechazarse con 400. Body: ${JSON.stringify(body)}`);
    assert.match(body.error, /vacío|chico|corrupto|dañado/i);

    const [rows] = await pool.query(
      'SELECT f.id FROM files f JOIN meetings m ON m.id = f.meeting_id WHERE m.meeting_code = ?',
      [meetingCode]
    );
    assert.equal(rows.length, 0, 'No debería haber quedado ninguna fila de "files" para un archivo rechazado.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('un PDF con la firma correcta pero por debajo del tamaño mínimo también se rechaza en la carga', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-pdf-truncado@test.com';
  await registerRole(meetingCode, email, 'teacher');

  try {
    const { status, body } = await uploadRawFile(meetingCode, email, '%PDF-1.4');
    assert.equal(status, 400, `Debería rechazarse con 400. Body: ${JSON.stringify(body)}`);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('un PDF válido (firma correcta y tamaño suficiente) se acepta en la carga', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-pdf-valido@test.com';
  // Mockeado para no depender de `pdf-parse` sobre un PDF de verdad — este
  // test solo cubre la validación de contenido en la carga, no el
  // procesamiento en sí (ver `documentAnalysis.test.js` para eso).
  pdfTextExtractionProvider.extractText = async () => ({
    extractedText: 'texto de prueba',
    pageCount: 1,
    charCount: 16,
  });
  await registerRole(meetingCode, email, 'teacher');

  try {
    const contenidoValido = `%PDF-1.4\n${'x'.repeat(200)}`;
    const { status, body } = await uploadRawFile(meetingCode, email, contenidoValido);
    assert.equal(status, 201, `Un PDF válido no debería rechazarse. Body: ${JSON.stringify(body)}`);
  } finally {
    // El mock se restaura en `test.after` (no acá): el procesamiento se
    // dispara fire-and-forget (ver `documentService.saveTeacherDocument`)
    // y todavía puede no haber leído `pdfTextExtractionProvider.
    // extractText` recién asignado para cuando este `finally` corre —
    // restaurar antes de tiempo lo haría intentar abrir un PDF que no
    // existe de verdad.
    await cleanupMeeting(meetingCode);
  }
});

test('un error crudo del SDK de OpenAI (ej. "500 Unknown error while validating file ownership.") nunca llega tal cual al llamador — se traduce a un mensaje controlado, y el detalle real queda logueado', async () => {
  const provider = new OpenAIDocumentAnalysisProvider();
  // Reemplaza el cliente ANTES de que `summarize` intente crear uno real
  // (`if (!this.client) this.client = new OpenAI(...)`) — con esto ya
  // seteado, usa el stub y nunca toca la red. `summarize` usa la Chat
  // Completions API (no sube ningún archivo — recibe texto plano) — el
  // único método que usa del cliente es `chat.completions.create`.
  provider.client = {
    chat: {
      completions: {
        create: async () => {
          throw Object.assign(new Error('500 Unknown error while validating file ownership.'), {
            status: 500,
            code: null,
          });
        },
      },
    },
  };

  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);

  try {
    await assert.rejects(
      () => provider.summarize('texto de prueba extraído del PDF', { originalName: 'material.pdf' }),
      (err) => {
        assert.notEqual(
          err.message,
          '500 Unknown error while validating file ownership.',
          'El mensaje crudo del SDK de OpenAI no debe propagarse tal cual.'
        );
        assert.match(err.message, /no se pudo generar el resumen/i);
        return true;
      }
    );

    const loggedRawError = loggedCalls.some((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('500 Unknown error while validating file ownership.'))
    );
    assert.ok(loggedRawError, 'El error real del SDK debería quedar logueado internamente para diagnóstico.');
  } finally {
    console.error = originalConsoleError;
  }
});

// Respuesta mínima válida de Chat Completions — reusada por los tests de
// abajo, que no les importa el contenido del resumen en sí (eso ya lo
// cubre `parseSummaryResponse` indirectamente vía estos mismos tests),
// sino los PARÁMETROS con los que se llama a la API y cómo se prepara el
// texto de entrada.
function fakeChatCompletion({ content = '{"mainTopics": [], "keyConcepts": []}', model = 'gpt-4o-mini' } = {}) {
  return {
    model,
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 },
  };
}

// El prompt fijo (`SUMMARY_PROMPT`) TERMINA con `"""\n`, seguido del texto
// del documento y, al final del mensaje completo, un `\n"""` de cierre
// (ver `summarize`) — el prompt en sí tiene sus propios saltos de línea
// dobles (separación entre párrafos) y alguna letra suelta que podría
// pisar un assert ingenuo sobre el mensaje ENTERO. Aislar acá el texto
// que de verdad viajó como "documento" (después de la limpieza/truncado)
// evita falsos positivos/negativos por el contenido fijo del prompt.
function extractDocumentTextSentToOpenAI(sentContent) {
  const [, afterMarker] = sentContent.split('"""\n');
  return afterMarker.replace(/\n"""$/, '');
}

test('summarize() llama a Chat Completions con salida estructurada (json_schema estricto), temperature baja, y el modelo económico por default (OPENAI_SUMMARY_MODEL sin setear)', async () => {
  const provider = new OpenAIDocumentAnalysisProvider();
  let capturedParams;
  provider.client = {
    chat: {
      completions: {
        create: async (params) => {
          capturedParams = params;
          return fakeChatCompletion();
        },
      },
    },
  };

  const previousModel = process.env.OPENAI_SUMMARY_MODEL;
  delete process.env.OPENAI_SUMMARY_MODEL;

  try {
    await provider.summarize('texto de prueba', { originalName: 'material.pdf' });
    assert.equal(capturedParams.model, 'gpt-4o-mini', 'Sin OPENAI_SUMMARY_MODEL seteada, debería usar el default económico.');
    assert.equal(capturedParams.response_format.type, 'json_schema');
    assert.equal(capturedParams.response_format.json_schema.strict, true);
    assert.ok(capturedParams.temperature >= 0.2 && capturedParams.temperature <= 0.3, 'La temperature debería estar en el rango bajo pedido (0.2-0.3).');
  } finally {
    if (previousModel === undefined) delete process.env.OPENAI_SUMMARY_MODEL;
    else process.env.OPENAI_SUMMARY_MODEL = previousModel;
  }
});

test('OPENAI_SUMMARY_MODEL configura el modelo sin tocar código', async () => {
  const provider = new OpenAIDocumentAnalysisProvider();
  let capturedParams;
  provider.client = {
    chat: {
      completions: {
        create: async (params) => {
          capturedParams = params;
          return fakeChatCompletion({ model: 'gpt-4.1-nano' });
        },
      },
    },
  };

  const previousModel = process.env.OPENAI_SUMMARY_MODEL;
  process.env.OPENAI_SUMMARY_MODEL = 'gpt-4.1-nano';

  try {
    const result = await provider.summarize('texto de prueba', { originalName: 'material.pdf' });
    assert.equal(capturedParams.model, 'gpt-4.1-nano');
    assert.equal(result.model, 'gpt-4.1-nano');
  } finally {
    if (previousModel === undefined) delete process.env.OPENAI_SUMMARY_MODEL;
    else process.env.OPENAI_SUMMARY_MODEL = previousModel;
  }
});

test('el texto se limpia antes de mandarlo a OpenAI — colapsa espacios/saltos de línea múltiples y saca líneas que son solo un número de página', async () => {
  const provider = new OpenAIDocumentAnalysisProvider();
  let capturedParams;
  provider.client = {
    chat: {
      completions: {
        create: async (params) => {
          capturedParams = params;
          return fakeChatCompletion();
        },
      },
    },
  };

  const textoConRuido = 'Primer   párrafo   con espacios de más.\n42\n\n\n\nSegundo párrafo, después de varios saltos de línea.\n7';

  await provider.summarize(textoConRuido, { originalName: 'material.pdf' });

  const sentDocumentText = extractDocumentTextSentToOpenAI(capturedParams.messages[0].content);
  assert.doesNotMatch(sentDocumentText, /(^|\n)42(\n|$)/, 'Una línea que es SOLO un número de página no debería llegar a OpenAI.');
  assert.doesNotMatch(sentDocumentText, /(^|\n)7(\n|$)/, 'Ídem para el número de página al final del texto.');
  assert.doesNotMatch(sentDocumentText, / {2,}/, 'No deberían quedar espacios múltiples.');
  assert.doesNotMatch(sentDocumentText, /\n{2,}/, 'No deberían quedar saltos de línea múltiples.');
  assert.equal(
    sentDocumentText,
    'Primer párrafo con espacios de más.\nSegundo párrafo, después de varios saltos de línea.'
  );
});

test('el texto se trunca a OPENAI_SUMMARY_MAX_CHARS antes de mandarlo, con un log indicando el truncado', async () => {
  const provider = new OpenAIDocumentAnalysisProvider();
  let capturedParams;
  provider.client = {
    chat: {
      completions: {
        create: async (params) => {
          capturedParams = params;
          return fakeChatCompletion();
        },
      },
    },
  };

  const textoLargo = 'x'.repeat(200);
  const previousMax = process.env.OPENAI_SUMMARY_MAX_CHARS;
  process.env.OPENAI_SUMMARY_MAX_CHARS = '50';

  const originalConsoleLog = console.log;
  const loggedLines = [];
  console.log = (...args) => loggedLines.push(args.join(' '));

  try {
    await provider.summarize(textoLargo, { originalName: 'material-largo.pdf' });

    const sentDocumentText = extractDocumentTextSentToOpenAI(capturedParams.messages[0].content);
    assert.equal(sentDocumentText, 'x'.repeat(50), 'El texto de entrada debería truncarse a OPENAI_SUMMARY_MAX_CHARS caracteres.');

    const truncationLogged = loggedLines.some((line) => /truncado/i.test(line) && line.includes('material-largo.pdf'));
    assert.ok(truncationLogged, 'Debería quedar logueado que el texto se truncó, con el nombre del archivo.');
  } finally {
    console.log = originalConsoleLog;
    if (previousMax === undefined) delete process.env.OPENAI_SUMMARY_MAX_CHARS;
    else process.env.OPENAI_SUMMARY_MAX_CHARS = previousMax;
  }
});

test('un texto más corto que OPENAI_SUMMARY_MAX_CHARS no se trunca ni se loguea como truncado', async () => {
  const provider = new OpenAIDocumentAnalysisProvider();
  provider.client = {
    chat: {
      completions: {
        create: async () => fakeChatCompletion(),
      },
    },
  };

  const originalConsoleLog = console.log;
  const loggedLines = [];
  console.log = (...args) => loggedLines.push(args.join(' '));

  try {
    await provider.summarize('texto corto', { originalName: 'material-corto.pdf' });
    const truncationLogged = loggedLines.some((line) => /truncado/i.test(line));
    assert.equal(truncationLogged, false, 'Un texto corto no debería generar ningún log de truncado.');
  } finally {
    console.log = originalConsoleLog;
  }
});

test('summarize() devuelve el uso de tokens (prompt/completion) tal cual lo reporta la API, para poder loguear el costo real', async () => {
  const provider = new OpenAIDocumentAnalysisProvider();
  provider.client = {
    chat: {
      completions: {
        create: async () => ({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: '{"mainTopics": ["Tema A"], "keyConcepts": []}' } }],
          usage: { prompt_tokens: 987, completion_tokens: 65, total_tokens: 1052 },
        }),
      },
    },
  };

  const result = await provider.summarize('texto de prueba', { originalName: 'material.pdf' });
  assert.equal(result.inputTokens, 987);
  assert.equal(result.outputTokens, 65);
  assert.deepEqual(result.mainTopics, ['Tema A']);
});

test('una respuesta con campos de tipo inválido en el JSON se sanea en vez de propagarse (parseo defensivo)', async () => {
  const provider = new OpenAIDocumentAnalysisProvider();
  provider.client = {
    chat: {
      completions: {
        create: async () =>
          fakeChatCompletion({
            content: JSON.stringify({
              mainTopics: ['Tema válido', 42, null, 'Otro tema válido'],
              keyConcepts: [
                { term: 'Concepto válido', definition: 'Definición válida.' },
                { term: 'Sin definición' },
                'no es un objeto',
              ],
            }),
          }),
      },
    },
  };

  const result = await provider.summarize('texto de prueba', { originalName: 'material.pdf' });
  assert.deepEqual(result.mainTopics, ['Tema válido', 'Otro tema válido']);
  assert.deepEqual(result.keyConcepts, [{ term: 'Concepto válido', definition: 'Definición válida.' }]);
});
