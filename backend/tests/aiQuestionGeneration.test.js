// Tests de la generación de preguntas con IA (reemplazo de
// `RandomQuestionProvider` detrás de `ENABLE_AI_QUESTION_GENERATION`) —
// cuatro capas, de más abajo a más arriba:
//   1. `transcriptRepository.getRecentSegments` — contra la base real.
//   2. `questionRepository.getRecentPromptsForMeeting` — contra la base real.
//   3. `OpenAIQuestionProvider` — unitario, con el `client` de OpenAI
//      reemplazado por un stub (nunca llama a la red real).
//   4. `questionService.generatePreview` + el endpoint REST completo —
//      con `openAIQuestionProvider.generateQuestion`/`randomQuestionProvider.
//      generateQuestion` MOCKEADOS (mismo mecanismo que
//      `documentAnalysis.test.js`: se reemplaza el método de la instancia
//      real que exporta `../src/providers`), para probar la ORQUESTACIÓN
//      (auth, armado del contexto, elección de proveedor) sin gastar
//      saldo real ni necesitar `OPENAI_API_KEY`.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-fake-key-para-este-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');
const transcriptRepository = require('../src/repositories/transcriptRepository');
const questionRepository = require('../src/repositories/questionRepository');
const meetingRepository = require('../src/repositories/meetingRepository');
const { randomQuestionProvider, openAIQuestionProvider } = require('../src/providers');
const { OpenAIQuestionProvider } = require('../src/providers/openAIQuestionProvider');

let server;
let apiUrl;
let originalRandomGenerate;
let originalOpenAIGenerate;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  apiUrl = `http://localhost:${port}`;

  originalRandomGenerate = randomQuestionProvider.generateQuestion.bind(randomQuestionProvider);
  originalOpenAIGenerate = openAIQuestionProvider.generateQuestion.bind(openAIQuestionProvider);
});

test.after(async () => {
  randomQuestionProvider.generateQuestion = originalRandomGenerate;
  openAIQuestionProvider.generateQuestion = originalOpenAIGenerate;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function newMeetingCode(label) {
  const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `test-ia-preguntas-${label}-${letters(6)}`;
}

async function registerRole(meetingCode, email, role) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role }),
  });
  return resp.json();
}

async function fetchGeneratedQuestion(meetingCode, email, discardedPrompts) {
  const resp = await fetch(`${apiUrl}/api/meetings/generate-question`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, discardedPrompts }),
  });
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

// ─── 1. transcriptRepository.getRecentSegments ───

