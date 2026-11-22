// Tests del análisis con IA del reporte de fin de clase (docente) — mismas
// capas que `classSummary.test.js`:
//   1. `OpenAIClassReportProvider` — unitario, con el `client` de OpenAI
//      reemplazado por un stub (nunca llama a la red real).
//   2. `classReportService` + los endpoints `/report/ai-analysis` y
//      `/report/document-topics` — con `openAIClassReportProvider.analyze`
//      mockeado, para probar la orquestación (autorización, flag, caché)
//      contra la base real sin gastar saldo ni necesitar `OPENAI_API_KEY`.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-fake-key-para-este-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');
const documentAnalysisService = require('../src/services/documentAnalysisService');
const { openAIClassReportProvider } = require('../src/providers');
const { OpenAIClassReportProvider } = require('../src/providers/openAIClassReportProvider');
const { ClassReportProvider } = require('../src/providers/classReportProvider');

let server;
let apiUrl;
let originalAnalyze;
let originalGetAnalysisSummary;
let previousFlag;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiUrl = `http://localhost:${server.address().port}`;

  originalAnalyze = openAIClassReportProvider.analyze;
  originalGetAnalysisSummary = documentAnalysisService.getAnalysisSummary;
  previousFlag = process.env.ENABLE_AI_CLASS_REPORT;
});

