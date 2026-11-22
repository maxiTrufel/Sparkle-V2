// Tests del resumen de clase con IA ("Obtener resumen de la clase" del
// alumno) — mismas capas que `aiQuestionGeneration.test.js`:
//   1. `transcriptRepository.getAllSegments` — contra la base real.
//   2. `OpenAIClassSummaryProvider` — unitario, con el `client` de OpenAI
//      reemplazado por un stub (nunca llama a la red real).
//   3. `classSummaryService.getClassSummary` + el endpoint REST completo —
//      con `openAIClassSummaryProvider.summarize` MOCKEADO (mismo
//      mecanismo que `aiQuestionGeneration.test.js`: se reemplaza el
//      método de la instancia real que exporta `../src/providers`), para
//      probar la ORQUESTACIÓN (auth, estado de la clase, caché, sección de
//      repaso sin IA) sin gastar saldo real ni necesitar `OPENAI_API_KEY`.
//
// El foco especial de este archivo es el CACHÉ: el requisito de costo más
// importante del feature es que, sin importar cuántos alumnos pidan el
// resumen de la MISMA clase terminada, haya UNA sola llamada a OpenAI —
// incluida la carrera real de varios pedidos concurrentes antes de que el
// primero termine (no solo "cachear el resultado ya resuelto", que no
// alcanza para evitar esa carrera).
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-fake-key-para-este-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');
const transcriptRepository = require('../src/repositories/transcriptRepository');
const meetingRepository = require('../src/repositories/meetingRepository');
const userRepository = require('../src/repositories/userRepository');
const classService = require('../src/services/classService');
const documentAnalysisService = require('../src/services/documentAnalysisService');
const { openAIClassSummaryProvider } = require('../src/providers');
const { OpenAIClassSummaryProvider } = require('../src/providers/openAIClassSummaryProvider');

let server;
let apiUrl;
let originalSummarize;
let originalGetAnalysisSummary;
let previousFlag;
let previousMinChars;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  apiUrl = `http://localhost:${port}`;

  originalSummarize = openAIClassSummaryProvider.summarize.bind(openAIClassSummaryProvider);
  originalGetAnalysisSummary = documentAnalysisService.getAnalysisSummary;
  previousFlag = process.env.ENABLE_AI_CLASS_SUMMARY;
  process.env.ENABLE_AI_CLASS_SUMMARY = 'true';

  // La mayoría de los tests de este archivo seedean transcripciones MUY
  // cortas (frases de prueba, no una clase real) — sin esto, el chequeo
  // de suficiencia (`OPENAI_CLASS_SUMMARY_MIN_CHARS`, default 500) haría
  // que esos tests nunca lleguen a llamar al provider mockeado. Se baja a
  // 1 acá (global, para no tener que tocar cada test existente) y los
  // tests DEDICADOS al chequeo de suficiencia lo pisan puntualmente con un
  // valor más alto.
  previousMinChars = process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS;
  process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS = '1';
});

test.after(async () => {
  openAIClassSummaryProvider.summarize = originalSummarize;
  documentAnalysisService.getAnalysisSummary = originalGetAnalysisSummary;
  if (previousFlag === undefined) delete process.env.ENABLE_AI_CLASS_SUMMARY;
  else process.env.ENABLE_AI_CLASS_SUMMARY = previousFlag;
  if (previousMinChars === undefined) delete process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS;
  else process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS = previousMinChars;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function newMeetingCode(label) {
  const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `test-resumen-clase-${label}-${letters(6)}`;
}

async function registerRole(meetingCode, email, role) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role }),
  });
  return resp.json();
}

async function registerStudent(meetingCode, email, name) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, name }),
  });
  return resp.json();
}

async function fetchClassSummary(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const resp = await fetch(`${apiUrl}/api/meetings/${encodeURIComponent(meetingCode)}/summary?${params.toString()}`);
  return { status: resp.status, body: await resp.json() };
}

