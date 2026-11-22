// Tests del historial de atención GRUPAL (docente, `ConcentrationStats.jsx`)
// y de la preferencia de cámara — contra la base real, mismo patrón que
// `meetings.test.js`:
//   1. `ws/attentionState.js`: el roster en memoria y la "foto" grupal que
//      se persiste cada 10 s en `attention_snapshots` (solo porcentajes del
//      grupo, nunca datos por alumno).
//   2. `GET /:meetingCode/attention-snapshots` (solo el docente).
//   3. `POST/GET /camera`.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');
const attentionState = require('../src/ws/attentionState');
const meetingRepository = require('../src/repositories/meetingRepository');
const attentionSnapshotRepository = require('../src/repositories/attentionSnapshotRepository');

let server;
let apiUrl;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function nuevoMeetingCode(etiqueta) {
  return `test-atencion-${etiqueta}-${crypto.randomBytes(4).toString('hex')}`;
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

async function registrarRol(meetingCode, email, role) {
  await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role }),
  });
}

async function getJson(path) {
  const resp = await fetch(`${apiUrl}${path}`);
  return { status: resp.status, body: await resp.json() };
}

async function postJson(path, body) {
  const resp = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json() };
}

async function esperarFilas(meetingCode, cantidad, timeoutMs = 4000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const filas = await attentionSnapshotRepository.getSnapshotsForMeeting(meetingCode);
    if (filas.length >= cantidad) return filas;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`No se persistieron ${cantidad} snapshot(s) de atención dentro de ${timeoutMs}ms.`);
}

// La foto se toma en múltiplos de 10 s contados desde el inicio de la
// ventana de atención. Se ancla el inicio entre 9 y 10 s atrás (la columna
// guarda segundos enteros) para que el próximo corte llegue en menos de 1 s
// y el test no tenga que esperar un ciclo entero.
async function anclarVentanaCercaDelCorte(meetingCode) {
  const anclaSegundos = Math.floor((Date.now() - 9000) / 1000) * 1000;
  await meetingRepository.setAttentionWindowStart(meetingCode, new Date(anclaSegundos));
}

test('attentionState: el roster en memoria se arma, se actualiza y se vacía por alumno', () => {
  const meetingCode = nuevoMeetingCode('roster');
  assert.deepEqual(attentionState.getSnapshot(meetingCode), []);

  attentionState.updateState(meetingCode, 'anon-1', { type: 'prediction', concentration: 0.8, inattentive: false, name: 'Ana' });
  attentionState.updateState(meetingCode, 'anon-2', { type: 'no_face', concentration: null, inattentive: true, name: 'Beto' });
  attentionState.updateState(meetingCode, 'anon-1', { type: 'prediction', concentration: 0.3, inattentive: true, name: 'Ana' });

  const roster = attentionState.getSnapshot(meetingCode);
  assert.equal(roster.length, 2);
  assert.equal(roster.find((s) => s.anonId === 'anon-1').concentration, 0.3);

  attentionState.removeState(meetingCode, 'anon-1');
  assert.equal(attentionState.getSnapshot(meetingCode).length, 1);
  attentionState.removeState(meetingCode, 'anon-2');
  attentionState.removeState(meetingCode, 'anon-2'); // quitar dos veces no rompe nada
  attentionState.removeState('reunion-que-no-existe', 'anon-9');
  assert.deepEqual(attentionState.getSnapshot(meetingCode), []);
});

test('attentionState: con la clase activa persiste el promedio GRUPAL de la ventana (sin datos por alumno)', async () => {
  const meetingCode = nuevoMeetingCode('persistir');
  await meetingRepository.activateClass(meetingCode);
  await anclarVentanaCercaDelCorte(meetingCode);

  try {
    // Dos alumnos: uno atento con cara, otro sin cara (cuenta como desatento).
    attentionState.updateState(meetingCode, 'anon-a', { type: 'prediction', concentration: 0.9, inattentive: false });
    attentionState.updateState(meetingCode, 'anon-b', { type: 'no_face', concentration: null, inattentive: true });

    const [fila] = await esperarFilas(meetingCode, 1);
    assert.equal(fila.total_students, 2);
    // Muestras de la ventana: {100 % atento, 0 % sin cara} con un alumno y
    // {50 %, 50 %} con dos → promedio 75 % y 25 %.
    assert.equal(Number(fila.pct_attentive), 75);
    assert.equal(Number(fila.pct_no_face), 25);
    // Con el modo por defecto el umbral P es menor a 75 %: el grupo NO
    // queda marcado como desatento.
    assert.equal(Boolean(fila.group_inattentive), false);
    assert.deepEqual(Object.keys(fila).sort(), ['group_inattentive', 'pct_attentive', 'pct_no_face', 'timestamp', 'total_students']);
  } finally {
    attentionState.removeState(meetingCode, 'anon-a');
    attentionState.removeState(meetingCode, 'anon-b');
    await limpiarReunion(meetingCode);
  }
});

