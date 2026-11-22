// Tests de integración REALES de los endpoints de historial de preguntas
// ("Preguntas realizadas" del docente, "Preguntas respondidas" del alumno)
// — mismo patrón que `reuniones.test.js`: servidor Express real en un
// puerto efímero, base de datos real (requiere `npm run init-db` corrido
// antes).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');

let server;
let apiUrl;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  apiUrl = `http://localhost:${port}`;
});

test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function nuevoMeetingCode(etiqueta) {
  return `test-historial-${etiqueta}-${crypto.randomBytes(4).toString('hex')}`;
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

async function consultarHistorialDocente(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/questions/history?${params.toString()}`);
  return { status: resp.status, body: await resp.json() };
}

async function consultarMisRespuestas(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/questions/my-answers?${params.toString()}`);
  return { status: resp.status, body: await resp.json() };
}

// Arma una reunión con un docente + N alumnos, y devuelve sus ids. Réplica
// a mano de lo que hacen `/register-role`/`/register-student` en
// producción (mismo criterio que `questions.test.js`).
async function crearReunion(meetingCode, teacherEmail, students) {
  const connection = await pool.getConnection();
  const studentIds = {};
  try {
    const [meeting] = await connection.query(
      'INSERT INTO meetings (meeting_code) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [meetingCode]
    );
    const meetingId = meeting.insertId;

    const [teacherUser] = await connection.query(
      'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [teacherEmail]
    );
    await connection.query(`INSERT INTO participations (meeting_id, user_id, role) VALUES (?, ?, 'teacher')`, [
      meetingId,
      teacherUser.insertId,
    ]);

    for (const [email, name] of students) {
      const [user] = await connection.query(
        'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
        [email]
      );
      await connection.query(
        `INSERT INTO participations (meeting_id, user_id, role, name, normalized_name) VALUES (?, ?, 'student', ?, ?)`,
        [meetingId, user.insertId, name, name.toLowerCase()]
      );
      studentIds[email] = user.insertId;
    }

    return { meetingId, studentIds };
  } finally {
    connection.release();
  }
}

// Inserta una pregunta directo por SQL, en el estado que se le pida
// ('active' o 'finished') — evita pasar por todo el flujo WS solo para
// preparar el escenario de estos tests, que son sobre el endpoint REST en
// sí, no sobre el flujo de envío.
async function crearPregunta(meetingId, { status = 'finished', correctOption = 'a' } = {}) {
  const [result] = await pool.query(
    `INSERT INTO questions
       (meeting_id, prompt, option_a, option_b, option_c, option_d, correct_option, duration_seconds, status, started_at, expires_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 20, ?, NOW(), NOW(), ?)`,
    [
      meetingId,
      '¿Cuál es la capital de Francia?',
      'París',
      'Madrid',
      'Roma',
      'Berlín',
      correctOption,
      status,
      status === 'finished' ? new Date() : null,
    ]
  );
  return result.insertId;
}

async function insertarRespuesta(questionId, userId, { selectedOption, isCorrect, skipped = false }) {
  await pool.query(
    `INSERT INTO question_answers (question_id, user_id, selected_option, is_correct, skipped, response_time_ms)
     VALUES (?, ?, ?, ?, ?, 1000)`,
    [questionId, userId, selectedOption, isCorrect, skipped]
  );
}