async function cleanupMeeting(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

async function seedTranscriptSegment(meetingCode, text, offsetSeconds, speaker = 'Docente') {
  await pool.query(
    `INSERT INTO transcript_segments (meeting_code, speaker, text, absolute_start_time, segment_id)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
    [meetingCode, speaker, text, offsetSeconds, `${meetingCode}-${offsetSeconds}`]
  );
}

async function seedFinishedQuestion(meetingId, prompt, correctOption) {
  const [result] = await pool.query(
    `INSERT INTO questions
       (meeting_id, prompt, option_a, option_b, option_c, option_d, correct_option, duration_seconds, status, started_at, expires_at, finished_at)
     VALUES (?, ?, 'Opción A', 'Opción B', 'Opción C', 'Opción D', ?, 20, 'finished', NOW(), NOW(), NOW())`,
    [meetingId, prompt, correctOption]
  );
  return result.insertId;
}

async function seedAnswer(questionId, userId, { selectedOption, isCorrect, skipped }) {
  await pool.query(
    `INSERT INTO question_answers (question_id, user_id, selected_option, is_correct, skipped, response_time_ms)
     VALUES (?, ?, ?, ?, ?, 1000)`,
    [questionId, userId, selectedOption, isCorrect, skipped]
  );
}

// Termina la clase de mentira para estos tests — mismo camino que usa
// `ws/handlers.js` (`classService.startClass`/`endClassManual`/
// `resumeClass`), pero llamado DIRECTO (sin WS ni Vexa) — ninguno de los
// tres toca nada que dependa de una sala en vivo.
async function startAndEndClass(meetingCode) {
  await classService.startClass(meetingCode);
  await classService.endClassManual(meetingCode);
}

// ─── 1. transcriptRepository.getAllSegments ───

test('getAllSegments trae TODOS los segmentos de una reunión, en orden cronológico, sin límite', async () => {
  const meetingCode = newMeetingCode('todos-los-segmentos');
  await pool.query('INSERT INTO meetings (meeting_code) VALUES (?)', [meetingCode]);
  try {
    for (let i = 0; i < 7; i++) {
      await seedTranscriptSegment(meetingCode, `Fragmento ${i}`, i);
    }
    const all = await transcriptRepository.getAllSegments(meetingCode);
    assert.deepEqual(
      all.map((s) => s.text),
      Array.from({ length: 7 }, (_, i) => `Fragmento ${i}`)
    );
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('getAllSegments devuelve un array vacío para una reunión sin transcripción', async () => {
  const meetingCode = newMeetingCode('sin-transcripcion');
  await pool.query('INSERT INTO meetings (meeting_code) VALUES (?)', [meetingCode]);
  try {
    const all = await transcriptRepository.getAllSegments(meetingCode);
    assert.deepEqual(all, []);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

// ─── 2. OpenAIClassSummaryProvider (unitario, cliente stubeado) ───

function fakeChatCompletion({ content, model = 'gpt-4o-mini' } = {}) {
  return {
    model,
    choices: [{ message: { content: content ?? JSON.stringify({ bullets: ['Punto 1', 'Punto 2'] }) } }],
    usage: { prompt_tokens: 500, completion_tokens: 80, total_tokens: 580 },
  };
}

test('OpenAIClassSummaryProvider.summarize() llama a Chat Completions con salida estructurada (json_schema estricto), temperature 0.25, y el modelo económico por default', async () => {
  const provider = new OpenAIClassSummaryProvider();
  let capturedParams;
  provider.client = {
    chat: { completions: { create: async (params) => { capturedParams = params; return fakeChatCompletion(); } } },
  };

  const previousModel = process.env.OPENAI_CLASS_SUMMARY_MODEL;
  delete process.env.OPENAI_CLASS_SUMMARY_MODEL;
  try {
    await provider.summarize({ mainTopics: ['Tema A'], keyConcepts: [], transcriptSegments: [{ speaker: 'Docente', text: 'Hola.' }] });
    assert.equal(capturedParams.model, 'gpt-4o-mini');
    assert.equal(capturedParams.response_format.type, 'json_schema');
    assert.equal(capturedParams.response_format.json_schema.strict, true);
    assert.equal(capturedParams.temperature, 0.25);
    assert.equal(capturedParams.messages[0].role, 'system');
    assert.equal(capturedParams.messages[1].role, 'user');
    assert.match(capturedParams.messages[1].content, /Tema A/);
  } finally {
    if (previousModel === undefined) delete process.env.OPENAI_CLASS_SUMMARY_MODEL;
    else process.env.OPENAI_CLASS_SUMMARY_MODEL = previousModel;
  }
});

test('la transcripción demasiado larga se trunca recortando el INICIO (se conserva el tramo final)', async () => {
  const provider = new OpenAIClassSummaryProvider();
  let capturedParams;
  provider.client = {
    chat: { completions: { create: async (params) => { capturedParams = params; return fakeChatCompletion(); } } },
  };

  const previousMax = process.env.OPENAI_CLASS_SUMMARY_MAX_CHARS;
  process.env.OPENAI_CLASS_SUMMARY_MAX_CHARS = '50';
  try {
    await provider.summarize({
      mainTopics: [],
      keyConcepts: [],
      transcriptSegments: [
        { speaker: 'Docente', text: 'CONTENIDO_VIEJO_QUE_DEBERIA_DESAPARECER' },
        { speaker: 'Docente', text: 'CONTENIDO_FINAL_QUE_TIENE_QUE_QUEDAR' },
      ],
    });
    const content = capturedParams.messages[1].content;
    assert.ok(!content.includes('CONTENIDO_VIEJO_QUE_DEBERIA_DESAPARECER'), 'El tramo del INICIO debería haberse recortado.');
    assert.ok(content.includes('QUE_TIENE_QUE_QUEDAR'), 'El tramo FINAL debería conservarse.');
  } finally {
    if (previousMax === undefined) delete process.env.OPENAI_CLASS_SUMMARY_MAX_CHARS;
    else process.env.OPENAI_CLASS_SUMMARY_MAX_CHARS = previousMax;
  }
});

test('un array de bullets VACÍO no es un error de parseo — el modelo puede decidir legítimamente que no hay nada que resumir', async () => {
  const provider = new OpenAIClassSummaryProvider();
  provider.client = {
    chat: { completions: { create: async () => fakeChatCompletion({ content: JSON.stringify({ bullets: [] }) }) } },
  };

  const result = await provider.summarize({ mainTopics: [], keyConcepts: [], transcriptSegments: [{ speaker: 'Docente', text: 'Hola.' }] });
  assert.deepEqual(result.bullets, []);
});

test('parseo defensivo — una respuesta SIN el campo "bullets" (no un array vacío, directamente ausente/mal tipado) se vuelve a pedir, y si nunca viene bien se rechaza con un mensaje para reintentar', async () => {
  const provider = new OpenAIClassSummaryProvider();
  let calls = 0;
  provider.client = {
    chat: { completions: { create: async () => { calls += 1; return fakeChatCompletion({ content: JSON.stringify({ algoQueNoEsBullets: true }) }); } } },
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      () => provider.summarize({ mainTopics: [], keyConcepts: [], transcriptSegments: [{ speaker: 'Docente', text: 'Hola.' }] }),
      /reintentá/i
    );
    assert.equal(calls, 3, 'Debería haberlo pedido 3 veces antes de rendirse.');
  } finally {
    console.error = originalConsoleError;
  }
});

test('un error del SDK de OpenAI nunca llega tal cual al llamador — se traduce, y el alumno puede reintentar (mensaje lo indica)', async () => {
  const provider = new OpenAIClassSummaryProvider();
  provider.client = {
    chat: {
      completions: {
        create: async () => {
          throw Object.assign(new Error('500 Internal server error de OpenAI, con detalle interno.'), { status: 500 });
        },
      },
    },
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      () => provider.summarize({ mainTopics: [], keyConcepts: [], transcriptSegments: [{ speaker: 'Docente', text: 'Hola.' }] }),
      (err) => {
        assert.notEqual(err.message, '500 Internal server error de OpenAI, con detalle interno.');
        assert.match(err.message, /reintentá/i);
        return true;
      }
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('summarize() loguea el uso de tokens tal cual lo reporta la API', async () => {
  const provider = new OpenAIClassSummaryProvider();
  provider.client = { chat: { completions: { create: async () => fakeChatCompletion() } } };
  const originalConsoleLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await provider.summarize({ mainTopics: [], keyConcepts: [], transcriptSegments: [{ speaker: 'Docente', text: 'Hola.' }] });
    assert.ok(logged.some((line) => /tokens:.*prompt=500.*completion=80.*total=580/.test(line)));
  } finally {
    console.log = originalConsoleLog;
  }
});

// ─── 3. classSummaryService.getClassSummary + el endpoint REST completo ───

test('GET /:meetingCode/summary exige email (400 si falta)', async () => {
  const resp = await fetch(`${apiUrl}/api/meetings/una-reunion/summary`);
  assert.equal(resp.status, 400);
});

test('rechaza con 403 a quien nunca participó de esta reunión', async () => {
  const meetingCode = newMeetingCode('no-participante');
  await registerRole(meetingCode, 'docente@test.com', 'teacher');
  try {
    const { status, body } = await fetchClassSummary(meetingCode, 'nunca-estuvo@test.com');
    assert.equal(status, 403);
    assert.match(body.error, /no participaste/i);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('rechaza con 409 mientras la clase sigue en curso', async () => {
  const meetingCode = newMeetingCode('clase-en-curso');
  const email = 'docente-en-curso@test.com';
  await registerRole(meetingCode, email, 'teacher');
  await classService.startClass(meetingCode);
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 409);
    assert.match(body.error, /en curso/i);
  } finally {
    await classService.endClassManual(meetingCode);
    await cleanupMeeting(meetingCode);
  }
});

test('con el flag ENABLE_AI_CLASS_SUMMARY apagado, NUNCA es un error: responde 200 con aiSummaryAvailable=false y "Para repasar" igual armado (sin IA)', async () => {
  const meetingCode = newMeetingCode('flag-apagado');
  const email = 'alumno-flag-apagado@test.com';
  let callCount = 0;
  openAIClassSummaryProvider.summarize = async () => {
    callCount += 1;
    return { bullets: ['no debería llamarse'], keyConcepts: [] };
  };

  await registerStudent(meetingCode, email, 'Alumno Flag Apagado');
  const userId = await userRepository.getUserIdByEmail(email);
  const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
  const incorrecta = await seedFinishedQuestion(meetingId, '¿Pregunta?', 'a');
  await seedAnswer(incorrecta, userId, { selectedOption: 'b', isCorrect: false, skipped: false });

  await startAndEndClass(meetingCode);
  const previous = process.env.ENABLE_AI_CLASS_SUMMARY;
  process.env.ENABLE_AI_CLASS_SUMMARY = 'false';
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200, `No debería ser un error. Body: ${JSON.stringify(body)}`);
    assert.equal(body.aiSummaryAvailable, false);
    assert.equal(body.summaryUnavailableReason, 'ai_disabled');
    assert.equal(body.bullets, null);
    assert.equal(callCount, 0, 'Con el flag apagado, nunca debería llamar a OpenAI.');
    // La sección de repaso NO depende de la IA — sigue armándose igual.
    assert.equal(body.review.congratulations, false);
    assert.equal(body.review.items.length, 1);
  } finally {
    process.env.ENABLE_AI_CLASS_SUMMARY = previous;
    await cleanupMeeting(meetingCode);
  }
});

test('sin ninguna transcripción, responde 200 con summaryUnavailableReason="insufficient_transcript" sin llamar a OpenAI (nunca inventa un resumen solo con el documento)', async () => {
  const meetingCode = newMeetingCode('sin-transcripcion');
  const email = 'docente-sin-transcripcion@test.com';
  let callCount = 0;
  openAIClassSummaryProvider.summarize = async () => {
    callCount += 1;
    return { bullets: ['no debería llamarse'], keyConcepts: [] };
  };

  await registerRole(meetingCode, email, 'teacher');
  await startAndEndClass(meetingCode);
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200, `No debería ser un error. Body: ${JSON.stringify(body)}`);
    assert.equal(body.aiSummaryAvailable, false);
    assert.equal(body.summaryUnavailableReason, 'insufficient_transcript');
    assert.equal(body.bullets, null);
    assert.equal(callCount, 0, 'Sin ningún segmento, ni vale la pena llamar a OpenAI.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('con transcripción por debajo de OPENAI_CLASS_SUMMARY_MIN_CHARS, responde igual "insufficient_transcript" SIN llamar a OpenAI (evita pagar una llamada previsible)', async () => {
  const meetingCode = newMeetingCode('transcripcion-corta');
  const email = 'docente-transcripcion-insuficiente@test.com';
  let callCount = 0;
  openAIClassSummaryProvider.summarize = async () => {
    callCount += 1;
    return { bullets: ['no debería llamarse'], keyConcepts: [] };
  };

  await registerRole(meetingCode, email, 'teacher');
  // Mismo orden de magnitud que el caso real diagnosticado en vivo: unos
  // pocos segmentos, bien por debajo de cualquier mínimo razonable.
  await seedTranscriptSegment(meetingCode, 'Hola', 0);
  await seedTranscriptSegment(meetingCode, 'que tal', 1);
  await startAndEndClass(meetingCode);

  const previousMin = process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS;
  process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS = '500';
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200, `No debería ser un error. Body: ${JSON.stringify(body)}`);
    assert.equal(body.summaryUnavailableReason, 'insufficient_transcript');
    assert.equal(body.bullets, null);
    assert.equal(callCount, 0, 'Por debajo del mínimo configurado, no debería llamar a OpenAI.');
  } finally {
    process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS = previousMin;
    await cleanupMeeting(meetingCode);
  }
});

test('el modelo puede devolver bullets=[] aun con transcripción "suficiente" en caracteres — se traduce a insufficient_transcript, SÍ hubo una llamada real (se cachea igual)', async () => {
  const meetingCode = newMeetingCode('modelo-decide-vacio');
  const email = 'docente-modelo-decide-vacio@test.com';
  let callCount = 0;
  openAIClassSummaryProvider.summarize = async () => {
    callCount += 1;
    // El modelo real devolvió esto mismo en el diagnóstico en vivo: JSON
    // válido, shape correcto, simplemente sin nada que resumir.
    return { bullets: [], keyConcepts: [] };
  };

  await registerRole(meetingCode, email, 'teacher');
  await seedTranscriptSegment(meetingCode, 'x'.repeat(600), 0);
  await startAndEndClass(meetingCode);

  const previousMin = process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS;
  process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS = '500';
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200, `No debería ser un error. Body: ${JSON.stringify(body)}`);
    assert.equal(body.summaryUnavailableReason, 'insufficient_transcript');
    assert.equal(body.bullets, null);
    assert.equal(callCount, 1, 'Acá SÍ correspondía llamar (pasó el chequeo de caracteres) — la decisión de que no había nada fue del modelo, no del pre-chequeo.');
  } finally {
    process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS = previousMin;
    await cleanupMeeting(meetingCode);
  }
});

test('camino (b) — sin transcripción suficiente pero CON mainTopics/keyConcepts del documento, resume el MATERIAL en su lugar (summarySource="document")', async () => {
  const meetingCode = newMeetingCode('fallback-documento');
  const email = 'docente-fallback-documento@test.com';
  let receivedContext;
  openAIClassSummaryProvider.summarize = async (context) => {
    receivedContext = context;
    return { bullets: ['El material cubre fotosíntesis.'], keyConcepts: context.keyConcepts };
  };
  documentAnalysisService.getAnalysisSummary = async () => ({
    mainTopics: ['Fotosíntesis'],
    keyConcepts: [{ term: 'Clorofila', definition: 'Pigmento verde.' }],
  });

  await registerRole(meetingCode, email, 'teacher');
  // Transcripción presente pero muy por debajo del mínimo — el camino (a)
  // no alcanza, tiene que caer al (b).
  await seedTranscriptSegment(meetingCode, 'Hola', 0);
  await startAndEndClass(meetingCode);

  const previousMin = process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS;
  process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS = '500';
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200, `No debería ser un error. Body: ${JSON.stringify(body)}`);
    assert.equal(body.aiSummaryAvailable, true);
    assert.equal(body.summarySource, 'document');
    assert.equal(body.summaryUnavailableReason, null);
    assert.deepEqual(body.bullets, ['El material cubre fotosíntesis.']);
    // El provider recibe `source: 'document'` — es SU responsabilidad
    // (no de este service) elegir el prompt correcto a partir de esto.
    assert.equal(receivedContext.source, 'document');
    assert.deepEqual(receivedContext.mainTopics, ['Fotosíntesis']);
    assert.deepEqual(receivedContext.keyConcepts, [{ term: 'Clorofila', definition: 'Pigmento verde.' }]);
  } finally {
    process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS = previousMin;
    documentAnalysisService.getAnalysisSummary = originalGetAnalysisSummary;
    await cleanupMeeting(meetingCode);
  }
});

test('camino (b) — si el resumen del material también devuelve bullets=[], cae al mensaje neutral (summarySource=null)', async () => {
  const meetingCode = newMeetingCode('fallback-documento-vacio');
  const email = 'docente-fallback-vacio@test.com';
  let callCount = 0;
  openAIClassSummaryProvider.summarize = async () => {
    callCount += 1;
    return { bullets: [], keyConcepts: [] };
  };
  documentAnalysisService.getAnalysisSummary = async () => ({
    mainTopics: ['Un tema'],
    keyConcepts: [],
  });

  await registerRole(meetingCode, email, 'teacher');
  await startAndEndClass(meetingCode); // sin transcripción en absoluto

  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200, `No debería ser un error. Body: ${JSON.stringify(body)}`);
    assert.equal(body.aiSummaryAvailable, false);
    assert.equal(body.summarySource, null);
    assert.equal(body.summaryUnavailableReason, 'insufficient_transcript');
    assert.equal(callCount, 1, 'Correspondía intentar el camino (b) — había mainTopics.');
  } finally {
    documentAnalysisService.getAnalysisSummary = originalGetAnalysisSummary;
    await cleanupMeeting(meetingCode);
  }
});

test('caso feliz: devuelve los bullets generados con summarySource="transcript" y, para el docente, review viaja en null', async () => {
  const meetingCode = newMeetingCode('caso-feliz-docente');
  const email = 'docente-caso-feliz@test.com';
  openAIClassSummaryProvider.summarize = async () => ({ bullets: ['Se explicó fotosíntesis.'], keyConcepts: [] });

  await registerRole(meetingCode, email, 'teacher');
  await seedTranscriptSegment(meetingCode, 'Hoy vimos fotosíntesis.', 0);
  await startAndEndClass(meetingCode);
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200);
    assert.equal(body.aiSummaryAvailable, true);
    assert.equal(body.summarySource, 'transcript');
    assert.equal(body.summaryUnavailableReason, null);
    assert.deepEqual(body.bullets, ['Se explicó fotosíntesis.']);
    assert.equal(body.review, null);
    assert.ok(typeof body.generatedAt === 'string');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('"Para repasar" — sin ninguna pregunta en la clase, review viaja en null', async () => {
  const meetingCode = newMeetingCode('sin-preguntas');
  const email = 'alumno-sin-preguntas@test.com';
  openAIClassSummaryProvider.summarize = async () => ({ bullets: ['Bullet.'], keyConcepts: [] });

  await registerStudent(meetingCode, email, 'Alumno Sin Preguntas');
  await seedTranscriptSegment(meetingCode, 'Contenido de la clase.', 0);
  await startAndEndClass(meetingCode);
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200);
    assert.equal(body.review, null);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('"Para repasar" — si el alumno acertó todas, mensaje de felicitación ARRIBA del listado, que igual incluye la pregunta acertada', async () => {
  const meetingCode = newMeetingCode('acerto-todas');
  const email = 'alumno-acerto-todas@test.com';
  openAIClassSummaryProvider.summarize = async () => ({ bullets: ['Bullet.'], keyConcepts: [] });

  await registerStudent(meetingCode, email, 'Alumno Acertó Todas');
  const userId = await userRepository.getUserIdByEmail(email);
  const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
  const q1 = await seedFinishedQuestion(meetingId, '¿Pregunta 1?', 'a');
  await seedAnswer(q1, userId, { selectedOption: 'a', isCorrect: true, skipped: false });

  await seedTranscriptSegment(meetingCode, 'Contenido de la clase.', 0);
  await startAndEndClass(meetingCode);
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200);
    assert.equal(body.review.congratulations, true);
    // Corrección — el listado NUNCA queda vacío, ni siquiera cuando acertó
    // todas: la pregunta acertada tiene que seguir apareciendo, con su
    // propio estado 'correct'.
    assert.equal(body.review.items.length, 1);
    assert.equal(body.review.items[0].id, q1);
    assert.equal(body.review.items[0].status, 'correct');
    assert.equal(body.review.items[0].yourAnswer, 'Opción A');
    assert.equal(body.review.items[0].correctAnswer, 'Opción A');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('"Para repasar" — incluye SIEMPRE las cuatro preguntas (acertada incluida), y asocia un keyConcept por superposición de palabras solo a las erradas/sin responder', async () => {
  const meetingCode = newMeetingCode('repaso-mixto');
  const email = 'alumno-repaso-mixto@test.com';
  openAIClassSummaryProvider.summarize = async () => ({
    bullets: ['Bullet.'],
    keyConcepts: [{ term: 'Fotosíntesis vegetal', definition: 'Proceso de las plantas.' }],
  });

  await registerStudent(meetingCode, email, 'Alumno Repaso Mixto');
  const userId = await userRepository.getUserIdByEmail(email);
  const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);

  const correcta = await seedFinishedQuestion(meetingId, '¿Cuál es la capital de Francia?', 'a');
  await seedAnswer(correcta, userId, { selectedOption: 'a', isCorrect: true, skipped: false });

  const incorrecta = await seedFinishedQuestion(meetingId, '¿Qué proceso hace la fotosíntesis en las plantas?', 'b');
  await seedAnswer(incorrecta, userId, { selectedOption: 'c', isCorrect: false, skipped: false });

  const sinResponder = await seedFinishedQuestion(meetingId, '¿Cuánto es 7 por 8?', 'd');
  // sin fila en question_answers a propósito — nunca la respondió.

  await seedTranscriptSegment(meetingCode, 'Contenido de la clase.', 0);
  await startAndEndClass(meetingCode);
  try {
    const { status, body } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200);
    assert.equal(body.review.congratulations, false);
    assert.equal(body.review.items.length, 3, 'Las cuatro preguntas de la clase tienen que aparecer, la acertada incluida.');

    const correctItem = body.review.items.find((item) => item.id === correcta);
    assert.equal(correctItem.status, 'correct');
    assert.equal(correctItem.yourAnswer, 'Opción A');
    assert.equal(correctItem.correctAnswer, 'Opción A');
    assert.equal(correctItem.relatedConcept, null, 'No hace falta un concepto relacionado para una que ya salió bien.');

    const incorrectItem = body.review.items.find((item) => item.id === incorrecta);
    assert.equal(incorrectItem.status, 'incorrect');
    assert.equal(incorrectItem.yourAnswer, 'Opción C');
    assert.equal(incorrectItem.correctAnswer, 'Opción B');
    assert.equal(incorrectItem.relatedConcept, 'Fotosíntesis vegetal', 'Debería asociar el keyConcept por superposición de palabras ("fotosíntesis"/"plantas").');

    const unansweredItem = body.review.items.find((item) => item.id === sinResponder);
    assert.equal(unansweredItem.status, 'unanswered');
    assert.equal(unansweredItem.yourAnswer, null);
    assert.equal(unansweredItem.correctAnswer, 'Opción D');
    assert.equal(unansweredItem.relatedConcept, null, 'No hay superposición de palabras con el keyConcept — no debería inventar una relación.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('caché — treinta pedidos concurrentes de la MISMA clase terminada disparan UNA sola llamada a OpenAI', async () => {
  const meetingCode = newMeetingCode('concurrencia');
  const email = 'docente-concurrencia@test.com';
  let callCount = 0;
  openAIClassSummaryProvider.summarize = async () => {
    callCount += 1;
    // Demora artificial — sin esto, en un proceso local todo pasa tan
    // rápido que el primer pedido podría resolver antes de que el
    // segundo siquiera arranque, lo que ocultaría un bug real de
    // deduplicación (el punto de este test es la CARRERA, no solo el
    // resultado cacheado ya resuelto).
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { bullets: ['Bullet único.'], keyConcepts: [] };
  };

  await registerRole(meetingCode, email, 'teacher');
  await seedTranscriptSegment(meetingCode, 'Contenido de la clase.', 0);
  await startAndEndClass(meetingCode);
  try {
    const results = await Promise.all(Array.from({ length: 30 }, () => fetchClassSummary(meetingCode, email)));
    for (const { status, body } of results) {
      assert.equal(status, 200);
      assert.deepEqual(body.bullets, ['Bullet único.']);
    }
    assert.equal(callCount, 1, 'Treinta pedidos concurrentes deberían resultar en UNA sola llamada a OpenAI.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('caché — reanudar la clase y volver a finalizarla regenera el resumen (no sirve el de la finalización anterior)', async () => {
  const meetingCode = newMeetingCode('reanudar-regenera');
  const email = 'docente-reanudar@test.com';
  let callCount = 0;
  openAIClassSummaryProvider.summarize = async () => {
    callCount += 1;
    return { bullets: [`Versión ${callCount}`], keyConcepts: [] };
  };

  await registerRole(meetingCode, email, 'teacher');
  await seedTranscriptSegment(meetingCode, 'Primera parte de la clase.', 0);
  await startAndEndClass(meetingCode);
  try {
    const first = await fetchClassSummary(meetingCode, email);
    assert.deepEqual(first.body.bullets, ['Versión 1']);

    const resumed = await classService.resumeClass(meetingCode);
    assert.equal(resumed, true, 'La clase debería poder reanudarse (finalizó hace instantes).');

    await seedTranscriptSegment(meetingCode, 'Parte final agregada tras reanudar.', 60);
    await classService.endClassManual(meetingCode);

    const second = await fetchClassSummary(meetingCode, email);
    assert.deepEqual(second.body.bullets, ['Versión 2'], 'Debería regenerar (no servir el resumen cacheado de la finalización anterior).');
    assert.equal(callCount, 2);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('caché — reusar el mismo meeting_code para una clase NUEVA nunca sirve el resumen de la clase anterior', async () => {
  const meetingCode = newMeetingCode('reuso-de-link');
  const email = 'docente-reuso@test.com';
  let callCount = 0;
  openAIClassSummaryProvider.summarize = async () => {
    callCount += 1;
    return { bullets: [`Clase ${callCount}`], keyConcepts: [] };
  };

  await registerRole(meetingCode, email, 'teacher');
  await seedTranscriptSegment(meetingCode, 'Contenido de la primera clase.', 0);
  await startAndEndClass(meetingCode);
  try {
    const first = await fetchClassSummary(meetingCode, email);
    assert.deepEqual(first.body.bullets, ['Clase 1']);

    // El docente reusa el mismo link (mismo meeting_code, mismo meetingId)
    // días después para una clase totalmente distinta.
    await classService.startClass(meetingCode);
    await seedTranscriptSegment(meetingCode, 'Contenido de la clase totalmente nueva.', 3600);
    await classService.endClassManual(meetingCode);

    const second = await fetchClassSummary(meetingCode, email);
    assert.deepEqual(second.body.bullets, ['Clase 2'], 'Nunca debería servir el resumen de la clase anterior.');
    assert.equal(callCount, 2);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('un fallo de OpenAI no deja una promesa rota cacheada para siempre — el siguiente pedido ("Reintentar") dispara un intento fresco', async () => {
  const meetingCode = newMeetingCode('reintentar-tras-fallo');
  const email = 'docente-reintentar@test.com';
  let callCount = 0;
  openAIClassSummaryProvider.summarize = async () => {
    callCount += 1;
    if (callCount === 1) throw new Error('No se pudo generar el resumen de la clase con IA — reintentá en unos segundos.');
    return { bullets: ['Éxito en el segundo intento.'], keyConcepts: [] };
  };

  await registerRole(meetingCode, email, 'teacher');
  await seedTranscriptSegment(meetingCode, 'Contenido de la clase.', 0);
  await startAndEndClass(meetingCode);
  try {
    const first = await fetchClassSummary(meetingCode, email);
    assert.equal(first.status, 502);
    assert.match(first.body.error, /reintentá/i);

    const second = await fetchClassSummary(meetingCode, email);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.bullets, ['Éxito en el segundo intento.']);
    assert.equal(callCount, 2, 'El "Reintentar" debería disparar una llamada NUEVA, no servir el rechazo cacheado.');
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('usa mainTopics/keyConcepts del análisis cacheado del documento como marco temático', async () => {
  const meetingCode = newMeetingCode('marco-tematico');
  const email = 'docente-marco-tematico@test.com';
  let receivedContext;
  openAIClassSummaryProvider.summarize = async (context) => {
    receivedContext = context;
    return { bullets: ['Bullet.'], keyConcepts: context.keyConcepts };
  };
  documentAnalysisService.getAnalysisSummary = async () => ({
    mainTopics: ['Fotosíntesis'],
    keyConcepts: [{ term: 'Clorofila', definition: 'Pigmento verde.' }],
    // `extractedText` NUNCA debería llegar al provider — no se incluye acá
    // a propósito, para que un eventual uso indebido explote en vez de
    // pasar desapercibido.
  });

  await registerRole(meetingCode, email, 'teacher');
  await seedTranscriptSegment(meetingCode, 'Hoy vimos fotosíntesis.', 0);
  await startAndEndClass(meetingCode);
  try {
    const { status } = await fetchClassSummary(meetingCode, email);
    assert.equal(status, 200);
    assert.deepEqual(receivedContext.mainTopics, ['Fotosíntesis']);
    assert.deepEqual(receivedContext.keyConcepts, [{ term: 'Clorofila', definition: 'Pigmento verde.' }]);
    assert.deepEqual(receivedContext.transcriptSegments.map((s) => s.text), ['Hoy vimos fotosíntesis.']);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});
