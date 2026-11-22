// Tests del "Quiz final" del alumno — mismas capas que `classSummary.test.js`:
//   1. `parseQuizResponse` — unitario, sin red ni base.
//   2. `finalQuizService` + el endpoint REST — base real, con
//      `openAIFinalQuizProvider.generateQuiz` MOCKEADO (nunca llama a OpenAI).
//
// El foco es la PERSONALIZACIÓN: que al modelo le llegue cómo le fue a ESTE
// alumno en cada pregunta, y qué se explicó mientras no estaba conectado —
// incluido el cruce de relojes entre `connection_sessions` y
// `transcript_segments` (ver `connectionSessionRepository.
// getStudentSessionsInTranscriptClock`). Por eso los segmentos se siembran en
// el reloj de la transcripción (UTC−3) y las sesiones con el `NOW()` de la
// base: así el test pasa igual con la base en UTC (CI) o en hora local.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-fake-key-para-este-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');
const meetingRepository = require('../src/repositories/meetingRepository');
const userRepository = require('../src/repositories/userRepository');
const classService = require('../src/services/classService');
const documentAnalysisService = require('../src/services/documentAnalysisService');
const { openAIFinalQuizProvider } = require('../src/providers');
const { parseQuizResponse } = require('../src/providers/openAIFinalQuizProvider');

let server;
let apiUrl;
let originalGenerateQuiz;
let originalGetAnalysisSummary;
let previousFlag;

const FAKE_QUESTIONS = [
  { type: 'multiple_choice', prompt: 'P1', options: ['a', 'b', 'c', 'd'], correctOptionIndex: 2, explanation: null },
  { type: 'true_false', prompt: 'P2', options: ['Verdadero', 'Falso'], correctOptionIndex: 1, explanation: null },
  { type: 'true_false', prompt: 'P3', options: ['Verdadero', 'Falso'], correctOptionIndex: 0, explanation: null },
];

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiUrl = `http://localhost:${server.address().port}`;

  originalGenerateQuiz = openAIFinalQuizProvider.generateQuiz.bind(openAIFinalQuizProvider);
  originalGetAnalysisSummary = documentAnalysisService.getAnalysisSummary;
  previousFlag = process.env.ENABLE_AI_QUESTION_GENERATION;
  process.env.ENABLE_AI_QUESTION_GENERATION = 'true';
});

