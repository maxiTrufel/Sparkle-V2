// Tests de integración del flujo de preguntas en tiempo real (estilo
// Kahoot) — mismo patrón que `ws.test.js`: servidor WS real en un puerto
// efímero, base de datos real (requiere `npm run init-db` corrido antes).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const pool = require('../src/db');
const { startWebSocketServer } = require('../src/ws');

let server;
let wss;
let wsUrl;

test.before(async () => {
  server = http.createServer();
  wss = startWebSocketServer(server, []);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  wsUrl = `ws://localhost:${port}/ws`;
});

test.after(async () => {
  // Etapa 84 — `wss.close()` no corta las conexiones abiertas: si una prueba falla
  // antes de cerrar sus clientes, `server.close()` las espera para siempre.
  for (const cliente of wss.clients) cliente.terminate();
  await new Promise((resolve) => wss.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function nuevoMeetingCode(etiqueta) {
  return `test-preguntas-${etiqueta}-${crypto.randomBytes(4).toString('hex')}`;
}

function abrirCliente() {
  const ws = new WebSocket(wsUrl);
  const mensajes = [];
  ws.on('message', (data) => mensajes.push(JSON.parse(data.toString())));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, mensajes }));
    ws.once('error', reject);
  });
}

function enviar(ws, mensaje) {
  ws.send(JSON.stringify(mensaje));
}

