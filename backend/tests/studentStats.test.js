// Tests de integración REALES del endpoint de estadísticas agregadas por
// alumno ("X/Y respuestas correctas", tab "Alumnos" del docente) — mismo
// patrón que `questionsHistory.test.js`: servidor Express real en un
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
  return `test-stats-${etiqueta}-${crypto.randomBytes(4).toString('hex')}`;
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

async function consultarEstadisticas(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/questions/student-stats?${params.toString()}`);
  return { status: resp.status, body: await resp.json() };
}

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

function porEmail(students) {
  return Object.fromEntries(students.map((s) => [s.email, s]));
}

test('Alumno con respuestas correctas e incorrectas: correctAnswers cuenta solo is_correct=1', async () => {
  const meetingCode = nuevoMeetingCode('correctas-e-incorrectas');
  const { meetingId, studentIds } = await crearReunion(meetingCode, 'docente@test.com', [
    ['alumno@test.com', 'Alumno Uno'],
  ]);

  const p1 = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(p1, studentIds['alumno@test.com'], { selectedOption: 'a', isCorrect: true });
  const p2 = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(p2, studentIds['alumno@test.com'], { selectedOption: 'b', isCorrect: false });
  const p3 = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(p3, studentIds['alumno@test.com'], { selectedOption: 'a', isCorrect: true });

  const { status, body } = await consultarEstadisticas(meetingCode, 'docente@test.com');
  assert.equal(status, 200);
  const alumno = porEmail(body.students)['alumno@test.com'];
  assert.equal(alumno.correctAnswers, 2);
  assert.equal(alumno.answeredQuestions, 3);
  assert.equal(alumno.skippedQuestions, 0);
  assert.equal(alumno.totalFinishedQuestions, 3);

  await limpiarReunion(meetingCode);
});

test('Alumno que omitió una pregunta ("Prefiero no responder"): cuenta en skippedQuestions, no en correctAnswers', async () => {
  const meetingCode = nuevoMeetingCode('omite-pregunta');
  const { meetingId, studentIds } = await crearReunion(meetingCode, 'docente@test.com', [
    ['alumno@test.com', 'Alumno Uno'],
  ]);

  const p1 = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(p1, studentIds['alumno@test.com'], { selectedOption: 'a', isCorrect: true });
  const p2 = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(p2, studentIds['alumno@test.com'], { selectedOption: null, isCorrect: null, skipped: true });

  const { body } = await consultarEstadisticas(meetingCode, 'docente@test.com');
  const alumno = porEmail(body.students)['alumno@test.com'];
  assert.equal(alumno.correctAnswers, 1);
  assert.equal(alumno.answeredQuestions, 1);
  assert.equal(alumno.skippedQuestions, 1);
  assert.equal(alumno.totalFinishedQuestions, 2);

  await limpiarReunion(meetingCode);
});

test('Alumno que no respondió NINGUNA pregunta: aparece con 0/Y, no desaparece del listado', async () => {
  const meetingCode = nuevoMeetingCode('no-respondio-nada');
  const { meetingId, studentIds } = await crearReunion(meetingCode, 'docente@test.com', [
    ['alumno1@test.com', 'Alumno Que Responde'],
    ['alumno2@test.com', 'Alumno Ausente'],
  ]);

  const p1 = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(p1, studentIds['alumno1@test.com'], { selectedOption: 'a', isCorrect: true });
  await crearPregunta(meetingId, { correctOption: 'a' }); // segunda pregunta finalizada, nadie de alumno2 respondió ninguna

  const { body } = await consultarEstadisticas(meetingCode, 'docente@test.com');
  const alumnos = porEmail(body.students);

  assert.ok(alumnos['alumno2@test.com'], 'el alumno que nunca respondió tiene que seguir apareciendo en el listado');
  assert.equal(alumnos['alumno2@test.com'].correctAnswers, 0);
  assert.equal(alumnos['alumno2@test.com'].answeredQuestions, 0);
  assert.equal(alumnos['alumno2@test.com'].skippedQuestions, 0);
  assert.equal(alumnos['alumno2@test.com'].totalFinishedQuestions, 2);

  await limpiarReunion(meetingCode);
});

test('Varios alumnos en la misma reunión: cada uno con sus propios contadores, sin mezclarse', async () => {
  const meetingCode = nuevoMeetingCode('varios-alumnos');
  const { meetingId, studentIds } = await crearReunion(meetingCode, 'docente@test.com', [
    ['alumno1@test.com', 'Alumno Uno'],
    ['alumno2@test.com', 'Alumno Dos'],
    ['alumno3@test.com', 'Alumno Tres'],
  ]);

  const p1 = await crearPregunta(meetingId, { correctOption: 'a' });
  await insertarRespuesta(p1, studentIds['alumno1@test.com'], { selectedOption: 'a', isCorrect: true });
  await insertarRespuesta(p1, studentIds['alumno2@test.com'], { selectedOption: 'b', isCorrect: false });
  await insertarRespuesta(p1, studentIds['alumno3@test.com'], { selectedOption: null, isCorrect: null, skipped: true });

  const p2 = await crearPregunta(meetingId, { correctOption: 'b' });
  await insertarRespuesta(p2, studentIds['alumno1@test.com'], { selectedOption: 'b', isCorrect: true });
  await insertarRespuesta(p2, studentIds['alumno2@test.com'], { selectedOption: 'b', isCorrect: true });
  // alumno3 no respondió esta segunda

  const { body } = await consultarEstadisticas(meetingCode, 'docente@test.com');
  const alumnos = porEmail(body.students);

  assert.equal(alumnos['alumno1@test.com'].correctAnswers, 2);
  assert.equal(alumnos['alumno1@test.com'].totalFinishedQuestions, 2);

  assert.equal(alumnos['alumno2@test.com'].correctAnswers, 1);
  assert.equal(alumnos['alumno2@test.com'].answeredQuestions, 2);

  assert.equal(alumnos['alumno3@test.com'].correctAnswers, 0);
  assert.equal(alumnos['alumno3@test.com'].skippedQuestions, 1);
  assert.equal(alumnos['alumno3@test.com'].answeredQuestions, 0);
  assert.equal(alumnos['alumno3@test.com'].totalFinishedQuestions, 2);

  await limpiarReunion(meetingCode);
});

test('Aislamiento entre reuniones: las respuestas de una reunión no contaminan las estadísticas de otra', async () => {
  const meetingCodeA = nuevoMeetingCode('aislamiento-a');
  const meetingCodeB = nuevoMeetingCode('aislamiento-b');
  const email = 'alumno-en-dos-clases@test.com';

  const claseA = await crearReunion(meetingCodeA, 'docente-a@test.com', [[email, 'Alumno Compartido']]);
  const claseB = await crearReunion(meetingCodeB, 'docente-b@test.com', [[email, 'Alumno Compartido']]);

  const preguntaA = await crearPregunta(claseA.meetingId, { correctOption: 'a' });
  await insertarRespuesta(preguntaA, claseA.studentIds[email], { selectedOption: 'a', isCorrect: true });

  const preguntaB1 = await crearPregunta(claseB.meetingId, { correctOption: 'a' });
  await insertarRespuesta(preguntaB1, claseB.studentIds[email], { selectedOption: 'b', isCorrect: false });
  const preguntaB2 = await crearPregunta(claseB.meetingId, { correctOption: 'a' });
  await insertarRespuesta(preguntaB2, claseB.studentIds[email], { selectedOption: 'a', isCorrect: true });

  const { body: bodyA } = await consultarEstadisticas(meetingCodeA, 'docente-a@test.com');
  const { body: bodyB } = await consultarEstadisticas(meetingCodeB, 'docente-b@test.com');

  const statsA = porEmail(bodyA.students)[email];
  const statsB = porEmail(bodyB.students)[email];

  assert.equal(statsA.correctAnswers, 1);
  assert.equal(statsA.totalFinishedQuestions, 1);

  assert.equal(statsB.correctAnswers, 1);
  assert.equal(statsB.answeredQuestions, 2);
  assert.equal(statsB.totalFinishedQuestions, 2);

  await limpiarReunion(meetingCodeA);
  await limpiarReunion(meetingCodeB);
});

test('Acceso no autorizado: un alumno (o un desconocido) no puede consultar las estadísticas del curso', async () => {
  const meetingCode = nuevoMeetingCode('no-autorizado');
  await crearReunion(meetingCode, 'docente@test.com', [['alumno@test.com', 'Alumno Uno']]);

  const comoAlumno = await consultarEstadisticas(meetingCode, 'alumno@test.com');
  assert.equal(comoAlumno.status, 403);

  const comoDesconocido = await consultarEstadisticas(meetingCode, 'nunca-participo@test.com');
  assert.equal(comoDesconocido.status, 403);

  await limpiarReunion(meetingCode);
});
