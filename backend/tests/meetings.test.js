// Tests de integración REALES del router `/api/meetings` (Etapa 68) —
// corren contra un servidor Express real levantado en un puerto efímero de
// este mismo proceso y una base de datos real (mismo criterio que
// `ws.test.js`: hace falta `npm run init-db` corrido antes).
//
// Cubre el Cambio 1 (registro de nombre del alumno, atómico con el rol, con
// unicidad POR REUNIÓN — no global) y el Cambio 3 (endpoint de historial de
// sesiones de conexión). El detalle de CUÁNDO se abre/cierra cada sesión
// vive en `backend/src/ws/index.js` y se prueba en `ws.test.js`; acá solo
// se prueba la FORMA del endpoint `/history` en sí (agrupado por alumno,
// con sus sesiones).
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
  return `test-${etiqueta}-${crypto.randomBytes(4).toString('hex')}`;
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

async function registrarAlumno(meetingCode, email, nombre) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, name: nombre }),
  });
  return { status: resp.status, body: await resp.json() };
}

async function consultarRol(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/role?${params.toString()}`);
  return resp.json();
}

async function consultarHistorial(meetingCode) {
  const params = new URLSearchParams({ meetingCode });
  const resp = await fetch(`${apiUrl}/api/meetings/history?${params.toString()}`);
  return { status: resp.status, body: await resp.json() };
}

// ─── Cambio 1 — registro de nombre + unicidad por reunión ───

test('register-student asigna rol "alumno" + nombre de forma atómica, y GET /role los devuelve juntos', async () => {
  const meetingCode = nuevoMeetingCode('alumno-simple');
  const email = 'alumno-uno@test.com';

  const { status, body } = await registrarAlumno(meetingCode, email, 'Juan Pérez');
  assert.equal(status, 200, `Debería aceptar. Body: ${JSON.stringify(body)}`);
  assert.equal(body.role, 'student');
  assert.equal(body.name, 'Juan Pérez');

  const { role, name } = await consultarRol(meetingCode, email);
  assert.equal(role, 'student');
  assert.equal(name, 'Juan Pérez');

  await limpiarReunion(meetingCode);
});

test('un nombre duplicado en la MISMA reunión se rechaza con 409, y no pisa al primero', async () => {
  const meetingCode = nuevoMeetingCode('duplicado-misma-reunion');

  const primero = await registrarAlumno(meetingCode, 'alumno-a@test.com', 'María López');
  assert.equal(primero.status, 200);

  const segundo = await registrarAlumno(meetingCode, 'alumno-b@test.com', 'María López');
  assert.equal(segundo.status, 409, `Debería rechazar el nombre duplicado. Body: ${JSON.stringify(segundo.body)}`);
  assert.match(segundo.body.error, /ya está en uso/i);

  // El segundo alumno no debería haber quedado con NINGÚN rol asignado.
  const { role: rolSegundo } = await consultarRol(meetingCode, 'alumno-b@test.com');
  assert.equal(rolSegundo, null, 'El alumno rechazado no debería tener rol asignado para esta reunión.');

  // El primero sigue intacto.
  const { role: rolPrimero, name: nombrePrimero } = await consultarRol(meetingCode, 'alumno-a@test.com');
  assert.equal(rolPrimero, 'student');
  assert.equal(nombrePrimero, 'María López');

  await limpiarReunion(meetingCode);
});

test('el mismo nombre SÍ se puede repetir en una reunión DISTINTA (no es único a nivel global)', async () => {
  const meetingCodeA = nuevoMeetingCode('cross-reunion-a');
  const meetingCodeB = nuevoMeetingCode('cross-reunion-b');

  const enA = await registrarAlumno(meetingCodeA, 'alumno-x@test.com', 'Pedro Gómez');
  assert.equal(enA.status, 200);

  const enB = await registrarAlumno(meetingCodeB, 'alumno-y@test.com', 'Pedro Gómez');
  assert.equal(enB.status, 200, `El mismo nombre en otra reunión debería aceptarse. Body: ${JSON.stringify(enB.body)}`);

  await limpiarReunion(meetingCodeA);
  await limpiarReunion(meetingCodeB);
});

test('normalización: "Juan" y "juan " (mayúsculas + espacios de más) cuentan como el mismo nombre', async () => {
  const meetingCode = nuevoMeetingCode('normalizacion');

  const primero = await registrarAlumno(meetingCode, 'alumno-1@test.com', 'Juan');
  assert.equal(primero.status, 200);

  const segundo = await registrarAlumno(meetingCode, 'alumno-2@test.com', '  juan  ');
  assert.equal(
    segundo.status,
    409,
    `"juan" con espacios/mayúsculas distintas debería contar como el mismo nombre que "Juan". Body: ${JSON.stringify(segundo.body)}`
  );

  await limpiarReunion(meetingCode);
});

test('normalización: espacios internos de más se colapsan al guardar el nombre para mostrar', async () => {
  const meetingCode = nuevoMeetingCode('espacios-internos');
  const { status, body } = await registrarAlumno(meetingCode, 'alumno@test.com', '  Juan    Pérez  ');
  assert.equal(status, 200);
  assert.equal(body.name, 'Juan Pérez');
  await limpiarReunion(meetingCode);
});

test('un nombre vacío o solo espacios se rechaza con 400', async () => {
  const meetingCode = nuevoMeetingCode('nombre-vacio');

  const vacio = await registrarAlumno(meetingCode, 'alumno@test.com', '');
  assert.equal(vacio.status, 400);

  const soloEspacios = await registrarAlumno(meetingCode, 'alumno@test.com', '     ');
  assert.equal(soloEspacios.status, 400);

  const { role } = await consultarRol(meetingCode, 'alumno@test.com');
  assert.equal(role, null, 'No debería haber quedado ningún rol asignado.');

  await limpiarReunion(meetingCode);
});

test('reconfirmar el MISMO nombre para el mismo alumno (reintento) no cuenta como conflicto consigo mismo', async () => {
  const meetingCode = nuevoMeetingCode('reconfirmar');
  const email = 'alumno@test.com';

  const primero = await registrarAlumno(meetingCode, email, 'Ana Ruiz');
  assert.equal(primero.status, 200);

  const reintento = await registrarAlumno(meetingCode, email, 'Ana Ruiz');
  assert.equal(reintento.status, 200, `Reconfirmar el mismo nombre no debería fallar. Body: ${JSON.stringify(reintento.body)}`);

  await limpiarReunion(meetingCode);
});

test('una fila "teacher" (nombre NULL) no bloquea a un alumno que confirma un nombre', async () => {
  const meetingCode = nuevoMeetingCode('profesor-no-bloquea');
  const connection = await pool.getConnection();
  try {
    const [usuarioResult] = await connection.query(
      'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      ['docente@test.com']
    );
    const [reunionResult] = await connection.query(
      'INSERT INTO meetings (meeting_code) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [meetingCode]
    );
    await connection.query(
      `INSERT INTO participations (meeting_id, user_id, role) VALUES (?, ?, 'teacher')`,
      [reunionResult.insertId, usuarioResult.insertId]
    );
  } finally {
    connection.release();
  }

  const { status } = await registrarAlumno(meetingCode, 'alumno@test.com', 'Cualquier Nombre');
  assert.equal(status, 200, 'Una fila de profesor (nombre NULL) no debería bloquear el registro de un alumno.');

  await limpiarReunion(meetingCode);
});

// ─── Cambio 3 — forma del endpoint de historial ───

test('GET /history agrupa las sesiones por alumno, con nombre y email', async () => {
  const meetingCode = nuevoMeetingCode('historial-forma');
  await registrarAlumno(meetingCode, 'alumno@test.com', 'Sofía Díaz');

  const connection = await pool.getConnection();
  try {
    const [[usuario]] = await connection.query('SELECT id FROM users WHERE email = ?', ['alumno@test.com']);
    const [[reunion]] = await connection.query('SELECT id FROM meetings WHERE meeting_code = ?', [meetingCode]);
    await connection.query(
      `INSERT INTO connection_sessions (meeting_id, user_id, connected_at, disconnected_at)
       VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 40 MINUTE), DATE_SUB(NOW(), INTERVAL 10 MINUTE))`,
      [reunion.id, usuario.id]
    );
    await connection.query(
      `INSERT INTO connection_sessions (meeting_id, user_id, connected_at, disconnected_at)
       VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 5 MINUTE), NULL)`,
      [reunion.id, usuario.id]
    );
  } finally {
    connection.release();
  }

  const { status, body } = await consultarHistorial(meetingCode);
  assert.equal(status, 200);
  assert.equal(body.students.length, 1);
  const [alumno] = body.students;
  assert.equal(alumno.email, 'alumno@test.com');
  assert.equal(alumno.name, 'Sofía Díaz');
  assert.equal(alumno.sessions.length, 2);
  // Orden: más reciente primero (ver el ORDER BY del endpoint).
  assert.equal(alumno.sessions[0].disconnectedAt, null, 'La sesión más reciente (sigue conectado) debería ir primero.');
  assert.ok(alumno.sessions[1].disconnectedAt, 'La sesión vieja debería tener disconnectedAt.');

  await limpiarReunion(meetingCode);
});

test('GET /history devuelve una lista vacía para una reunión sin ninguna sesión registrada', async () => {
  const meetingCode = nuevoMeetingCode('historial-vacio');
  const { status, body } = await consultarHistorial(meetingCode);
  assert.equal(status, 200);
  assert.deepEqual(body.students, []);
});