async function esperarTipo(mensajes, tipo, timeoutMs = 2000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const encontrado = mensajes.find((m) => m.type === tipo);
    if (encontrado) return encontrado;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No llegó un mensaje de tipo "${tipo}" dentro de ${timeoutMs}ms. Recibidos: ${JSON.stringify(mensajes)}`);
}

// Espera hasta que `mensajes` tenga al menos `cantidad` mensajes de `tipo`
// — a diferencia de `esperarTipo` (que se conforma con el PRIMERO), esto
// hace falta cuando el mismo tipo de mensaje llega varias veces seguidas
// (ej. un "question_stats_updated" por cada respuesta) y lo que interesa es
// el ÚLTIMO, no el primero que llegue.
async function esperarCantidadDeTipo(mensajes, tipo, cantidad, timeoutMs = 2000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const encontrados = mensajes.filter((m) => m.type === tipo);
    if (encontrados.length >= cantidad) return encontrados;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `No llegaron ${cantidad} mensajes de tipo "${tipo}" dentro de ${timeoutMs}ms. Recibidos: ${JSON.stringify(mensajes)}`
  );
}

function cerrarYEsperar(ws) {
  return new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

// Requisito de producto — "start_class" ahora exige un documento cargado Y
// analizado OK para la reunión (ver `backend/src/ws/handlers.js#
// handleStartClass`). El único test de este archivo que manda "start_class"
// por WS crudo (no el atajo `active = TRUE` directo por SQL que usa
// `crearClaseConAlumno`) necesita esto — mismo helper que
// `ws.test.js#crearDocumentoListo`, sembrado directo por SQL para no
// depender de un provider de IA real/mockeado solo para poder probar el
// rechazo de preguntas con la clase detenida.
async function crearDocumentoListo(meetingCode, teacherEmail = 'docente@test.com') {
  const [usuario] = await pool.query(
    'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [teacherEmail]
  );
  const [reunion] = await pool.query(
    'INSERT INTO meetings (meeting_code) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [meetingCode]
  );
  await pool.query(
    `INSERT INTO files (meeting_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, analysis_status)
     VALUES (?, ?, 'material-de-prueba.pdf', 'material-de-prueba.pdf', 'application/pdf', 1024, 'processed')
     ON DUPLICATE KEY UPDATE analysis_status = 'processed'`,
    [reunion.insertId, usuario.insertId]
  );
}

// Deja la reunión lista con un docente y un alumno registrados (rol +
// nombre) tal cual lo hace `/register-role` y `/register-student` en
// producción — se replica a mano por SQL directo, igual que `ws.test.js`.
//
// Corrección — la clase queda ACTIVA de una (`active = TRUE`): desde que
// `questionService.createAndStartQuestion` exige la clase en curso para
// aceptar una pregunta, es la precondición correcta para la enorme mayoría
// de los tests de este archivo (que prueban el flujo de preguntas en sí, no
// el estado de la clase) — los dos tests que SÍ prueban específicamente el
// rechazo con la clase detenida/nunca iniciada arman ese estado ellos
// mismos, más abajo.
async function crearClaseConAlumno(meetingCode, teacherEmail, studentEmail, studentName) {
  const connection = await pool.getConnection();
  try {
    const [teacherUser] = await connection.query(
      'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [teacherEmail]
    );
    const [studentUser] = await connection.query(
      'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [studentEmail]
    );
    const [meeting] = await connection.query(
      'INSERT INTO meetings (meeting_code, active) VALUES (?, TRUE) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), active = TRUE',
      [meetingCode]
    );
    await connection.query(
      `INSERT INTO participations (meeting_id, user_id, role) VALUES (?, ?, 'teacher')`,
      [meeting.insertId, teacherUser.insertId]
    );
    await connection.query(
      `INSERT INTO participations (meeting_id, user_id, role, name, normalized_name)
       VALUES (?, ?, 'student', ?, ?)`,
      [meeting.insertId, studentUser.insertId, studentName, studentName.toLowerCase()]
    );
  } finally {
    connection.release();
  }
}

function preguntaValida(overrides = {}) {
  return {
    prompt: '¿Cuál es la capital de Francia?',
    options: ['París', 'Madrid', 'Roma', 'Berlín'],
    correctOptionIndex: 0,
    // Corrección — 15s es el preset MÁS CORTO permitido (ver
    // `ALLOWED_DURATION_SECONDS` en `questionService.js`); antes era 10s,
    // que dejó de ser válido al cambiar los presets a [15, 30, 45, 60].
    durationSeconds: 15,
    ...overrides,
  };
}

test('Flujo completo: el docente envía una pregunta y el alumno la recibe sin la opción correcta', async () => {
  const meetingCode = nuevoMeetingCode('flujo-basico');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Uno');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });

  const stats = await esperarTipo(profesor.mensajes, 'question_stats_updated');
  assert.equal(stats.stats.totalStudents, 1);
  assert.equal(stats.stats.answeredCount, 0);
  assert.equal(stats.question.correctOptionIndex, undefined, 'la pregunta nunca debe traer la opción correcta');

  const started = await esperarTipo(alumno.mensajes, 'question_started');
  assert.deepEqual(started.question.options, ['París', 'Madrid', 'Roma', 'Berlín']);
  assert.equal(started.question.correctOptionIndex, undefined, 'el alumno nunca debe recibir la opción correcta');
  assert.ok(started.question.expiresAt > started.question.startedAt);

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('El alumno responde, el backend calcula isCorrect y el docente ve las estadísticas actualizadas', async () => {
  const meetingCode = nuevoMeetingCode('responder-correcto');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Dos');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  const started = await esperarTipo(alumno.mensajes, 'question_started');
  // El servidor le manda "question_started" al alumno ANTES de calcular
  // (con una consulta a la base) las estadísticas iniciales del docente: si
  // se limpia `profesor.mensajes` sin esperarlas, pueden llegar DESPUÉS de
  // la limpieza y confundirse con las de la respuesta (test intermitente).
  await esperarTipo(profesor.mensajes, 'question_stats_updated');
  profesor.mensajes.length = 0;

  // Responde la opción correcta (índice 0, "París").
  enviar(alumno.ws, { type: 'answer_question', meetingCode, questionId: started.question.id, selectedOptionIndex: 0 });

  const accepted = await esperarTipo(alumno.mensajes, 'answer_accepted');
  assert.equal(accepted.isCorrect, true);
  assert.equal(accepted.skipped, false);
  // Corrección (panel del alumno, tarjeta final inmediata) — a diferencia
  // de "question_started"/"question_stats_updated" (nunca la incluyen),
  // "answer_accepted" SÍ trae la opción correcta: es unicast al socket que
  // acaba de mandar SU PROPIA respuesta, ya persistida sin vuelta atrás.
  assert.equal(accepted.correctOptionIndex, 0);

  const statsUpdated = await esperarTipo(profesor.mensajes, 'question_stats_updated');
  assert.equal(statsUpdated.stats.answeredCount, 1);
  assert.equal(statsUpdated.stats.skippedCount, 0);
  assert.equal(statsUpdated.stats.pendingCount, 0);
  assert.equal(statsUpdated.stats.participationPercent, 100);

  // Verificación directa en la base: is_correct se calculó server-side.
  const [rows] = await pool.query(
    `SELECT is_correct, skipped, selected_option FROM question_answers WHERE question_id = ?`,
    [started.question.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(Boolean(rows[0].is_correct), true);
  assert.equal(rows[0].selected_option, 'a');

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('question_stats_updated trae la distribución de respuestas por opción (agregada) y la opción correcta, solo para el docente', async () => {
  const meetingCode = nuevoMeetingCode('distribucion-opciones');
  const connection = await pool.getConnection();
  let meetingId;
  try {
    const [meeting] = await connection.query(
      'INSERT INTO meetings (meeting_code, active) VALUES (?, TRUE) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), active = TRUE',
      [meetingCode]
    );
    meetingId = meeting.insertId;
    const [teacherUser] = await connection.query(
      'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      ['docente@test.com']
    );
    await connection.query(`INSERT INTO participations (meeting_id, user_id, role) VALUES (?, ?, 'teacher')`, [
      meetingId,
      teacherUser.insertId,
    ]);
    for (const [email, name] of [
      ['alumno1@test.com', 'Alumno Uno Dist'],
      ['alumno2@test.com', 'Alumno Dos Dist'],
      ['alumno3@test.com', 'Alumno Tres Dist'],
    ]) {
      const [user] = await connection.query(
        'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
        [email]
      );
      await connection.query(
        `INSERT INTO participations (meeting_id, user_id, role, name, normalized_name) VALUES (?, ?, 'student', ?, ?)`,
        [meetingId, user.insertId, name, name.toLowerCase()]
      );
    }
  } finally {
    connection.release();
  }

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno1 = await abrirCliente();
  enviar(alumno1.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno1@test.com' });
  await esperarTipo(alumno1.mensajes, 'class_status');
  const alumno2 = await abrirCliente();
  enviar(alumno2.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno2@test.com' });
  await esperarTipo(alumno2.mensajes, 'class_status');
  const alumno3 = await abrirCliente();
  enviar(alumno3.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno3@test.com' });
  await esperarTipo(alumno3.mensajes, 'class_status');

  // options: ['París', 'Madrid', 'Roma', 'Berlín'], correcta = índice 0.
  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  const started = await esperarTipo(alumno1.mensajes, 'question_started');
  // Mismo motivo que en "El alumno responde…": esperar las estadísticas iniciales.
  await esperarTipo(profesor.mensajes, 'question_stats_updated');
  profesor.mensajes.length = 0;

  // Dos alumnos eligen la correcta (índice 0), uno elige la incorrecta
  // (índice 1) — la distribución agregada tiene que reflejar 2/1/0/0.
  enviar(alumno1.ws, { type: 'answer_question', meetingCode, questionId: started.question.id, selectedOptionIndex: 0 });
  await esperarTipo(alumno1.mensajes, 'answer_accepted');
  enviar(alumno2.ws, { type: 'answer_question', meetingCode, questionId: started.question.id, selectedOptionIndex: 0 });
  await esperarTipo(alumno2.mensajes, 'answer_accepted');
  enviar(alumno3.ws, { type: 'answer_question', meetingCode, questionId: started.question.id, selectedOptionIndex: 1 });
  await esperarTipo(alumno3.mensajes, 'answer_accepted');

  const allStatsMsgs = await esperarCantidadDeTipo(profesor.mensajes, 'question_stats_updated', 3);
  const last = allStatsMsgs[allStatsMsgs.length - 1];
  assert.deepEqual(last.stats.optionCounts, [2, 1, 0, 0]);
  assert.equal(last.stats.correctOptionIndex, 0);
  assert.equal(last.stats.answeredCount, 3);

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno1.ws);
  await cerrarYEsperar(alumno2.ws);
  await cerrarYEsperar(alumno3.ws);
  await limpiarReunion(meetingCode);
});

test('No confía en el cliente: aunque el alumno "declare" que acertó, isCorrect se recalcula en el servidor', async () => {
  const meetingCode = nuevoMeetingCode('no-confiar-cliente');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Tres');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  const started = await esperarTipo(alumno.mensajes, 'question_started');

  // Elige la opción INCORRECTA (índice 1, "Madrid") pero el mensaje no
  // tiene ningún campo "isCorrect" que el cliente pueda mandar — el
  // servidor lo calcula solo a partir de `selectedOptionIndex`.
  enviar(alumno.ws, { type: 'answer_question', meetingCode, questionId: started.question.id, selectedOptionIndex: 1, isCorrect: true });
  const accepted = await esperarTipo(alumno.mensajes, 'answer_accepted');
  assert.equal(accepted.isCorrect, false, 'el servidor debe ignorar cualquier isCorrect mandado por el cliente');

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('Respuestas duplicadas: la segunda respuesta del mismo alumno a la misma pregunta se rechaza', async () => {
  const meetingCode = nuevoMeetingCode('respuesta-duplicada');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Cuatro');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  const started = await esperarTipo(alumno.mensajes, 'question_started');

  enviar(alumno.ws, { type: 'answer_question', meetingCode, questionId: started.question.id, selectedOptionIndex: 0 });
  await esperarTipo(alumno.mensajes, 'answer_accepted');

  alumno.mensajes.length = 0;
  enviar(alumno.ws, { type: 'answer_question', meetingCode, questionId: started.question.id, selectedOptionIndex: 1 });
  const rechazo = await esperarTipo(alumno.mensajes, 'answer_rejected');
  assert.match(rechazo.reason, /ya respondiste/i);

  const [rows] = await pool.query('SELECT COUNT(*) AS total FROM question_answers WHERE question_id = ?', [started.question.id]);
  assert.equal(rows[0].total, 1, 'no debería haber una segunda fila de respuesta para la misma persona');

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('"Prefiero no responder": se guarda como omitida y bloquea nuevas respuestas de ese alumno', async () => {
  const meetingCode = nuevoMeetingCode('skip');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Cinco');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  const started = await esperarTipo(alumno.mensajes, 'question_started');
  // Mismo motivo que en "El alumno responde…": esperar las estadísticas iniciales.
  await esperarTipo(profesor.mensajes, 'question_stats_updated');
  profesor.mensajes.length = 0;

  enviar(alumno.ws, { type: 'skip_question', meetingCode, questionId: started.question.id });
  const accepted = await esperarTipo(alumno.mensajes, 'answer_accepted');
  assert.equal(accepted.skipped, true);
  assert.equal(accepted.isCorrect, null);
  // También se revela al saltear — ya no puede "cambiar de opinión" y
  // responder después (el índice único lo impide, ver el rechazo más
  // abajo).
  assert.equal(accepted.correctOptionIndex, 0);

  const statsUpdated = await esperarTipo(profesor.mensajes, 'question_stats_updated');
  assert.equal(statsUpdated.stats.skippedCount, 1);
  assert.equal(statsUpdated.stats.answeredCount, 0);

  alumno.mensajes.length = 0;
  enviar(alumno.ws, { type: 'answer_question', meetingCode, questionId: started.question.id, selectedOptionIndex: 0 });
  const rechazo = await esperarTipo(alumno.mensajes, 'answer_rejected');
  assert.match(rechazo.reason, /ya respondiste/i);

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('No se puede tener dos preguntas activas a la vez en la misma clase (incluye doble click)', async () => {
  const meetingCode = nuevoMeetingCode('dos-activas');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Seis');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida({ durationSeconds: 30 }) });
  await esperarTipo(profesor.mensajes, 'question_stats_updated');

  profesor.mensajes.length = 0;
  // "Doble click" — se manda una segunda "send_question" para la misma
  // clase mientras la primera sigue activa.
  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida({ prompt: '¿Otra pregunta?' }) });
  const rechazo = await esperarTipo(profesor.mensajes, 'question_send_rejected');
  assert.equal(rechazo.reason, 'active_question_exists');

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM questions q JOIN meetings m ON m.id = q.meeting_id WHERE m.meeting_code = ? AND q.status = 'active'`,
    [meetingCode]
  );
  assert.equal(rows[0].total, 1, 'debe seguir habiendo exactamente UNA pregunta activa');

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

test('Un alumno que no pertenece a la clase no puede responder', async () => {
  const meetingCode = nuevoMeetingCode('alumno-ajeno');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Siete');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  const stats = await esperarTipo(profesor.mensajes, 'question_stats_updated');

  // Este alumno NUNCA se registró (join WS crudo, sin pasar por
  // `/register-student`) — no tiene fila en `participations` para esta
  // reunión.
  const intruso = await abrirCliente();
  enviar(intruso.ws, { type: 'join', meetingCode, role: 'student', email: 'intruso@test.com' });
  await esperarTipo(intruso.mensajes, 'class_status');

  enviar(intruso.ws, { type: 'answer_question', meetingCode, questionId: stats.question.id, selectedOptionIndex: 0 });
  const rechazo = await esperarTipo(intruso.mensajes, 'answer_rejected');
  assert.match(rechazo.reason, /no sos alumno/i);

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(intruso.ws);
  await limpiarReunion(meetingCode);
});

test('Vencimiento automático: al pasar la duración, el servidor finaliza la pregunta y avisa a todos', async () => {
  const meetingCode = nuevoMeetingCode('vencimiento');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Ocho');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  // Preset MÁS CORTO permitido (15s, ver `ALLOWED_DURATION_SECONDS` en
  // `questionService.js`) — antes 10s, que dejó de ser válido al cambiar
  // los presets, así que este test tarda un poco más de lo estrictamente
  // necesario a cambio de seguir usando una duración real y permitida.
  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida({ durationSeconds: 15 }) });
  const started = await esperarTipo(alumno.mensajes, 'question_started');

  // El timeout de esta espera tiene que ser MAYOR a `durationSeconds` (15s)
  // — antes eran 10s de duración con 12000ms de margen; al subir la
  // duración a 15s sin tocar esto, el timeout vencía ANTES que el propio
  // servidor terminara la pregunta.
  const finishedAlumno = await esperarTipo(alumno.mensajes, 'question_finished', 18000);
  assert.equal(finishedAlumno.questionId, started.question.id);
  assert.ok(
    Number.isInteger(finishedAlumno.correctOptionIndex),
    'tras finalizar SÍ se puede revelar la opción correcta'
  );

  const finishedProfesor = await esperarTipo(profesor.mensajes, 'question_finished', 1000);
  assert.equal(finishedProfesor.questionId, started.question.id);

  // Una respuesta que llega DESPUÉS del vencimiento se rechaza, aunque el
  // cliente todavía no se haya enterado del "question_finished".
  alumno.mensajes.length = 0;
  enviar(alumno.ws, { type: 'answer_question', meetingCode, questionId: started.question.id, selectedOptionIndex: 0 });
  const rechazo = await esperarTipo(alumno.mensajes, 'answer_rejected');
  assert.match(rechazo.reason, /vencido|activa/i);

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('El docente puede finalizar la pregunta manualmente antes de que venza', async () => {
  const meetingCode = nuevoMeetingCode('finalizar-manual');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Nueve');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  // Preset MÁS LARGO permitido (60s, ver `ALLOWED_DURATION_SECONDS` en
  // `questionService.js`) — antes 120s (fuera del rango de presets), solo
  // hace falta que no vaya a vencer sola antes de que el test la finalice
  // a mano un instante después.
  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida({ durationSeconds: 60 }) });
  const started = await esperarTipo(alumno.mensajes, 'question_started');

  enviar(profesor.ws, { type: 'finish_question', meetingCode, questionId: started.question.id });
  const finishedAlumno = await esperarTipo(alumno.mensajes, 'question_finished');
  assert.equal(finishedAlumno.questionId, started.question.id);

  // Ahora sí puede enviarse una pregunta NUEVA (la anterior ya no bloquea
  // el índice único de "una activa por clase"). Se limpia `profesor.mensajes`
  // antes: ya tiene el "question_stats_updated" de la PRIMERA pregunta desde
  // más arriba, que si no, `esperarTipo` encontraría de inmediato en vez de
  // esperar el de la segunda.
  profesor.mensajes.length = 0;
  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida({ prompt: '¿Segunda pregunta?' }) });
  const statsSegunda = await esperarTipo(profesor.mensajes, 'question_stats_updated');
  assert.notEqual(statsSegunda.question.id, started.question.id);

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('Alumno que se une tarde (o se reconecta) recibe la pregunta activa y su propio estado de respuesta por "question_state"', async () => {
  const meetingCode = nuevoMeetingCode('llega-tarde');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Diez');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida({ durationSeconds: 60 }) });
  const statsInicial = await esperarTipo(profesor.mensajes, 'question_stats_updated');

  // El alumno recién se une AHORA, con la pregunta ya en curso — nunca
  // recibe "question_started" (eso ya se emitió antes de que se conectara),
  // pero su "join" le tiene que traer la pregunta igual.
  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  const estado = await esperarTipo(alumno.mensajes, 'question_state');
  assert.equal(estado.active, true);
  assert.equal(estado.question.id, statsInicial.question.id);
  assert.equal(estado.myAnswer, null, 'todavía no respondió nada');
  assert.equal(estado.question.correctOptionIndex, undefined);

  // Responde, se desconecta, y se RECONECTA — el catch-up ahora debe traer
  // su propio estado de respuesta, sin reiniciar el contador ni permitir
  // responder de nuevo.
  enviar(alumno.ws, { type: 'answer_question', meetingCode, questionId: estado.question.id, selectedOptionIndex: 2 });
  await esperarTipo(alumno.mensajes, 'answer_accepted');
  await cerrarYEsperar(alumno.ws);

  const reconexion = await abrirCliente();
  enviar(reconexion.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  const estadoReconexion = await esperarTipo(reconexion.mensajes, 'question_state');
  assert.equal(estadoReconexion.active, true);
  assert.equal(estadoReconexion.myAnswer.answered, true);
  assert.equal(estadoReconexion.myAnswer.skipped, false);
  assert.equal(estadoReconexion.myAnswer.isCorrect, false); // opción 2 = "Roma", incorrecta
  // Corrección — se revela en la reconexión igual que en "answer_accepted"
  // (ya respondió, sin vuelta atrás), pero la PREGUNTA en sí (no `myAnswer`)
  // sigue sin traerla nunca.
  assert.equal(estadoReconexion.myAnswer.correctOptionIndex, 0);
  assert.equal(estadoReconexion.question.correctOptionIndex, undefined);

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(reconexion.ws);
  await limpiarReunion(meetingCode);
});

test('Docente que se reconecta mientras la pregunta sigue activa recupera la pregunta y las estadísticas', async () => {
  const meetingCode = nuevoMeetingCode('docente-reconecta');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Once');

  const profesor1 = await abrirCliente();
  enviar(profesor1.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor1.mensajes, 'class_status');

  enviar(profesor1.ws, { type: 'send_question', meetingCode, ...preguntaValida({ durationSeconds: 60 }) });
  const stats = await esperarTipo(profesor1.mensajes, 'question_stats_updated');

  await cerrarYEsperar(profesor1.ws);

  const profesor2 = await abrirCliente();
  enviar(profesor2.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  const estado = await esperarTipo(profesor2.mensajes, 'question_state');
  assert.equal(estado.active, true);
  assert.equal(estado.question.id, stats.question.id);
  assert.ok(estado.stats);
  assert.equal(estado.stats.totalStudents, 1);

  await cerrarYEsperar(profesor2.ws);
  await limpiarReunion(meetingCode);
});

test('Validación server-side: rechaza una pregunta sin 4 opciones no vacías, sin importar lo que mande el cliente', async () => {
  const meetingCode = nuevoMeetingCode('validacion');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Doce');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  enviar(profesor.ws, {
    type: 'send_question',
    meetingCode,
    prompt: '¿Pregunta incompleta?',
    options: ['Solo una opción'],
    correctOptionIndex: 0,
    durationSeconds: 30,
  });
  const rechazo = await esperarTipo(profesor.mensajes, 'question_send_rejected');
  assert.equal(rechazo.reason, 'invalid_question');

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM questions q JOIN meetings m ON m.id = q.meeting_id WHERE m.meeting_code = ?`,
    [meetingCode]
  );
  assert.equal(rows[0].total, 0, 'no debería haberse creado ninguna pregunta');

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

// Corrección — únicas duraciones permitidas: 15/30/45/60 segundos (ver
// `ALLOWED_DURATION_SECONDS` en `questionService.js`, alineado con
// `TIME_PRESETS` del frontend, que ya no ofrece ningún campo de duración a
// medida). Esta es la validación AUTORITATIVA — se prueba mandando el
// mensaje WS directo, sin pasar por ninguna pantalla, para confirmar que no
// hay forma de colarse aunque se manipule el cliente.
test('Validación server-side: rechaza una duración que no sea uno de los presets permitidos (15/30/45/60)', async () => {
  const meetingCode = nuevoMeetingCode('duracion-invalida');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Trece B');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  // 10 y 20 son a propósito — eran presets VÁLIDOS antes del cambio de
  // [10, 20, 30, 45, 60] a [15, 30, 45, 60], así que confirman que de
  // verdad dejaron de aceptarse, no solo que nunca lo estuvieron.
  for (const duracionInvalida of [10, 20, 5, 3, 120, 0, -10]) {
    profesor.mensajes.length = 0;
    enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida({ durationSeconds: duracionInvalida }) });
    const rechazo = await esperarTipo(profesor.mensajes, 'question_send_rejected');
    assert.equal(rechazo.reason, 'invalid_question', `duración ${duracionInvalida} debería rechazarse`);
  }

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM questions q JOIN meetings m ON m.id = q.meeting_id WHERE m.meeting_code = ?`,
    [meetingCode]
  );
  assert.equal(rows[0].total, 0, 'ninguna de las duraciones inválidas debería haber creado una pregunta');

  // Y los cuatro presets sí se aceptan, uno detrás del otro (finalizando
  // cada una a mano para poder mandar la siguiente).
  for (const duracionValida of [15, 30, 45, 60]) {
    profesor.mensajes.length = 0;
    enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida({ durationSeconds: duracionValida }) });
    const stats = await esperarTipo(profesor.mensajes, 'question_stats_updated');
    assert.equal(stats.question.durationSeconds, duracionValida);

    enviar(profesor.ws, { type: 'finish_question', meetingCode, questionId: stats.question.id });
    await esperarTipo(profesor.mensajes, 'question_finished');
  }

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

test('Solo el docente autorizado de la clase puede enviar preguntas — un alumno no puede', async () => {
  const meetingCode = nuevoMeetingCode('solo-docente');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Trece');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  alumno.mensajes.length = 0;
  enviar(alumno.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(
    alumno.mensajes.some((m) => m.type === 'question_stats_updated' || m.type === 'question_started'),
    false,
    'un socket con rol "student" nunca debería poder crear una pregunta'
  );

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM questions q JOIN meetings m ON m.id = q.meeting_id WHERE m.meeting_code = ?`,
    [meetingCode]
  );
  assert.equal(rows[0].total, 0);

  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

// Corrección — el docente solo puede generar/enviar preguntas con la clase
// EN CURSO: ni nunca iniciada ni detenida habilitan el envío (no existe
// ningún mecanismo de "pregunta pendiente" que se dispare sola al reanudar
// — se rechaza de una, sin persistir nada). Este test cubre los dos casos
// distintos de "no en curso": nunca se inició, y se inició y se detuvo.
test('Se rechaza el envío de una pregunta con la clase NUNCA iniciada (active=FALSE por defecto)', async () => {
  const meetingCode = nuevoMeetingCode('clase-nunca-iniciada');
  const connection = await pool.getConnection();
  try {
    const [teacherUser] = await connection.query(
      'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      ['docente@test.com']
    );
    const [meeting] = await connection.query(
      'INSERT INTO meetings (meeting_code) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [meetingCode]
    );
    await connection.query(`INSERT INTO participations (meeting_id, user_id, role) VALUES (?, ?, 'teacher')`, [
      meeting.insertId,
      teacherUser.insertId,
    ]);
  } finally {
    connection.release();
  }

  const [estadoInicial] = await pool.query('SELECT active FROM meetings WHERE meeting_code = ?', [meetingCode]);
  assert.equal(Boolean(estadoInicial[0].active), false, 'precondición: la clase nunca se inició');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  const rechazo = await esperarTipo(profesor.mensajes, 'question_send_rejected');
  assert.equal(rechazo.reason, 'class_not_active');

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM questions q JOIN meetings m ON m.id = q.meeting_id WHERE m.meeting_code = ?`,
    [meetingCode]
  );
  assert.equal(rows[0].total, 0, 'no debería haberse creado ninguna pregunta');

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

test('Se rechaza el envío de una pregunta con la clase DETENIDA (se inició y después se finalizó)', async () => {
  const meetingCode = nuevoMeetingCode('clase-detenida');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Quince');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');
  enviar(profesor.ws, { type: 'end_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_ended');

  const [estado] = await pool.query('SELECT active FROM meetings WHERE meeting_code = ?', [meetingCode]);
  assert.equal(Boolean(estado[0].active), false, 'precondición: la clase quedó detenida');

  profesor.mensajes.length = 0;
  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  const rechazo = await esperarTipo(profesor.mensajes, 'question_send_rejected');
  assert.equal(rechazo.reason, 'class_not_active');

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total FROM questions q JOIN meetings m ON m.id = q.meeting_id WHERE m.meeting_code = ?`,
    [meetingCode]
  );
  assert.equal(rows[0].total, 0, 'no debería haberse creado ninguna pregunta');

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

// Corrección — el docente no puede detener la clase mientras haya una
// pregunta activa: el backend rechaza el "end_class" sin tocar ni la
// pregunta ni la clase (ver `ws/handlers.js`, `handleEndClass`).
test('Se rechaza "end_class" mientras hay una pregunta activa, sin alterarla', async () => {
  const meetingCode = nuevoMeetingCode('no-detener-con-pregunta-activa');
  await crearClaseConAlumno(meetingCode, 'docente@test.com', 'alumno@test.com', 'Alumno Dieciséis');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida({ durationSeconds: 30 }) });
  const stats = await esperarTipo(profesor.mensajes, 'question_stats_updated');

  profesor.mensajes.length = 0;
  enviar(profesor.ws, { type: 'end_class', meetingCode });

  // No debería llegar ningún "class_ended" — se espera un margen razonable
  // y se confirma que la clase y la pregunta siguen intactas.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(profesor.mensajes.some((m) => m.type === 'class_ended'), false, 'la clase no debería haberse detenido');

  const [estado] = await pool.query('SELECT active FROM meetings WHERE meeting_code = ?', [meetingCode]);
  assert.equal(Boolean(estado[0].active), true, 'la clase debe seguir activa');

  const [pregunta] = await pool.query('SELECT status FROM questions WHERE id = ?', [stats.question.id]);
  assert.equal(pregunta[0].status, 'active', 'la pregunta activa no debe verse afectada');

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

// Corrección (panel del alumno, tarjeta final inmediata) — `answer_accepted`
// ahora SÍ revela `correctOptionIndex`, pero solo al propio alumno que
// acaba de responder. Este test confirma que eso NUNCA se filtra a nadie
// más: ni a otro alumno (vía su propio "question_started"), ni al docente
// (vía "question_stats_updated"), ni al alumno que respondió a través de
// esos mismos mensajes — únicamente por su propio "answer_accepted".
test('correctOptionIndex en "answer_accepted" nunca se filtra a otro alumno ni al docente', async () => {
  const meetingCode = nuevoMeetingCode('sin-fuga-correctOptionIndex');
  const connection = await pool.getConnection();
  let meetingId;
  try {
    const [meeting] = await connection.query(
      'INSERT INTO meetings (meeting_code, active) VALUES (?, TRUE) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), active = TRUE',
      [meetingCode]
    );
    meetingId = meeting.insertId;
    const [teacherUser] = await connection.query(
      'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      ['docente@test.com']
    );
    await connection.query(`INSERT INTO participations (meeting_id, user_id, role) VALUES (?, ?, 'teacher')`, [
      meetingId,
      teacherUser.insertId,
    ]);
    for (const [email, name] of [
      ['alumno1@test.com', 'Alumno Responde'],
      ['alumno2@test.com', 'Alumno Espera'],
    ]) {
      const [user] = await connection.query(
        'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
        [email]
      );
      await connection.query(
        `INSERT INTO participations (meeting_id, user_id, role, name, normalized_name) VALUES (?, ?, 'student', ?, ?)`,
        [meetingId, user.insertId, name, name.toLowerCase()]
      );
    }
  } finally {
    connection.release();
  }

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno1 = await abrirCliente();
  enviar(alumno1.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno1@test.com' });
  await esperarTipo(alumno1.mensajes, 'class_status');
  const alumno2 = await abrirCliente();
  enviar(alumno2.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno2@test.com' });
  await esperarTipo(alumno2.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'send_question', meetingCode, ...preguntaValida() });
  const started1 = await esperarTipo(alumno1.mensajes, 'question_started');
  const started2 = await esperarTipo(alumno2.mensajes, 'question_started');
  assert.equal(started1.question.correctOptionIndex, undefined);
  assert.equal(started2.question.correctOptionIndex, undefined);

  // Mismo motivo que en "El alumno responde…": esperar las estadísticas iniciales.
  await esperarTipo(profesor.mensajes, 'question_stats_updated');
  alumno2.mensajes.length = 0;
  profesor.mensajes.length = 0;

  enviar(alumno1.ws, { type: 'answer_question', meetingCode, questionId: started1.question.id, selectedOptionIndex: 0 });
  const accepted = await esperarTipo(alumno1.mensajes, 'answer_accepted');
  assert.equal(accepted.correctOptionIndex, 0, 'a alumno1, que SÍ respondió, se le revela');

  const statsUpdated = await esperarTipo(profesor.mensajes, 'question_stats_updated');
  assert.equal(statsUpdated.question.correctOptionIndex, undefined, 'nunca al docente, ni siquiera después de una respuesta');

  // alumno2 nunca respondió — no debería haber recibido ningún mensaje
  // nuevo con la opción correcta (de hecho, no debería haber recibido
  // ningún mensaje nuevo en absoluto a partir de la respuesta de alumno1).
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    alumno2.mensajes.some((m) => m.correctOptionIndex !== undefined),
    false,
    'alumno2 nunca debería recibir correctOptionIndex — no respondió esta pregunta'
  );

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno1.ws);
  await cerrarYEsperar(alumno2.ws);
  await limpiarReunion(meetingCode);
});