test('GET /questions/history devuelve las preguntas finalizadas con distribución real por opción', async () => {
  const meetingCode = nuevoMeetingCode('docente-ve-distribucion');
  const { meetingId, studentIds } = await crearReunion(meetingCode, 'docente@test.com', [
    ['alumno1@test.com', 'Alumno Uno'],
    ['alumno2@test.com', 'Alumno Dos'],
    ['alumno3@test.com', 'Alumno Tres'],
  ]);

  const questionId = await crearPregunta(meetingId, { status: 'finished', correctOption: 'a' });
  await insertarRespuesta(questionId, studentIds['alumno1@test.com'], { selectedOption: 'a', isCorrect: true });
  await insertarRespuesta(questionId, studentIds['alumno2@test.com'], { selectedOption: 'a', isCorrect: true });
  await insertarRespuesta(questionId, studentIds['alumno3@test.com'], { selectedOption: 'b', isCorrect: false });

  const { status, body } = await consultarHistorialDocente(meetingCode, 'docente@test.com');
  assert.equal(status, 200);
  assert.equal(body.questions.length, 1);

  const [question] = body.questions;
  assert.equal(question.id, questionId);
  assert.equal(question.prompt, '¿Cuál es la capital de Francia?');
  assert.deepEqual(question.options, ['París', 'Madrid', 'Roma', 'Berlín']);
  assert.equal(question.correctOptionIndex, 0);
  assert.equal(question.responseCount, 3);
  assert.deepEqual(
    question.optionDistribution.map((o) => ({ label: o.label, count: o.count, percent: o.percent, correct: o.correct })),
    [
      { label: 'París', count: 2, percent: 67, correct: true },
      { label: 'Madrid', count: 1, percent: 33, correct: false },
      { label: 'Roma', count: 0, percent: 0, correct: false },
      { label: 'Berlín', count: 0, percent: 0, correct: false },
    ]
  );

  await limpiarReunion(meetingCode);
});

test('GET /questions/history NO incluye preguntas todavía activas, y ordena de más reciente a más antigua', async () => {
  const meetingCode = nuevoMeetingCode('docente-orden-y-activa');
  const { meetingId } = await crearReunion(meetingCode, 'docente@test.com', [['alumno@test.com', 'Alumno Uno']]);

  const primeraId = await crearPregunta(meetingId, { status: 'finished' });
  // Un pequeño delay real para que `finished_at` difiera de verdad entre
  // ambas filas (la resolución de `NOW()` es de 1 segundo) — sin esto, el
  // orden ASC/DESC sería indistinguible entre las dos.
  await new Promise((r) => setTimeout(r, 1100));
  const segundaId = await crearPregunta(meetingId, { status: 'finished' });
  await crearPregunta(meetingId, { status: 'active' }); // no debería aparecer

  const { body } = await consultarHistorialDocente(meetingCode, 'docente@test.com');
  assert.deepEqual(
    body.questions.map((q) => q.id),
    [segundaId, primeraId],
    'la más reciente primero, y sin la que sigue activa'
  );

  await limpiarReunion(meetingCode);
});

test('GET /questions/history rechaza a quien no es el docente de esa reunión', async () => {
  const meetingCode = nuevoMeetingCode('docente-no-autorizado');
  await crearReunion(meetingCode, 'docente@test.com', [['alumno@test.com', 'Alumno Uno']]);

  const comoAlumno = await consultarHistorialDocente(meetingCode, 'alumno@test.com');
  assert.equal(comoAlumno.status, 403);

  const comoDesconocido = await consultarHistorialDocente(meetingCode, 'nunca-participo@test.com');
  assert.equal(comoDesconocido.status, 403);

  await limpiarReunion(meetingCode);
});

test('GET /questions/my-answers devuelve el historial del alumno con su opción, la correcta, y el status (correct/incorrect/skipped)', async () => {
  const meetingCode = nuevoMeetingCode('alumno-ve-su-historial');
  const { meetingId, studentIds } = await crearReunion(meetingCode, 'docente@test.com', [
    ['alumno@test.com', 'Alumno Uno'],
  ]);

  const preguntaCorrecta = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(preguntaCorrecta, studentIds['alumno@test.com'], { selectedOption: 'a', isCorrect: true });

  const preguntaIncorrecta = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(preguntaIncorrecta, studentIds['alumno@test.com'], { selectedOption: 'b', isCorrect: false });

  const preguntaSalteada = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(preguntaSalteada, studentIds['alumno@test.com'], {
    selectedOption: null,
    isCorrect: null,
    skipped: true,
  });

  const { status, body } = await consultarMisRespuestas(meetingCode, 'alumno@test.com');
  assert.equal(status, 200);
  assert.equal(body.answers.length, 3);

  const porId = Object.fromEntries(body.answers.map((a) => [a.id, a]));

  assert.equal(porId[preguntaCorrecta].status, 'correct');
  assert.equal(porId[preguntaCorrecta].selectedOptionIndex, 0);
  assert.equal(porId[preguntaCorrecta].correctOptionIndex, 0);

  assert.equal(porId[preguntaIncorrecta].status, 'incorrect');
  assert.equal(porId[preguntaIncorrecta].selectedOptionIndex, 1);

  assert.equal(porId[preguntaSalteada].status, 'skipped');
  assert.equal(porId[preguntaSalteada].selectedOptionIndex, null);
  assert.equal(porId[preguntaSalteada].correctOptionIndex, 0, 'la opción correcta se revela igual, la pregunta ya finalizó');

  await limpiarReunion(meetingCode);
});