test('getRecentSegments trae los últimos N segmentos en orden CRONOLÓGICO (no el orden inverso del ORDER BY interno)', async () => {
  const meetingCode = newMeetingCode('transcript');
  await pool.query('INSERT INTO meetings (meeting_code) VALUES (?)', [meetingCode]);
  try {
    for (let i = 0; i < 5; i++) {
      await seedTranscriptSegment(meetingCode, `Fragmento ${i}`, i);
    }
    const recent = await transcriptRepository.getRecentSegments(meetingCode, 3);
    assert.deepEqual(
      recent.map((r) => r.text),
      ['Fragmento 2', 'Fragmento 3', 'Fragmento 4'],
      'Debería traer los 3 MÁS RECIENTES, en orden cronológico (viejo → nuevo).'
    );
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('getRecentSegments devuelve un array vacío para una reunión sin transcripción', async () => {
  const meetingCode = newMeetingCode('sin-transcripcion');
  await pool.query('INSERT INTO meetings (meeting_code) VALUES (?)', [meetingCode]);
  try {
    const recent = await transcriptRepository.getRecentSegments(meetingCode, 40);
    assert.deepEqual(recent, []);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

// ─── 2. questionRepository.getRecentPromptsForMeeting ───

test('getRecentPromptsForMeeting trae los enunciados de una reunión, respetando el límite', async () => {
  const meetingCode = newMeetingCode('prompts-previos');
  const [m] = await pool.query('INSERT INTO meetings (meeting_code) VALUES (?)', [meetingCode]);
  try {
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO questions (meeting_id, prompt, option_a, option_b, option_c, option_d, correct_option, duration_seconds, status, started_at, expires_at, finished_at)
         VALUES (?, ?, 'a', 'b', 'c', 'd', 'a', 20, 'finished', NOW(), NOW(), NOW())`,
        [m.insertId, `Pregunta ${i}`]
      );
    }
    const prompts = await questionRepository.getRecentPromptsForMeeting(meetingCode, 2);
    assert.equal(prompts.length, 2);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

// ─── 3. OpenAIQuestionProvider (unitario, cliente stubeado) ───

function fakeChatCompletion({ content, model = 'gpt-4o-mini' } = {}) {
  return {
    model,
    choices: [{ message: { content: content ?? JSON.stringify({ prompt: '¿Pregunta?', options: ['A', 'B', 'C', 'D'], correctOptionIndex: 0 }) } }],
    usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
  };
}

test('OpenAIQuestionProvider.generateQuestion() llama a Chat Completions con salida estructurada (json_schema estricto), temperature ~0.4, y el modelo económico por default', async () => {
  const provider = new OpenAIQuestionProvider();
  let capturedParams;
  provider.client = {
    chat: { completions: { create: async (params) => { capturedParams = params; return fakeChatCompletion(); } } },
  };

  const previousModel = process.env.OPENAI_QUESTION_MODEL;
  delete process.env.OPENAI_QUESTION_MODEL;
  try {
    await provider.generateQuestion({ mainTopics: ['Tema A'], keyConcepts: [], transcriptSegments: [], previousPrompts: [] });
    assert.equal(capturedParams.model, 'gpt-4o-mini');
    assert.equal(capturedParams.response_format.type, 'json_schema');
    assert.equal(capturedParams.response_format.json_schema.strict, true);
    assert.equal(capturedParams.temperature, 0.4);
    assert.equal(capturedParams.messages[0].role, 'system');
    assert.equal(capturedParams.messages[1].role, 'user');
    assert.match(capturedParams.messages[1].content, /Tema A/);
  } finally {
    if (previousModel === undefined) delete process.env.OPENAI_QUESTION_MODEL;
    else process.env.OPENAI_QUESTION_MODEL = previousModel;
  }
});

test('el user message dice explícitamente que no hay transcripción cuando no se pasa ninguna', async () => {
  const provider = new OpenAIQuestionProvider();
  let capturedParams;
  provider.client = {
    chat: { completions: { create: async (params) => { capturedParams = params; return fakeChatCompletion(); } } },
  };

  await provider.generateQuestion({ mainTopics: ['Tema A'], keyConcepts: [], transcriptSegments: [], previousPrompts: [] });
  assert.match(capturedParams.messages[1].content, /Todavía no hay transcripción disponible\./);
});

test('el user message incluye la transcripción concatenada y las preguntas previas cuando se pasan', async () => {
  const provider = new OpenAIQuestionProvider();
  let capturedParams;
  provider.client = {
    chat: { completions: { create: async (params) => { capturedParams = params; return fakeChatCompletion(); } } },
  };

  await provider.generateQuestion({
    mainTopics: ['Fotosíntesis'],
    keyConcepts: [{ term: 'Clorofila', definition: 'Pigmento verde.' }],
    transcriptSegments: [{ speaker: 'Docente', text: 'Hoy vemos fotosíntesis.' }],
    previousPrompts: ['¿Qué es la clorofila?'],
  });

  const content = capturedParams.messages[1].content;
  assert.match(content, /Fotosíntesis/);
  assert.match(content, /Clorofila: Pigmento verde\./);
  assert.match(content, /\[Docente\]: Hoy vemos fotosíntesis\./);
  assert.match(content, /¿Qué es la clorofila\?/);
});

test('parseo defensivo — una respuesta con menos de 4 opciones se rechaza con un error claro', async () => {
  const provider = new OpenAIQuestionProvider();
  provider.client = {
    chat: {
      completions: {
        create: async () => fakeChatCompletion({ content: JSON.stringify({ prompt: '¿Pregunta?', options: ['A', 'B', 'C'], correctOptionIndex: 0 }) }),
      },
    },
  };

  await assert.rejects(() => provider.generateQuestion({ mainTopics: [], keyConcepts: [], transcriptSegments: [], previousPrompts: [] }), /reintentá/i);
});

test('parseo defensivo — un correctOptionIndex fuera de rango (0-3) se rechaza con un error claro', async () => {
  const provider = new OpenAIQuestionProvider();
  provider.client = {
    chat: {
      completions: {
        create: async () => fakeChatCompletion({ content: JSON.stringify({ prompt: '¿Pregunta?', options: ['A', 'B', 'C', 'D'], correctOptionIndex: 4 }) }),
      },
    },
  };

  await assert.rejects(() => provider.generateQuestion({ mainTopics: [], keyConcepts: [], transcriptSegments: [], previousPrompts: [] }), /reintentá/i);
});

// Etapa 85 — el error de "formato inválido" que veía el usuario.
test('una respuesta con forma inválida se vuelve a pedir sola, y el docente recibe la pregunta del segundo intento', async () => {
  const provider = new OpenAIQuestionProvider();
  let calls = 0;
  provider.client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          if (calls === 1) return fakeChatCompletion({ content: JSON.stringify({ prompt: '¿Pregunta?', options: ['A', 'B', 'C'], correctOptionIndex: 0 }) });
          return fakeChatCompletion();
        },
      },
    },
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const question = await provider.generateQuestion({ mainTopics: [], keyConcepts: [], transcriptSegments: [], previousPrompts: [] });
    assert.equal(calls, 2);
    assert.equal(question.options.length, 4);
  } finally {
    console.error = originalConsoleError;
  }
});

test('si el modelo configurado no acepta la salida estructurada (400), se sigue con json_object', async () => {
  const provider = new OpenAIQuestionProvider();
  const formats = [];
  provider.client = {
    chat: {
      completions: {
        create: async (params) => {
          formats.push(params.response_format.type);
          if (params.response_format.type === 'json_schema') {
            throw Object.assign(new Error("400 Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model."), { status: 400 });
          }
          return fakeChatCompletion();
        },
      },
    },
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const question = await provider.generateQuestion({ mainTopics: [], keyConcepts: [], transcriptSegments: [], previousPrompts: [] });
    assert.deepEqual(formats, ['json_schema', 'json_object']);
    assert.equal(question.prompt, '¿Pregunta?');
  } finally {
    console.error = originalConsoleError;
  }
});

test('un error del SDK de OpenAI nunca llega tal cual al llamador — se traduce, y el docente puede reintentar (mensaje lo indica)', async () => {
  const provider = new OpenAIQuestionProvider();
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
      () => provider.generateQuestion({ mainTopics: [], keyConcepts: [], transcriptSegments: [], previousPrompts: [] }),
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

test('summarize() devuelve el uso de tokens tal cual lo reporta la API, para poder loguear el costo real', async () => {
  const provider = new OpenAIQuestionProvider();
  provider.client = {
    chat: {
      completions: {
        create: async () => fakeChatCompletion(),
      },
    },
  };
  const originalConsoleLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await provider.generateQuestion({ mainTopics: [], keyConcepts: [], transcriptSegments: [], previousPrompts: [] });
    assert.ok(logged.some((line) => /tokens:.*prompt=200.*completion=30.*total=230/.test(line)));
  } finally {
    console.log = originalConsoleLog;
  }
});

// ─── 4. questionService.generatePreview + el endpoint REST completo ───

test('POST /generate-question exige meetingCode y email (400 si faltan)', async () => {
  const resp1 = await fetch(`${apiUrl}/api/meetings/generate-question`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(resp1.status, 400);

  const resp2 = await fetch(`${apiUrl}/api/meetings/generate-question`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode: 'x' }),
  });
  assert.equal(resp2.status, 400);
});

test('POST /generate-question rechaza con 403 a quien no es el docente de esa reunión', async () => {
  const meetingCode = newMeetingCode('no-docente');
  await registerRole(meetingCode, 'alumno@test.com', 'student');
  try {
    const { status, body } = await fetchGeneratedQuestion(meetingCode, 'alumno@test.com');
    assert.equal(status, 403);
    assert.match(body.error, /docente/i);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('con el flag de IA APAGADO (default), sigue usando el banco random — nunca llama a OpenAI', async () => {
  const meetingCode = newMeetingCode('flag-apagado');
  const email = 'docente-random@test.com';
  let randomCallCount = 0;
  let aiCallCount = 0;
  randomQuestionProvider.generateQuestion = async () => {
    randomCallCount += 1;
    return { prompt: '¿Pregunta random?', options: ['A', 'B', 'C', 'D'], correctOptionIndex: 1 };
  };
  openAIQuestionProvider.generateQuestion = async () => {
    aiCallCount += 1;
    throw new Error('no debería llamarse con el flag apagado');
  };

  await registerRole(meetingCode, email, 'teacher');
  try {
    const { status, body } = await fetchGeneratedQuestion(meetingCode, email);
    assert.equal(status, 200);
    assert.deepEqual(body, { prompt: '¿Pregunta random?', options: ['A', 'B', 'C', 'D'], correctOptionIndex: 1 });
    assert.equal(randomCallCount, 1);
    assert.equal(aiCallCount, 0);
  } finally {
    await cleanupMeeting(meetingCode);
  }
});

test('con el flag de IA ACTIVO, arma el contexto (temas/conceptos del resumen, transcripción reciente, preguntas previas) y llama al provider de IA', async () => {
  const meetingCode = newMeetingCode('flag-activo');
  const email = 'docente-ia@test.com';
  let receivedContext;
  openAIQuestionProvider.generateQuestion = async (context) => {
    receivedContext = context;
    return { prompt: '¿Pregunta de IA?', options: ['A', 'B', 'C', 'D'], correctOptionIndex: 2 };
  };

  await registerRole(meetingCode, email, 'teacher');
  const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
  await seedTranscriptSegment(meetingCode, 'Estamos viendo fotosíntesis.', 0);
  await pool.query(
    `INSERT INTO questions (meeting_id, prompt, option_a, option_b, option_c, option_d, correct_option, duration_seconds, status, started_at, expires_at, finished_at)
     VALUES (?, 'Pregunta previa', 'a', 'b', 'c', 'd', 'a', 20, 'finished', NOW(), NOW(), NOW())`,
    [meetingId]
  );

  const previousFlag = process.env.ENABLE_AI_QUESTION_GENERATION;
  process.env.ENABLE_AI_QUESTION_GENERATION = 'true';
  try {
    const { status, body } = await fetchGeneratedQuestion(meetingCode, email, ['Pregunta descartada sin enviar']);
    assert.equal(status, 200, `Debería aceptar. Body: ${JSON.stringify(body)}`);
    // El mock no devuelve `suggestedDurationSeconds` — cae al default (30,
    // ver `DEFAULT_DURATION_SECONDS` en `questionService.js`), que
    // `generatePreview` agrega siempre en el camino de IA.
    assert.deepEqual(body, { prompt: '¿Pregunta de IA?', options: ['A', 'B', 'C', 'D'], correctOptionIndex: 2, suggestedDurationSeconds: 30 });

    // `extractedText` NUNCA debería viajar en el contexto — solo mainTopics/
    // keyConcepts (ver `questionService.generatePreview`).
    assert.ok(!('extractedText' in receivedContext), 'El contexto no debería incluir extractedText.');
    assert.deepEqual(receivedContext.transcriptSegments.map((s) => s.text), ['Estamos viendo fotosíntesis.']);
    // Enunciados YA ENVIADOS (de la base) + los DESCARTADOS que mandó el
    // cliente (de esta tanda, sin enviar) — ambos en la misma lista.
    assert.deepEqual(receivedContext.previousPrompts, ['Pregunta previa', 'Pregunta descartada sin enviar']);
    assert.deepEqual(receivedContext.mainTopics, []); // sin documento cargado en esta reunión
    assert.deepEqual(receivedContext.keyConcepts, []);
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_AI_QUESTION_GENERATION;
    else process.env.ENABLE_AI_QUESTION_GENERATION = previousFlag;
    await cleanupMeeting(meetingCode);
  }
});

test('discardedPrompts con basura (no-strings, no-array) se sanea sin romper la petición', async () => {
  const meetingCode = newMeetingCode('descartados-basura');
  const email = 'docente-descartados-basura@test.com';
  let receivedContext;
  openAIQuestionProvider.generateQuestion = async (context) => {
    receivedContext = context;
    return { prompt: '¿Pregunta?', options: ['A', 'B', 'C', 'D'], correctOptionIndex: 0 };
  };

  await registerRole(meetingCode, email, 'teacher');
  const previousFlag = process.env.ENABLE_AI_QUESTION_GENERATION;
  process.env.ENABLE_AI_QUESTION_GENERATION = 'true';
  try {
    const { status } = await fetchGeneratedQuestion(meetingCode, email, ['Válido', 42, null, '', { no: 'es un string' }]);
    assert.equal(status, 200);
    assert.deepEqual(receivedContext.previousPrompts, ['Válido']);
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_AI_QUESTION_GENERATION;
    else process.env.ENABLE_AI_QUESTION_GENERATION = previousFlag;
    await cleanupMeeting(meetingCode);
  }
});

test('suggestedDurationSeconds: un valor de la IA que SÍ es uno de los presets permitidos se respeta tal cual', async () => {
  const meetingCode = newMeetingCode('duracion-sugerida-valida');
  const email = 'docente-duracion-valida@test.com';
  openAIQuestionProvider.generateQuestion = async () => ({
    prompt: '¿Pregunta?',
    options: ['A', 'B', 'C', 'D'],
    correctOptionIndex: 0,
    suggestedDurationSeconds: 60,
  });

  await registerRole(meetingCode, email, 'teacher');
  const previousFlag = process.env.ENABLE_AI_QUESTION_GENERATION;
  process.env.ENABLE_AI_QUESTION_GENERATION = 'true';
  try {
    const { body } = await fetchGeneratedQuestion(meetingCode, email);
    assert.equal(body.suggestedDurationSeconds, 60);
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_AI_QUESTION_GENERATION;
    else process.env.ENABLE_AI_QUESTION_GENERATION = previousFlag;
    await cleanupMeeting(meetingCode);
  }
});

test('suggestedDurationSeconds: un valor que NO es uno de los presets (ej. 25) cae al default (30) sin romper la respuesta', async () => {
  const meetingCode = newMeetingCode('duracion-sugerida-invalida');
  const email = 'docente-duracion-invalida@test.com';
  openAIQuestionProvider.generateQuestion = async () => ({
    prompt: '¿Pregunta?',
    options: ['A', 'B', 'C', 'D'],
    correctOptionIndex: 0,
    suggestedDurationSeconds: 25,
  });

  await registerRole(meetingCode, email, 'teacher');
  const previousFlag = process.env.ENABLE_AI_QUESTION_GENERATION;
  process.env.ENABLE_AI_QUESTION_GENERATION = 'true';
  try {
    const { status, body } = await fetchGeneratedQuestion(meetingCode, email);
    assert.equal(status, 200, `No debería romper la respuesta. Body: ${JSON.stringify(body)}`);
    assert.equal(body.suggestedDurationSeconds, 30);
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_AI_QUESTION_GENERATION;
    else process.env.ENABLE_AI_QUESTION_GENERATION = previousFlag;
    await cleanupMeeting(meetingCode);
  }
});

test('si la generación con IA falla, el endpoint devuelve un error claro (nunca un 200 con basura, ni tira al docente sin respuesta)', async () => {
  const meetingCode = newMeetingCode('ia-falla');
  const email = 'docente-ia-falla@test.com';
  openAIQuestionProvider.generateQuestion = async () => {
    throw new Error('No se pudo generar la pregunta con IA — reintentá en unos segundos.');
  };

  await registerRole(meetingCode, email, 'teacher');
  const previousFlag = process.env.ENABLE_AI_QUESTION_GENERATION;
  process.env.ENABLE_AI_QUESTION_GENERATION = 'true';
  try {
    const { status, body } = await fetchGeneratedQuestion(meetingCode, email);
    assert.equal(status, 502, 'Un fallo del provider de IA es un error de un servicio upstream, no un 500 genérico.');
    assert.match(body.error, /reintentá/i, 'El mensaje CLARO del provider debería llegar tal cual al frontend, no un "Error interno" genérico.');
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_AI_QUESTION_GENERATION;
    else process.env.ENABLE_AI_QUESTION_GENERATION = previousFlag;
    await cleanupMeeting(meetingCode);
  }
});