test('attentionState: si la clase se detiene antes del corte, no se persiste nada', async () => {
  const meetingCode = nuevoMeetingCode('detenida');
  await meetingRepository.activateClass(meetingCode);
  await anclarVentanaCercaDelCorte(meetingCode);

  try {
    attentionState.updateState(meetingCode, 'anon-a', { type: 'prediction', concentration: 0.2, inattentive: true });
    // Se detiene la clase enseguida: cuando llegue el corte, la foto se descarta.
    await meetingRepository.markClassEnded(meetingCode, 'manual');
    await new Promise((r) => setTimeout(r, 1500));
    const filas = await attentionSnapshotRepository.getSnapshotsForMeeting(meetingCode);
    assert.equal(filas.length, 0);
  } finally {
    attentionState.removeState(meetingCode, 'anon-a');
    await limpiarReunion(meetingCode);
  }
});

test('attentionState: sin clase activa ni siquiera arranca el intervalo de fotos', async () => {
  const meetingCode = nuevoMeetingCode('inactiva');
  await registrarRol(meetingCode, 'docente@test.com', 'teacher');
  try {
    attentionState.updateState(meetingCode, 'anon-a', { type: 'prediction', concentration: 0.5, inattentive: false });
    await new Promise((r) => setTimeout(r, 300));
    attentionState.stopSnapshots(meetingCode); // no-op: nunca arrancó
    assert.equal((await attentionSnapshotRepository.getSnapshotsForMeeting(meetingCode)).length, 0);
  } finally {
    attentionState.removeState(meetingCode, 'anon-a');
    await limpiarReunion(meetingCode);
  }
});

test('GET /attention-snapshots: solo el docente, con las filas en orden y el inicio de la ventana', async () => {
  const meetingCode = nuevoMeetingCode('endpoint');
  await registrarRol(meetingCode, 'docente@test.com', 'teacher');
  await registrarRol(meetingCode, 'alumno@test.com', 'student');
  const inicio = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  await meetingRepository.setAttentionWindowStart(meetingCode, inicio);
  await attentionSnapshotRepository.insertSnapshot(meetingCode, {
    pctAttentive: 40, pctNoFace: 10, totalStudents: 5, groupInattentive: true,
  });

  try {
    const sinEmail = await getJson(`/api/meetings/${meetingCode}/attention-snapshots`);
    assert.equal(sinEmail.status, 400);

    const alumno = await getJson(`/api/meetings/${meetingCode}/attention-snapshots?email=alumno@test.com`);
    assert.equal(alumno.status, 403);

    const { status, body } = await getJson(`/api/meetings/${meetingCode}/attention-snapshots?email=docente@test.com`);
    assert.equal(status, 200);
    assert.equal(body.snapshots.length, 1);
    assert.deepEqual(
      { ...body.snapshots[0], timestamp: undefined },
      { timestamp: undefined, pctAttentive: 40, pctNoFace: 10, totalStudents: 5, groupInattentive: true }
    );
    assert.equal(new Date(body.windowStartedAt).getTime(), inicio.getTime());
  } finally {
    await limpiarReunion(meetingCode);
  }
});

test('POST/GET /camera: guarda la preferencia de un participante registrado y valida el pedido', async () => {
  const meetingCode = nuevoMeetingCode('camara');
  await registrarRol(meetingCode, 'alumno@test.com', 'student');

  try {
    const inicial = await getJson(`/api/meetings/camera?${new URLSearchParams({ meetingCode, email: 'alumno@test.com' })}`);
    assert.deepEqual(inicial.body, { enabled: false });

    const guardar = await postJson('/api/meetings/camera', { meetingCode: ` ${meetingCode.toUpperCase()} `, email: 'ALUMNO@test.com', enabled: true });
    assert.equal(guardar.status, 200);
    assert.deepEqual(guardar.body, { meetingCode, email: 'alumno@test.com', enabled: true });

    const leida = await getJson(`/api/meetings/camera?${new URLSearchParams({ meetingCode, email: 'alumno@test.com' })}`);
    assert.deepEqual(leida.body, { enabled: true });

    const ajeno = await postJson('/api/meetings/camera', { meetingCode, email: 'nadie@test.com', enabled: true });
    assert.equal(ajeno.status, 404);

    const ajenoLectura = await getJson(`/api/meetings/camera?${new URLSearchParams({ meetingCode, email: 'nadie@test.com' })}`);
    assert.deepEqual(ajenoLectura.body, { enabled: false });

    assert.equal((await postJson('/api/meetings/camera', { email: 'a@test.com', enabled: true })).status, 400);
    assert.equal((await postJson('/api/meetings/camera', { meetingCode, enabled: true })).status, 400);
    assert.equal((await postJson('/api/meetings/camera', { meetingCode, email: 'a@test.com', enabled: 'sí' })).status, 400);
    assert.equal((await getJson(`/api/meetings/camera?email=a@test.com`)).status, 400);
    assert.equal((await getJson(`/api/meetings/camera?meetingCode=${meetingCode}`)).status, 400);
  } finally {
    await limpiarReunion(meetingCode);
  }
});