test.after(async () => {
  openAIClassReportProvider.analyze = originalAnalyze;
  documentAnalysisService.getAnalysisSummary = originalGetAnalysisSummary;
  if (previousFlag === undefined) delete process.env.ENABLE_AI_CLASS_REPORT;
  else process.env.ENABLE_AI_CLASS_REPORT = previousFlag;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function nuevoMeetingCode(etiqueta) {
  return `test-reporte-${etiqueta}-${crypto.randomBytes(4).toString('hex')}`;
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

async function postJson(path, body) {
  const resp = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json() };
}

async function getJson(path) {
  const resp = await fetch(`${apiUrl}${path}`);
  return { status: resp.status, body: await resp.json() };
}

function pedirAnalisis(meetingCode, email) {
  return getJson(`/api/meetings/${encodeURIComponent(meetingCode)}/report/ai-analysis?${new URLSearchParams({ email })}`);
}

function pedirTemas(meetingCode, email) {
  return getJson(`/api/meetings/${encodeURIComponent(meetingCode)}/report/document-topics?${new URLSearchParams({ email })}`);
}

// Docente + dos alumnos registrados por la API real, una pregunta
// finalizada (correcta = "a") y las respuestas: Ana acierta, Beto erra.
async function prepararClaseConRespuestas(meetingCode) {
  await postJson('/api/meetings/register-role', { meetingCode, email: 'docente@test.com', role: 'teacher' });
  await postJson('/api/meetings/register-role', { meetingCode, email: 'ana@test.com', role: 'student' });
  await postJson('/api/meetings/register-student', { meetingCode, email: 'ana@test.com', name: 'Ana' });
  await postJson('/api/meetings/register-role', { meetingCode, email: 'beto@test.com', role: 'student' });
  await postJson('/api/meetings/register-student', { meetingCode, email: 'beto@test.com', name: 'Beto' });

  const [[meeting]] = await pool.query('SELECT id FROM meetings WHERE meeting_code = ?', [meetingCode]);
  const [pregunta] = await pool.query(
    `INSERT INTO questions
       (meeting_id, prompt, option_a, option_b, option_c, option_d, correct_option, duration_seconds, status, started_at, expires_at, finished_at)
     VALUES (?, '¿Capital de Francia?', 'París', 'Roma', 'Madrid', 'Berlín', 'a', 15, 'finished', NOW(), NOW(), NOW())`,
    [meeting.id]
  );
  const [[ana]] = await pool.query('SELECT id FROM users WHERE email = ?', ['ana@test.com']);
  const [[beto]] = await pool.query('SELECT id FROM users WHERE email = ?', ['beto@test.com']);
  await pool.query(
    `INSERT INTO question_answers (question_id, user_id, selected_option, is_correct, skipped, response_time_ms)
     VALUES (?, ?, 'a', TRUE, FALSE, 1000), (?, ?, 'b', FALSE, FALSE, 1500)`,
    [pregunta.insertId, ana.id, pregunta.insertId, beto.id]
  );
  return { meetingId: meeting.id, questionId: pregunta.insertId };
}

const ANALISIS_FALSO = {
  strengths: ['Geografía'],
  weaknesses: ['Capitales'],
  questionDiagnostics: [],
  studentRecommendations: [{ name: 'Beto', recommendation: 'Repasar capitales de Europa.' }],
  suggestedTopics: ['Capitales europeas'],
};

function respuestaDeOpenAI(content) {
  return {
    model: 'gpt-4o-mini',
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 300, completion_tokens: 80, total_tokens: 380 },
  };
}

// ─── 1. Proveedor (unitario, sin red) ───────────────────────────────────

test('ClassReportProvider (contrato base) exige implementar analyze()', async () => {
  await assert.rejects(() => new ClassReportProvider().analyze({}), /no implementado|implement/i);
});

test('OpenAIClassReportProvider.analyze() manda instrucciones en "system", los datos en "user" y filtra lo inválido', async () => {
  const provider = new OpenAIClassReportProvider();
  let params;
  provider.client = {
    chat: {
      completions: {
        create: async (p) => {
          params = p;
          return respuestaDeOpenAI(JSON.stringify({
            strengths: ['Bien en geografía', '  '],
            weaknesses: ['Capitales', 7],
            questionDiagnostics: [
              { questionId: 1, diagnosis: 'pregunta_confusa', explanation: 'Todos eligieron Roma.' },
              { questionId: 2, diagnosis: 'otra_cosa', explanation: 'no válido' },
            ],
            studentRecommendations: [{ name: 'Beto', recommendation: 'Repasar.' }, { name: 3 }],
            suggestedTopics: ['Europa'],
          }));
        },
      },
    },
  };

  const questions = [{
    id: 1,
    prompt: '¿Capital de Francia?',
    optionDistribution: [
      { label: 'París', count: 1, correct: true },
      { label: 'Roma', count: 1, correct: false },
      { label: 'Madrid', count: 0, correct: false },
      { label: 'Berlín', count: 0, correct: false },
    ],
  }];
  const studentAnswers = [
    { questionId: 1, studentName: 'Ana', selectedOption: 'a', isCorrect: true, skipped: false },
    { questionId: 1, studentName: 'Beto', selectedOption: 'b', isCorrect: false, skipped: false },
    { questionId: 1, studentName: 'Ceci', selectedOption: null, isCorrect: null, skipped: true },
    { questionId: 1, studentName: 'Dani', selectedOption: null, isCorrect: null, skipped: null },
  ];

  const result = await provider.analyze({ questions, studentAnswers });

  assert.equal(params.messages[0].role, 'system');
  assert.equal(params.messages[1].role, 'user');
  assert.match(params.messages[1].content, /París — 1 alumno\(s\) \[CORRECTA\]/);
  assert.match(params.messages[1].content, /- Beto: pregunta 1: incorrecta/);
  assert.match(params.messages[1].content, /- Ceci: pregunta 1: salteó/);
  assert.match(params.messages[1].content, /- Dani: pregunta 1: no respondió/);
  assert.equal(params.response_format.type, 'json_schema');
  assert.equal(params.response_format.json_schema.strict, true);

  assert.deepEqual(result.strengths, ['Bien en geografía']);
  assert.deepEqual(result.weaknesses, ['Capitales']);
  assert.equal(result.questionDiagnostics.length, 1);
  assert.equal(result.studentRecommendations.length, 1);
  assert.equal(result.model, 'gpt-4o-mini');
  assert.equal(result.inputTokens, 300);
  assert.equal(result.outputTokens, 80);
});

test('OpenAIClassReportProvider.analyze() sin datos arma el mensaje con los textos de "sin preguntas"/"sin respuestas"', async () => {
  const provider = new OpenAIClassReportProvider();
  let params;
  provider.client = {
    chat: { completions: { create: async (p) => { params = p; return respuestaDeOpenAI(JSON.stringify(ANALISIS_FALSO)); } } },
  };
  await provider.analyze();
  assert.match(params.messages[1].content, /\(sin preguntas finalizadas\)/);
  assert.match(params.messages[1].content, /\(sin respuestas registradas\)/);
});

test('OpenAIClassReportProvider.analyze() reintenta ante una respuesta con forma inválida y falla con un mensaje para el usuario', async () => {
  const provider = new OpenAIClassReportProvider();
  let llamadas = 0;
  provider.client = {
    chat: {
      completions: {
        create: async () => {
          llamadas += 1;
          return respuestaDeOpenAI(llamadas === 1 ? 'esto no es JSON' : JSON.stringify({ strengths: [] }));
        },
      },
    },
  };
  await assert.rejects(() => provider.analyze({}), /No se pudo generar el análisis del reporte/);
  assert.equal(llamadas, 3, 'tres intentos en total');
});

// ─── 2. Servicio + endpoints (base real, proveedor mockeado) ────────────

test('GET /report/ai-analysis: 400 sin email, 403 a quien no es docente, 404 si la reunión no existe', async () => {
  const meetingCode = nuevoMeetingCode('auth');
  await prepararClaseConRespuestas(meetingCode);

  const sinEmail = await getJson(`/api/meetings/${meetingCode}/report/ai-analysis`);
  assert.equal(sinEmail.status, 400);

  const alumno = await pedirAnalisis(meetingCode, 'ana@test.com');
  assert.equal(alumno.status, 403);

  const temasAlumno = await pedirTemas(meetingCode, 'ana@test.com');
  assert.equal(temasAlumno.status, 403);

  const sinEmailTemas = await getJson(`/api/meetings/${meetingCode}/report/document-topics`);
  assert.equal(sinEmailTemas.status, 400);

  // Sin la reunión tampoco queda el rol (la participación cuelga de ella por
  // cascada), así que se rechaza con 403 antes de llegar a buscarla.
  await limpiarReunion(meetingCode);
  const inexistente = await pedirAnalisis(meetingCode, 'docente@test.com');
  assert.equal(inexistente.status, 403);
});

test('GET /report/ai-analysis con el flag apagado devuelve 200 con aiAnalysisAvailable=false y no llama a la IA', async () => {
  const meetingCode = nuevoMeetingCode('flag-off');
  await prepararClaseConRespuestas(meetingCode);
  process.env.ENABLE_AI_CLASS_REPORT = 'false';
  let llamadas = 0;
  openAIClassReportProvider.analyze = async () => { llamadas += 1; return ANALISIS_FALSO; };

  try {
    const { status, body } = await pedirAnalisis(meetingCode, 'docente@test.com');
    assert.equal(status, 200);
    assert.equal(body.aiAnalysisAvailable, false);
    assert.equal(body.reason, 'ai_disabled');
    assert.equal(llamadas, 0);
  } finally {
    openAIClassReportProvider.analyze = originalAnalyze;
    await limpiarReunion(meetingCode);
  }
});

test('GET /report/ai-analysis con el flag prendido arma el análisis con preguntas y respuestas reales, y lo cachea por reunión', async () => {
  const meetingCode = nuevoMeetingCode('cache');
  const { questionId } = await prepararClaseConRespuestas(meetingCode);
  process.env.ENABLE_AI_CLASS_REPORT = 'true';
  let llamadas = 0;
  let recibido;
  openAIClassReportProvider.analyze = async (args) => {
    llamadas += 1;
    recibido = args;
    return ANALISIS_FALSO;
  };

  try {
    const [r1, r2] = await Promise.all([
      pedirAnalisis(meetingCode, 'docente@test.com'),
      pedirAnalisis(meetingCode, 'docente@test.com'),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.aiAnalysisAvailable, true);
    assert.deepEqual(r1.body.studentRecommendations, ANALISIS_FALSO.studentRecommendations);
    assert.deepEqual(r2.body.strengths, ANALISIS_FALSO.strengths);
    assert.equal(llamadas, 1, 'dos pedidos concurrentes, una sola llamada a la IA');

    assert.equal(recibido.questions.length, 1);
    assert.equal(recibido.questions[0].id, questionId);
    const porAlumno = Object.fromEntries(recibido.studentAnswers.map((a) => [a.studentName, a]));
    assert.equal(porAlumno.Ana.isCorrect, true);
    assert.equal(porAlumno.Beto.isCorrect, false);
    assert.equal(porAlumno.Beto.selectedOption, 'b');
  } finally {
    openAIClassReportProvider.analyze = originalAnalyze;
    await limpiarReunion(meetingCode);
  }
});

test('GET /report/ai-analysis: si la IA falla responde 502 y no deja el error cacheado', async () => {
  const meetingCode = nuevoMeetingCode('falla');
  await prepararClaseConRespuestas(meetingCode);
  process.env.ENABLE_AI_CLASS_REPORT = 'true';
  let llamadas = 0;
  openAIClassReportProvider.analyze = async () => {
    llamadas += 1;
    if (llamadas === 1) throw new Error('OpenAI no respondió.');
    return ANALISIS_FALSO;
  };

  try {
    const primero = await pedirAnalisis(meetingCode, 'docente@test.com');
    assert.equal(primero.status, 502);
    assert.match(primero.body.error, /OpenAI no respondió/);

    const segundo = await pedirAnalisis(meetingCode, 'docente@test.com');
    assert.equal(segundo.status, 200);
    assert.equal(llamadas, 2, 'el fallo se descartó del caché y se reintentó');
  } finally {
    openAIClassReportProvider.analyze = originalAnalyze;
    await limpiarReunion(meetingCode);
  }
});

test('GET /report/document-topics devuelve los temas del documento analizado, o una lista vacía si no hay', async () => {
  const meetingCode = nuevoMeetingCode('temas');
  const { meetingId } = await prepararClaseConRespuestas(meetingCode);

  try {
    documentAnalysisService.getAnalysisSummary = async (id) => {
      assert.equal(id, meetingId);
      return { mainTopics: ['Fotosíntesis', 'Respiración celular'], keyConcepts: [] };
    };
    const conTemas = await pedirTemas(meetingCode, 'docente@test.com');
    assert.equal(conTemas.status, 200);
    assert.deepEqual(conTemas.body.topics, ['Fotosíntesis', 'Respiración celular']);

    documentAnalysisService.getAnalysisSummary = async () => null;
    const sinDocumento = await pedirTemas(meetingCode, 'docente@test.com');
    assert.deepEqual(sinDocumento.body.topics, []);
  } finally {
    documentAnalysisService.getAnalysisSummary = originalGetAnalysisSummary;
    await limpiarReunion(meetingCode);
  }
});