test.after(async () => {
  openAIFinalQuizProvider.generateQuiz = originalGenerateQuiz;
  documentAnalysisService.getAnalysisSummary = originalGetAnalysisSummary;
  if (previousFlag === undefined) delete process.env.ENABLE_AI_QUESTION_GENERATION;
  else process.env.ENABLE_AI_QUESTION_GENERATION = previousFlag;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test.afterEach(() => {
  openAIFinalQuizProvider.generateQuiz = originalGenerateQuiz;
  documentAnalysisService.getAnalysisSummary = originalGetAnalysisSummary;
  process.env.ENABLE_AI_QUESTION_GENERATION = 'true';
});

// ─── 1. parseQuizResponse ───

test('parseQuizResponse normaliza verdadero/falso a la misma forma que opción múltiple', () => {
  const questions = parseQuizResponse(
    JSON.stringify({
      questions: [
        { type: 'multiple_choice', prompt: ' ¿Qué es X? ', options: ['a', 'b', 'c', 'd'], correctOptionIndex: 3, explanation: 'Porque sí.' },
        { type: 'true_false', prompt: 'X es Y.', correctAnswer: false, explanation: 'No lo es.' },
        { type: 'true_false', prompt: 'Z es W.', correctAnswer: true },
      ],
    })
  );
  assert.equal(questions.length, 3);
  assert.equal(questions[0].prompt, '¿Qué es X?');
  assert.equal(questions[0].correctOptionIndex, 3);
  assert.deepEqual(questions[1].options, ['Verdadero', 'Falso']);
  assert.equal(questions[1].correctOptionIndex, 1);
  assert.equal(questions[2].correctOptionIndex, 0);
  assert.equal(questions[2].explanation, null);
});

test('parseQuizResponse se queda con las 3 primeras si vienen más', () => {
  const tf = (prompt) => ({ type: 'true_false', prompt, correctAnswer: true });
  const questions = parseQuizResponse(JSON.stringify({ questions: [tf('1'), tf('2'), tf('3'), tf('4')] }));
  assert.deepEqual(questions.map((q) => q.prompt), ['1', '2', '3']);
});

// Etapa 85 — antes una sola pregunta rota tiraba el quiz entero.
test('parseQuizResponse descarta una pregunta rota y usa las otras 3, y tolera "true"/"2" como texto', () => {
  const tf = (prompt) => ({ type: 'true_false', prompt, correctAnswer: true });
  const questions = parseQuizResponse(
    JSON.stringify({
      questions: [
        tf('1'),
        { type: 'multiple_choice', prompt: 'rota', options: ['a', 'b', 'c'], correctOptionIndex: 0 },
        { type: 'true_false', prompt: '2', correctAnswer: 'false' },
        { type: 'multiple_choice', prompt: '3', options: ['a', 'b', 'c', 'd'], correctOptionIndex: '2' },
      ],
    })
  );
  assert.deepEqual(questions.map((q) => q.prompt), ['1', '2', '3']);
  assert.equal(questions[1].correctOptionIndex, 1);
  assert.equal(questions[2].correctOptionIndex, 2);
});

test('parseQuizResponse acepta el JSON aunque venga dentro de un bloque ```json', () => {
  const tf = (prompt) => ({ type: 'true_false', prompt, correctAnswer: true });
  const questions = parseQuizResponse(`\`\`\`json\n${JSON.stringify({ questions: [tf('1'), tf('2'), tf('3')] })}\n\`\`\``);
  assert.equal(questions.length, 3);
});

test('parseQuizResponse rechaza un quiz incompleto o mal formado', () => {
  const tf = { type: 'true_false', prompt: 'ok', correctAnswer: true };
  assert.throws(() => parseQuizResponse('no es json'));
  assert.throws(() => parseQuizResponse(JSON.stringify({ questions: [tf, tf] })));
  assert.throws(() =>
    parseQuizResponse(JSON.stringify({ questions: [tf, tf, { type: 'multiple_choice', prompt: 'x', options: ['a', 'b', 'c'], correctOptionIndex: 0 }] }))
  );
  assert.throws(() => parseQuizResponse(JSON.stringify({ questions: [tf, tf, { type: 'true_false', prompt: 'x', correctAnswer: 'si' }] })));
  assert.throws(() => parseQuizResponse(JSON.stringify({ questions: [tf, tf, { type: 'abierta', prompt: 'x' }] })));
});

// ─── 2. Servicio + endpoint ───

function newMeetingCode(label) {
  const letters = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `test-quiz-final-${label}-${letters}`;
}

async function post(path, body) {
  const resp = await fetch(`${apiUrl}/api/meetings/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function fetchQuiz(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const resp = await fetch(`${apiUrl}/api/meetings/${encodeURIComponent(meetingCode)}/final-quiz?${params.toString()}`);
  return { status: resp.status, body: await resp.json() };
}

// Segmento en el reloj de la transcripción (UTC−3 fijo, igual que
// `vexaService.normalizeTimestamp`), `offsetSeconds` respecto de ahora.
async function seedSegment(meetingCode, text, offsetSeconds) {
  await pool.query(
    `INSERT INTO transcript_segments (meeting_code, speaker, text, absolute_start_time, segment_id)
     VALUES (?, 'Docente', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), ?)`,
    [meetingCode, text, offsetSeconds - 3 * 3600, `${meetingCode}-${offsetSeconds}`]
  );
}

// Sesión con el reloj de la base (`NOW()`), igual que `openSession`.
async function seedSession(meetingId, userId, fromSeconds, toSeconds) {
  await pool.query(
    `INSERT INTO connection_sessions (meeting_id, user_id, connected_at, disconnected_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [meetingId, userId, fromSeconds, toSeconds]
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

// Reunión con docente + un alumno, y la clase ya detenida.
async function setupEndedClass(label) {
  const meetingCode = newMeetingCode(label);
  const teacher = `docente-${meetingCode}@test.com`;
  const student = `alumno-${meetingCode}@test.com`;
  await post('register-role', { meetingCode, email: teacher, role: 'teacher' });
  await post('register-student', { meetingCode, email: student, name: 'Alumna Quiz' });
  await classService.startClass(meetingCode);
  await classService.endClassManual(meetingCode);
  const meetingId = await meetingRepository.getMeetingIdByCode(meetingCode);
  const studentId = await userRepository.getUserIdByEmail(student);
  return { meetingCode, teacher, student, meetingId, studentId };
}

async function cleanup(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

test('el docente no puede pedir el quiz (403)', async () => {
  const { meetingCode, teacher } = await setupEndedClass('docente');
  try {
    const { status } = await fetchQuiz(meetingCode, teacher);
    assert.equal(status, 403);
  } finally {
    await cleanup(meetingCode);
  }
});

test('con la clase en curso responde 409', async () => {
  const { meetingCode, student } = await setupEndedClass('en-curso');
  try {
    await classService.startClass(meetingCode);
    const { status } = await fetchQuiz(meetingCode, student);
    assert.equal(status, 409);
  } finally {
    await cleanup(meetingCode);
  }
});

test('con la IA apagada devuelve un estado neutral, sin llamar al proveedor', async () => {
  const { meetingCode, student } = await setupEndedClass('ia-apagada');
  let called = false;
  openAIFinalQuizProvider.generateQuiz = async () => { called = true; return FAKE_QUESTIONS; };
  process.env.ENABLE_AI_QUESTION_GENERATION = 'false';
  try {
    const { status, body } = await fetchQuiz(meetingCode, student);
    assert.equal(status, 200);
    assert.equal(body.quizAvailable, false);
    assert.equal(body.unavailableReason, 'ai_disabled');
    assert.equal(called, false);
  } finally {
    await cleanup(meetingCode);
  }
});

test('sin transcripción ni material devuelve "insufficient_content", sin llamar al proveedor', async () => {
  const { meetingCode, student } = await setupEndedClass('sin-contenido');
  let called = false;
  openAIFinalQuizProvider.generateQuiz = async () => { called = true; return FAKE_QUESTIONS; };
  documentAnalysisService.getAnalysisSummary = async () => null;
  try {
    const { status, body } = await fetchQuiz(meetingCode, student);
    assert.equal(status, 200);
    assert.equal(body.unavailableReason, 'insufficient_content');
    assert.equal(called, false);
  } finally {
    await cleanup(meetingCode);
  }
});

test('le pasa al modelo cómo le fue al alumno y lo que se explicó mientras no estaba', async () => {
  const { meetingCode, student, meetingId, studentId } = await setupEndedClass('personalizado');
  let context;
  openAIFinalQuizProvider.generateQuiz = async (ctx) => { context = ctx; return FAKE_QUESTIONS; };
  documentAnalysisService.getAnalysisSummary = async () => ({ mainTopics: ['Fotosíntesis'], keyConcepts: [] });
  try {
    // Estuvo conectado de -600s a -300s; se fue y no volvió.
    await seedSession(meetingId, studentId, -600, -300);
    await seedSegment(meetingCode, 'Esto lo escuchó.', -450);
    await seedSegment(meetingCode, 'Esto se lo perdió.', -100);

    const acertada = await seedFinishedQuestion(meetingId, 'Pregunta acertada', 'a');
    const errada = await seedFinishedQuestion(meetingId, 'Pregunta errada', 'b');
    await seedFinishedQuestion(meetingId, 'Pregunta sin responder', 'c');
    await seedAnswer(acertada, studentId, { selectedOption: 'a', isCorrect: true, skipped: false });
    await seedAnswer(errada, studentId, { selectedOption: 'd', isCorrect: false, skipped: false });

    const { status, body } = await fetchQuiz(meetingCode, student);
    assert.equal(status, 200);
    assert.equal(body.quizAvailable, true);
    assert.equal(body.questions.length, 3);

    const outcomes = Object.fromEntries(context.classQuestions.map((q) => [q.prompt, q.outcome]));
    assert.deepEqual(outcomes, {
      'Pregunta acertada': 'correct',
      'Pregunta errada': 'incorrect',
      'Pregunta sin responder': 'unanswered',
    });
    assert.equal(context.classQuestions.find((q) => q.prompt === 'Pregunta errada').correctAnswer, 'Opción B');

    assert.deepEqual(context.missedSegments.map((s) => s.text), ['Esto se lo perdió.']);
    assert.deepEqual(context.transcriptSegments.map((s) => s.text), ['Esto lo escuchó.', 'Esto se lo perdió.']);
    assert.deepEqual(context.mainTopics, ['Fotosíntesis']);
  } finally {
    await cleanup(meetingCode);
  }
});

test('con un documento procesado sin resumen de IA, usa un fragmento de su texto como material', async () => {
  const { meetingCode, student } = await setupEndedClass('solo-texto');
  let context;
  openAIFinalQuizProvider.generateQuiz = async (ctx) => { context = ctx; return FAKE_QUESTIONS; };
  documentAnalysisService.getAnalysisSummary = async () => ({ extractedText: `  ${'x'.repeat(9000)}`, pageCount: 3, charCount: 9002 });
  try {
    const { status, body } = await fetchQuiz(meetingCode, student);
    assert.equal(status, 200);
    assert.equal(body.quizAvailable, true);
    assert.equal(context.documentExcerpt.length, 7998); // 8000 recortado, sin los 2 espacios del inicio
    assert.deepEqual(context.mainTopics, []);
  } finally {
    await cleanup(meetingCode);
  }
});

test('si el material tiene temas o conceptos, NO manda el texto crudo', async () => {
  const { meetingCode, student } = await setupEndedClass('con-temas');
  let context;
  openAIFinalQuizProvider.generateQuiz = async (ctx) => { context = ctx; return FAKE_QUESTIONS; };
  documentAnalysisService.getAnalysisSummary = async () => ({ extractedText: 'texto largo', mainTopics: ['Tema'], keyConcepts: [] });
  try {
    await fetchQuiz(meetingCode, student);
    assert.equal(context.documentExcerpt, '');
  } finally {
    await cleanup(meetingCode);
  }
});

test('si el proveedor falla responde 502 con el mensaje del proveedor', async () => {
  const { meetingCode, student } = await setupEndedClass('falla');
  openAIFinalQuizProvider.generateQuiz = async () => { throw new Error('No se pudo generar el quiz con IA — reintentá en unos segundos.'); };
  documentAnalysisService.getAnalysisSummary = async () => ({ mainTopics: ['Tema'], keyConcepts: [] });
  try {
    const { status, body } = await fetchQuiz(meetingCode, student);
    assert.equal(status, 502);
    assert.match(body.error, /reintentá/);
  } finally {
    await cleanup(meetingCode);
  }
});