// Corrección — el historial ahora trae TODAS las preguntas finalizadas de
// la reunión, no solo las que el alumno respondió. Esto reemplaza al viejo
// test "nunca devuelve respuestas de OTRO alumno": antes, un alumno que
// nunca contestó nada simplemente no aparecía con NINGUNA fila; ahora SÍ
// aparece la pregunta, pero marcada 'unanswered' — nunca con los datos de
// otro alumno.
test('GET /questions/my-answers incluye las preguntas que el alumno NUNCA respondió, marcadas "unanswered" — nunca con datos de otro alumno', async () => {
  const meetingCode = nuevoMeetingCode('alumno-no-respondio-nunca');
  const { meetingId, studentIds } = await crearReunion(meetingCode, 'docente@test.com', [
    ['alumno1@test.com', 'Alumno Uno'],
    ['alumno2@test.com', 'Alumno Dos'],
  ]);

  const preguntaId = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(preguntaId, studentIds['alumno1@test.com'], { selectedOption: 'a', isCorrect: true });
  // alumno2 NUNCA respondió ni saltó esta pregunta.

  const { body } = await consultarMisRespuestas(meetingCode, 'alumno2@test.com');
  assert.equal(body.answers.length, 1, 'la pregunta finalizada debería aparecer igual, aunque nunca la haya respondido');

  const [entry] = body.answers;
  assert.equal(entry.id, preguntaId);
  assert.equal(entry.status, 'unanswered');
  assert.equal(entry.selectedOptionIndex, null, 'nunca debería traer la opción que eligió OTRO alumno');
  assert.equal(entry.correctOptionIndex, 0, 'la opción correcta se revela igual — la pregunta ya finalizó');

  await limpiarReunion(meetingCode);
});

test('GET /questions/my-answers: una pregunta que el alumno respondió NO aparece duplicada como "unanswered"', async () => {
  const meetingCode = nuevoMeetingCode('sin-duplicar-unanswered');
  const { meetingId, studentIds } = await crearReunion(meetingCode, 'docente@test.com', [
    ['alumno@test.com', 'Alumno Uno'],
  ]);

  const preguntaId = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(preguntaId, studentIds['alumno@test.com'], { selectedOption: 'a', isCorrect: true });

  const { body } = await consultarMisRespuestas(meetingCode, 'alumno@test.com');
  assert.equal(body.answers.length, 1, 'una sola fila por pregunta — nunca una "unanswered" de más al lado de la real');
  assert.equal(body.answers[0].status, 'correct');

  await limpiarReunion(meetingCode);
});

test('GET /questions/my-answers NO incluye una pregunta que sigue activa, aunque el alumno ya haya respondido', async () => {
  const meetingCode = nuevoMeetingCode('alumno-pregunta-activa');
  const { meetingId, studentIds } = await crearReunion(meetingCode, 'docente@test.com', [
    ['alumno@test.com', 'Alumno Uno'],
  ]);

  const preguntaActivaId = await crearPregunta(meetingId, { status: 'active' });
  await insertarRespuesta(preguntaActivaId, studentIds['alumno@test.com'], { selectedOption: 'a', isCorrect: true });

  const { body } = await consultarMisRespuestas(meetingCode, 'alumno@test.com');
  assert.equal(
    body.answers.length,
    0,
    'no debería revelarse ninguna respuesta (ni la opción correcta) de una pregunta que sigue activa'
  );

  await limpiarReunion(meetingCode);
});
