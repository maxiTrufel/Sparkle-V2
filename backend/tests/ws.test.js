// Tests de integración del servidor WS (Etapa 52) — corren contra un
// servidor real levantado en un puerto efímero de este mismo proceso (no
// contra el backend que uno tenga corriendo aparte) y una base de datos
// real (usa el mismo pool que `src/db.js`; hace falta `npm run init-db`
// corrido antes, igual que para levantar el backend a mano).
//
// Cubre, en un solo lugar, los cuatro problemas reportados después de la
// Etapa 51 ("restricción de un solo profesor" + "simplificación del prompt
// de reanudar"):
//   - Problema 2: un alumno que se conecta le sigue llegando al docente vía
//     "students_updated" (investigado con el diagnóstico manual de
//     la Etapa 52 y confirmado acá con un test — la lógica de backend nunca
//     estuvo rota; ver DOCUMENTACION.md).
//   - Problema 4: cualquier finalización (manual O automática) dentro de la
//     ventana de 5 minutos deja la reunión "reanudable" — antes solo la
//     automática lo hacía.
//   - Regresión a cuidar: la restricción de "un solo profesor por sala"
//     sigue funcionando (rechaza a un profesor distinto, no autobloquea al
//     mismo docente reconectándose).
//
// El timing puntual del Problema 1 (el comando del docente puede llegar
// mientras el socket todavía está CONNECTING) es un bug del lado del
// CLIENTE (`frontend/src/background/wsClient.js`) — se cubre con un test
// aparte ahí (`frontend/tests/wsClient.test.js`), no acá.
// La finalización automática por desconexión del docente tiene un período
// de gracia de 90 s en producción (ver `GRACIA_DESCONEXION_DOCENTE_MS` en
// `src/ws/handlers.js`: cubre el congelado de pestañas de Chrome, que
// cerraba el WebSocket y terminaba la clase sola). Los tests de este
// archivo que la ejercitan no pueden esperar minuto y medio cada uno, así
// que acá se achica a 100 ms.
//
// ⚠️ Tiene que ir ANTES del `require` de `../src/ws`: la constante se lee
// del entorno UNA sola vez, al cargar el módulo.
process.env.TEACHER_DISCONNECT_GRACE_MS = '100';

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
  // `allowedOrigins` no importa acá: un cliente `ws` de Node no manda
  // header Origin, y el servidor deja pasar esos requests igual que en
  // `diag1.js` (ver backend/src/ws/index.js, `verifyClient`).
  wss = startWebSocketServer(server, []);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  wsUrl = `ws://localhost:${port}/ws`;
});

test.after(async () => {
  // `wss.close()` explícito (Etapa 52, aprendido escribiendo este test):
  // cerrar el `http.Server` NO cierra solo el `WebSocketServer` que se le
  // enganchó encima (ver `ws/lib/websocket-server.js`) — sin esto, el
  // heartbeat de 30s (`startHeartbeat` en `backend/src/ws/index.js`)
  // seguía corriendo con un `setInterval` vivo y el proceso de test nunca
  // terminaba solo.
  // Etapa 84 — `wss.close()` no corta las conexiones abiertas: si una prueba falla
  // antes de cerrar sus clientes, `server.close()` las espera para siempre.
  for (const cliente of wss.clients) cliente.terminate();
  await new Promise((resolve) => wss.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function nuevoMeetingCode(etiqueta) {
  return `test-${etiqueta}-${crypto.randomBytes(4).toString('hex')}`;
}

// Cliente de prueba: junta todos los mensajes que le van llegando (en
// orden) para poder assertar sobre ellos, y expone un helper para esperar
// hasta que llegue uno de un tipo puntual (con timeout, para no colgar el
// test si algo no llega).
function abrirCliente() {
  return abrirClienteEn(wsUrl);
}

// Etapa 55 — variante que permite conectar a un servidor DISTINTO del
// compartido de arriba (con su propio `heartbeatMs`/`toleranciaPings` de
// prueba, mucho más rápido que los 30s/3 reales — ver los tests del
// heartbeat más abajo) y, opcionalmente, tomar control manual del
// ping/pong NATIVO del protocolo (`wsOptions.autoPong: false`) para
// simular una conexión que contesta algunos pings y otros no.
function abrirClienteEn(url, wsOptions = {}) {
  const ws = new WebSocket(url, wsOptions);
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

// Como `esperarTipo`, pero para un `students_updated` con una lista puntual.
// Hace falta porque el join del docente ya le manda uno de puesta al día
// (`handlers.js`), y sin mirar el contenido se lo confunde con el que sigue.
async function esperarAlumnos(mensajes, condicion, timeoutMs = 2000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const encontrado = mensajes.find((m) => m.type === 'students_updated' && condicion(m.students));
    if (encontrado) return encontrado;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No llegó el "students_updated" esperado dentro de ${timeoutMs}ms. Recibidos: ${JSON.stringify(mensajes)}`);
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
// handleStartClass`, `backend/src/services/documentAnalysisService.js`).
// Estos tests ejercitan el protocolo WS en sí (listado de alumnos,
// reanudar, heartbeat, sesiones de conexión), no el flujo de carga de
// documentos, así que alcanza con sembrar directo por SQL una fila de
// `files` ya "processed" — evita depender de un provider de IA real (o
// mockeado) solo para poder probar otra cosa. `INSERT ... ON DUPLICATE KEY
// UPDATE id = LAST_INSERT_ID(id)` (mismo truco que `asegurarUsuarioYReunion`
// más abajo) crea la reunión si todavía no existe — a diferencia de
// `activateClass`, este INSERT no toca `active`, así que no interfiere con
// las aserciones de cada test sobre el estado real de la clase.
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

// Variante de `crearDocumentoListo` con un `analysisStatus` a elección —
// para probar que el rechazo de "start_class" depende de verdad del
// ESTADO del documento (no solo de "existe una fila en `files`"), hace
// falta poder sembrar uno que exista pero NO esté en 'processed' todavía
// (ej. 'processing', el estado real mientras el análisis sigue en vuelo).
async function crearDocumentoConEstado(meetingCode, analysisStatus, teacherEmail = 'docente@test.com') {
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
     VALUES (?, ?, 'material-de-prueba.pdf', 'material-de-prueba.pdf', 'application/pdf', 1024, ?)
     ON DUPLICATE KEY UPDATE analysis_status = VALUES(analysis_status)`,
    [reunion.insertId, usuario.insertId, analysisStatus]
  );
}

// Etapa 68, Cambio 3 — lee directo de `connection_sessions` (no hay ningún
// evento WS que confirme "ya se guardó la sesión"), ordenadas de la más
// vieja a la más nueva.
async function obtenerSesiones(meetingCode, email) {
  const [filas] = await pool.query(
    `SELECT s.connected_at AS conectadoEn, s.disconnected_at AS desconectadoEn
     FROM connection_sessions s
     JOIN meetings r ON r.id = s.meeting_id
     JOIN users u ON u.id = s.user_id
     WHERE r.meeting_code = ? AND u.email = ?
     ORDER BY s.connected_at ASC`,
    [meetingCode, email]
  );
  return filas;
}

// El handler de cada evento WS que toca `connection_sessions` es `async` y
// corre DESPUÉS de que el mensaje ya salió por el socket (ver
// `handleStartClass`/`socket.on('close', ...)` en `backend/src/ws/
// index.js`) — así que recibir la confirmación por WS no garantiza que el
// INSERT/UPDATE correspondiente ya se haya completado. Se sondea la base en
// vez de asumir un timing fijo.
async function esperarCondicion(condicion, timeoutMs = 2000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (await condicion()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// Este chequeo (`handleStartClass` en `backend/src/ws/handlers.js`) vivió
// escrito pero DESACTIVADO detrás de un flag desde que se agregó — nunca
// corrió de verdad hasta ahora, así que el resto de los tests de este
// archivo (que sí llaman a `crearDocumentoListo` antes de cada
// "start_class", ver el comentario de esa función más arriba) confirman
// el camino FELIZ, pero nunca habían probado el rechazo en sí.
test('Requisito de producto — "start_class" se RECHAZA si la reunión no tiene ningún documento procesado, y se ACEPTA en cuanto lo tiene', async () => {
  const meetingCode = nuevoMeetingCode('sin-documento');
  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  // Sin ningún documento cargado para esta reunión — el rechazo tiene que
  // llegar como "class_start_rejected" con `reason: 'missing_document'`
  // (nunca un error genérico, ni la conexión cerrada): es el evento que
  // `frontend/src/hooks/useLiveClass.js` escucha para mostrar
  // `startClassError` en el panel.
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  const rechazo = await esperarTipo(profesor.mensajes, 'class_start_rejected');
  assert.equal(rechazo.reason, 'missing_document');
  assert.equal(rechazo.meetingCode, meetingCode);
  assert.equal(
    profesor.mensajes.some((m) => m.type === 'class_started'),
    false,
    'no debería haberse iniciado la clase sin ningún documento cargado'
  );

  // Mismo email, misma reunión — ahora con un documento YA 'processed'
  // (sembrado directo por SQL, mismo criterio que el resto de este
  // archivo). El mismo "start_class", reintentado, tiene que funcionar.
  profesor.mensajes.length = 0;
  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

test('"start_class" también se RECHAZA si existe un documento pero su análisis todavía está en curso (no alcanza con que exista la fila)', async () => {
  const meetingCode = nuevoMeetingCode('documento-en-curso');
  await crearDocumentoConEstado(meetingCode, 'processing');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  enviar(profesor.ws, { type: 'start_class', meetingCode });
  const rechazo = await esperarTipo(profesor.mensajes, 'class_start_rejected');
  assert.equal(rechazo.reason, 'missing_document');

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

test('Problema 2 — el docente recibe students_updated cuando se conecta un alumno', async () => {
  const meetingCode = nuevoMeetingCode('alumnos');
  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  // El propio join del profesor ya le mandó un catch-up de
  // "students_updated" (vacío, todavía no se conectó nadie) — se
  // limpia acá para que el `esperarTipo` de abajo no lo confunda con el
  // broadcast que nos interesa de verdad (el que dispara el join del
  // alumno).
  profesor.mensajes.length = 0;

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  // El evento le tiene que llegar al PROFESOR (no solo al propio alumno
  // como catch-up de su propio join) con el alumno recién conectado en la
  // lista — este es exactamente el flujo que el reporte dice que dejó de
  // funcionar.
  const evento = await esperarTipo(profesor.mensajes, 'students_updated');
  // `name: null` (Etapa 68) — este alumno se unió por WS crudo, sin pasar
  // por `/register-student` (no hay ninguna fila de `participations` con
  // su nombre); en producción eso no pasa nunca (ver `StudentName.jsx`),
  // pero acá refleja el comportamiento real: sin nombre registrado,
  // `getStudentName()` no encuentra nada.
  assert.deepEqual(evento.students, [{ email: 'alumno@test.com', name: null }]);

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('Etapa 66 — el docente que se une DESPUÉS ve de inmediato al alumno que ya estaba conectado desde antes', async () => {
  const meetingCode = nuevoMeetingCode('alumno-primero');

  // Orden exacto del bug reportado: el ALUMNO se conecta primero...
  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  // ...y el DOCENTE recién se une después. El catch-up de SU PROPIO join
  // (no un broadcast futuro que dependa de que otro alumno entre/salga)
  // tiene que traer ya al alumno que estaba esperando.
  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');
  const catchUp = await esperarTipo(profesor.mensajes, 'students_updated');
  assert.deepEqual(
    catchUp.students,
    [{ email: 'alumno@test.com', name: null }],
    'el docente debería ver al alumno ya conectado apenas se une, sin que el alumno tenga que hacer nada'
  );

  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('Etapa 66 — el docente ve a TODOS los alumnos que ya estaban conectados antes de unirse, no solo al último', async () => {
  const meetingCode = nuevoMeetingCode('varios-alumnos-primero');

  const alumno1 = await abrirCliente();
  enviar(alumno1.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno1@test.com' });
  await esperarTipo(alumno1.mensajes, 'class_status');

  const alumno2 = await abrirCliente();
  enviar(alumno2.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno2@test.com' });
  await esperarTipo(alumno2.mensajes, 'class_status');

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');
  const catchUp = await esperarTipo(profesor.mensajes, 'students_updated');
  assert.deepEqual(
    catchUp.students.map((a) => a.email).sort(),
    ['alumno1@test.com', 'alumno2@test.com']
  );

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno1.ws);
  await cerrarYEsperar(alumno2.ws);
  await limpiarReunion(meetingCode);
});

test('Etapa 66 — un docente que se RECONECTA (F5) también recupera el listado actual de alumnos conectados', async () => {
  const meetingCode = nuevoMeetingCode('docente-reconecta-alumnos');

  const profesor1 = await abrirCliente();
  enviar(profesor1.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor1.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(profesor1.mensajes, 'students_updated');

  await cerrarYEsperar(profesor1.ws);
  await new Promise((r) => setTimeout(r, 100)); // le da tiempo al 'close' async del servidor a procesarse

  const profesor2 = await abrirCliente();
  enviar(profesor2.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor2.mensajes, 'class_status');
  const catchUp = await esperarTipo(profesor2.mensajes, 'students_updated');
  assert.deepEqual(
    catchUp.students,
    [{ email: 'alumno@test.com', name: null }],
    'la reconexión del docente debería recuperar el listado de alumnos, igual que un primer join'
  );

  await cerrarYEsperar(profesor2.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('Problema 2 — el docente recibe students_updated cuando el alumno se desconecta', async () => {
  const meetingCode = nuevoMeetingCode('alumnos-baja');
  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  // El que trae al alumno, no el de puesta al día del join del docente (que
  // viene vacío): si se tomaba ese, el del alumno llegaba después de limpiar
  // la lista y se leía como el aviso de la baja (falla del CI de la v0.1.10).
  await esperarAlumnos(profesor.mensajes, (students) => students.length === 1);

  profesor.mensajes.length = 0; // solo interesa lo que llegue DESPUÉS de la baja
  await cerrarYEsperar(alumno.ws);

  const evento = await esperarAlumnos(profesor.mensajes, (students) => students.length === 0);
  assert.deepEqual(evento.students, []);

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

test('Problema 4 — una finalización MANUAL también deja la reunión reanudable', async () => {
  const meetingCode = nuevoMeetingCode('reanudar-manual');
  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  enviar(profesor.ws, { type: 'end_class', meetingCode }); // "Detener Clase" a propósito
  await esperarTipo(profesor.mensajes, 'class_ended');
  await cerrarYEsperar(profesor.ws);

  const reconexion = await abrirCliente();
  enviar(reconexion.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });

  // Antes de la Etapa 52 esto NUNCA llegaba tras una finalización manual —
  // era el comportamiento viejo, a propósito. Desde la Etapa 52 no se
  // distingue: cualquier finalización reciente ofrece reanudar.
  await esperarTipo(reconexion.mensajes, 'class_resumable');

  await cerrarYEsperar(reconexion.ws);
  await limpiarReunion(meetingCode);
});

test('Problema 4 (regresión) — una finalización AUTOMÁTICA sigue dejando la reunión reanudable', async () => {
  const meetingCode = nuevoMeetingCode('reanudar-auto');
  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  await cerrarYEsperar(profesor.ws); // se cuelga/pierde la red -- SIN apretar "Detener Clase"

  // El cierre dispara `handleTeacherDisconnection` de forma asíncrona (es un
  // handler `async` del evento 'close') — se le da un instante antes de
  // reconectar, para no ganarle la carrera a esa finalización automática.
  //
  // Ese instante ahora tiene que superar el PERÍODO DE GRACIA (100 ms en
  // estos tests, ver arriba): desde que existe, volver antes de que venza
  // NO finaliza la clase —justamente para que una pestaña congelada no la
  // termine sola— y entonces no habría nada que "reanudar". Este test es
  // sobre el docente que vuelve TARDE; el que vuelve a tiempo se cubre en
  // `teacherDisconnectGrace.test.js`. Se espera 6 veces la ventana para
  // que no dependa de lo cargado que esté el runner.
  await new Promise((r) => setTimeout(r, 600));

  const reconexion = await abrirCliente();
  enviar(reconexion.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(reconexion.mensajes, 'class_resumable');

  await cerrarYEsperar(reconexion.ws);
  await limpiarReunion(meetingCode);
});

test('Problema 4 — fuera de la ventana de 5 minutos ya NO es reanudable (manual ni automática)', async () => {
  const meetingCode = nuevoMeetingCode('reanudar-vencido');
  await pool.query(
    `INSERT INTO meetings (meeting_code, active, last_ended_type, last_ended_at)
     VALUES (?, FALSE, 'manual', DATE_SUB(NOW(), INTERVAL 10 MINUTE))`,
    [meetingCode]
  );

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(
    profesor.mensajes.some((m) => m.type === 'class_resumable'),
    false,
    'no debería ofrecer reanudar una finalización de hace 10 minutos'
  );

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

test('Regresión — "un solo profesor por sala" sigue rechazando a un profesor DISTINTO', async () => {
  const meetingCode = nuevoMeetingCode('un-profesor');
  const profesor1 = await abrirCliente();
  enviar(profesor1.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente-uno@test.com' });
  await esperarTipo(profesor1.mensajes, 'class_status');

  const profesor2 = await abrirCliente();
  enviar(profesor2.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente-dos@test.com' });
  const rechazo = await esperarTipo(profesor2.mensajes, 'join_rejected');
  assert.equal(rechazo.reason, 'teacher_exists');

  await cerrarYEsperar(profesor1.ws);
  await cerrarYEsperar(profesor2.ws);
  await limpiarReunion(meetingCode);
});

test('Regresión — el mismo docente reconectándose (mismo email) NO se autobloquea', async () => {
  const meetingCode = nuevoMeetingCode('mismo-docente');
  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  // Reconexión "en caliente": la conexión física vieja todavía no terminó
  // de cerrarse del lado del servidor (no se llama `cerrarYEsperar` acá a
  // propósito) cuando ya llega el join de la nueva — el caso de carrera que
  // motivó comparar por email en vez de rechazar sin más.
  const reconexion = await abrirCliente();
  enviar(reconexion.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });

  const estado = await esperarTipo(reconexion.mensajes, 'class_status');
  assert.equal(estado.meetingCode, meetingCode);
  assert.equal(
    reconexion.mensajes.some((m) => m.type === 'join_rejected'),
    false,
    'el propio docente reconectándose no debería recibir join_rejected'
  );

  await cerrarYEsperar(profesor.ws).catch(() => {});
  await cerrarYEsperar(reconexion.ws);
  await limpiarReunion(meetingCode);
});

test('Etapa 54 — el servidor contesta "ping" con "pong", sin necesitar haberse unido a ninguna sala antes', async () => {
  // A propósito NO se manda ningún "join" antes -- el ping/pong de
  // liveness (ver `frontend/src/background/wsClient.js`,
  // `verificarConexionViva`) tiene que funcionar sobre la conexión física
  // en sí, no sobre una sala puntual, para poder usarse incluso si el
  // "join" todavía no se completó o se perdió.
  const cliente = await abrirCliente();
  enviar(cliente.ws, { type: 'ping' });
  const respuesta = await esperarTipo(cliente.mensajes, 'pong');
  assert.equal(respuesta.type, 'pong');
  await cerrarYEsperar(cliente.ws);
});

// Etapa 55 — el heartbeat NATIVO (Etapa 46, `startHeartbeat`) reportado
// como demasiado agresivo: un alumno desaparecía del listado del docente
// pese a seguir genuinamente conectado. Estos dos tests corren contra un
// servidor PROPIO (no el compartido de `test.before`), con
// `heartbeatMs`/`toleranciaPings` de prueba — mucho más rápido que los
// 30000ms/3 reales de producción, pero ejerciendo la máquina de estados
// REAL de `startHeartbeat` (no una reimplementación aparte para el
// test): así el test corre en un segundo en vez de varios minutos, sin
// perder fidelidad sobre qué código se está probando de verdad.
async function crearServidorConHeartbeatDePrueba(heartbeatMs, toleranciaPings) {
  const servidorLocal = http.createServer();
  // Se guarda `wssLocal` (no solo `servidorLocal`) porque hay que cerrarlo
  // explícitamente al terminar — lección aprendida armando
  // `test.before`/`test.after` más arriba: cerrar el `http.Server` NO
  // cierra solo el `WebSocketServer` enganchado encima, así que sin esto
  // el `setInterval` del heartbeat de ESTE servidor de prueba queda vivo
  // para siempre y el proceso nunca termina solo.
  const wssLocal = startWebSocketServer(servidorLocal, [], { heartbeatMs, toleranciaPings });
  await new Promise((resolve) => servidorLocal.listen(0, resolve));
  const { port } = servidorLocal.address();
  return {
    servidorLocal,
    urlLocal: `ws://localhost:${port}/ws`,
    async cerrar() {
      await new Promise((resolve) => wssLocal.close(resolve));
      await new Promise((resolve) => servidorLocal.close(resolve));
    },
  };
}

test('Etapa 55 — latencia intermitente (contesta la mayoría de los pings, pero no todos) NO saca al alumno del listado', async () => {
  const heartbeatMs = 80;
  const toleranciaPings = 3;
  const { urlLocal, cerrar } = await crearServidorConHeartbeatDePrueba(heartbeatMs, toleranciaPings);
  const meetingCode = nuevoMeetingCode('heartbeat-intermitente');

  try {
    const profesor = await abrirClienteEn(urlLocal);
    enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
    await esperarTipo(profesor.mensajes, 'class_status');

    // `autoPong: false` -- toma control manual de si se contesta cada
    // "ping" nativo del protocolo o no (por defecto, `ws` lo contesta solo
    // y de forma transparente, igual que un browser real — acá se lo
    // desactiva a propósito para poder simular fallos puntuales).
    const alumno = await abrirClienteEn(urlLocal, { autoPong: false });
    let pingsRecibidos = 0;
    alumno.ws.on('ping', () => {
      pingsRecibidos += 1;
      // Contesta 2 de cada 3 -- nunca llega a fallar `toleranciaPings`
      // (3) veces SEGUIDAS, que es justamente lo que se quiere probar: un
      // fallo aislado (o incluso dos, mientras no sean tres seguidos) no
      // debería alcanzar para que el servidor lo dé por muerto.
      if (pingsRecibidos % 3 !== 0) alumno.ws.pong();
    });
    enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
    await esperarTipo(alumno.mensajes, 'class_status');

    // Se dejan pasar varios ciclos de heartbeat (bastantes más que los que
    // haría falta para acumular 3 fallos SEGUIDOS si no se contestara
    // nada) mientras la latencia intermitente sigue su curso.
    await new Promise((r) => setTimeout(r, heartbeatMs * 12));

    // Re-"join" del profesor sobre la MISMA conexión: pide un catch-up
    // fresco de `students_updated` sin depender de que haya
    // ocurrido algún evento nuevo mientras tanto.
    profesor.mensajes.length = 0;
    enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
    const catchUp = await esperarTipo(profesor.mensajes, 'students_updated');

    assert.deepEqual(
      catchUp.students,
      [{ email: 'alumno@test.com', name: null }],
      'el alumno con latencia intermitente NO debería haber sido removido del listado'
    );
    assert.ok(pingsRecibidos >= 3, 'la prueba no corrió suficientes ciclos de heartbeat como para ser significativa');

    await cerrarYEsperar(profesor.ws);
    await cerrarYEsperar(alumno.ws);
    await limpiarReunion(meetingCode);
  } finally {
    await cerrar();
  }
});

test('Etapa 55 — una conexión que nunca contesta ningún ping SÍ se remueve, tras superar la tolerancia (el mecanismo sigue funcionando)', async () => {
  const heartbeatMs = 80;
  const toleranciaPings = 3;
  const { urlLocal, cerrar } = await crearServidorConHeartbeatDePrueba(heartbeatMs, toleranciaPings);
  const meetingCode = nuevoMeetingCode('heartbeat-muerto');

  try {
    const profesor = await abrirClienteEn(urlLocal);
    enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
    await esperarTipo(profesor.mensajes, 'class_status');

    // `autoPong: false` Y sin ningún listener de 'ping' que conteste --
    // nunca contesta absolutamente nada, simulando una pérdida de red real
    // (a diferencia del test de arriba, que sí contestaba la mayoría).
    const alumno = await abrirClienteEn(urlLocal, { autoPong: false });
    enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno-fantasma@test.com' });
    await esperarTipo(alumno.mensajes, 'class_status');

    // El propio "join" del alumno YA le mandó al profesor un
    // "students_updated" de catch-up (CON el alumno todavía
    // presente, recién conectado) — se limpia para que el `esperarTipo` de
    // abajo no lo confunda con el broadcast que interesa de verdad: el que
    // recién va a llegar cuando el heartbeat termine la conexión zombie.
    // Mismo error de metodología que ya se había corregido antes en este
    // archivo (ver el primer test de "students_updated" más
    // arriba) — acá se repitió al escribir este test nuevo, detectado
    // porque el test pasaba en ~30ms en vez de esperar los ~3 ciclos de
    // heartbeat que hacen falta para la remoción real.
    profesor.mensajes.length = 0;

    // El servidor tiene que terminar la conexión sola (sin que el cliente
    // la cierre) y avisarle al profesor -- confirmado esperando
    // directamente el broadcast de baja.
    const evento = await esperarTipo(profesor.mensajes, 'students_updated', heartbeatMs * (toleranciaPings + 5));
    assert.deepEqual(evento.students, [], 'la conexión que nunca contesta debería terminar removida del listado');

    await cerrarYEsperar(profesor.ws);
    await limpiarReunion(meetingCode);
  } finally {
    await cerrar();
  }
});

// ─── Etapa 68, Cambio 3 — historial de sesiones de conexión ───
//
// En producción, un alumno solo llega a mandar su "join" por WS después de
// haber pasado por `/register-student` (que crea las filas de `users`/
// `meetings`) — acá se replica esa precondición a mano por SQL directo, sin
// necesitar levantar el router Express completo en este archivo (el flujo
// de registro en sí, con su validación de nombre, se prueba en
// `reuniones.test.js`).
async function asegurarUsuarioYReunion(meetingCode, email) {
  await pool.query('INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [email]);
  await pool.query(
    'INSERT INTO meetings (meeting_code) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [meetingCode]
  );
}

test('Etapa 68 — se abre una sesión de conexión cuando el alumno se une con la clase YA activa, y se cierra al desconectarse', async () => {
  const meetingCode = nuevoMeetingCode('sesion-clase-activa');
  const email = 'alumno@test.com';
  await asegurarUsuarioYReunion(meetingCode, email);

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');
  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email });
  await esperarTipo(alumno.mensajes, 'class_status');

  const seAbrio = await esperarCondicion(async () => (await obtenerSesiones(meetingCode, email)).length === 1);
  assert.ok(seAbrio, 'Debería haberse abierto una sesión de conexión al unirse con la clase activa.');

  const [sesionAbierta] = await obtenerSesiones(meetingCode, email);
  assert.ok(sesionAbierta.conectadoEn, 'La sesión debería tener un timestamp de conexión.');
  assert.equal(sesionAbierta.desconectadoEn, null, 'La sesión recién abierta no debería tener desconexión todavía.');

  await cerrarYEsperar(alumno.ws);

  const seCerro = await esperarCondicion(async () => {
    const [sesion] = await obtenerSesiones(meetingCode, email);
    return sesion && sesion.desconectadoEn !== null;
  });
  assert.ok(seCerro, 'La sesión debería haberse cerrado (desconectadoEn seteado) al desconectarse el alumno.');

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

test('Etapa 68 — un alumno conectado ANTES de que arranque la clase no tiene ninguna sesión hasta que el docente la inicia', async () => {
  const meetingCode = nuevoMeetingCode('sesion-antes-de-clase');
  const email = 'alumno@test.com';
  await asegurarUsuarioYReunion(meetingCode, email);

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email });
  await esperarTipo(alumno.mensajes, 'class_status');

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    (await obtenerSesiones(meetingCode, email)).length,
    0,
    'No debería haber ninguna sesión mientras la clase no está activa, aunque el alumno ya esté conectado a la sala.'
  );

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');
  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  const seAbrio = await esperarCondicion(async () => (await obtenerSesiones(meetingCode, email)).length === 1);
  assert.ok(seAbrio, 'La sesión del alumno que ya esperaba debería abrirse recién cuando el docente inicia la clase.');

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('Etapa 68 — finalizar la clase cierra la sesión de un alumno que sigue conectado (sin que se desconecte)', async () => {
  const meetingCode = nuevoMeetingCode('sesion-finalizar-clase');
  const email = 'alumno@test.com';
  await asegurarUsuarioYReunion(meetingCode, email);

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');
  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email });
  await esperarTipo(alumno.mensajes, 'class_status');
  await esperarCondicion(async () => (await obtenerSesiones(meetingCode, email)).length === 1);

  enviar(profesor.ws, { type: 'end_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_ended');

  const seCerro = await esperarCondicion(async () => {
    const [sesion] = await obtenerSesiones(meetingCode, email);
    return sesion && sesion.desconectadoEn !== null;
  });
  assert.ok(seCerro, 'Detener la clase debería cerrar la sesión del alumno que seguía conectado.');

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('Etapa 68 — reconexiones del alumno durante la misma clase activa generan tramos de sesión separados', async () => {
  const meetingCode = nuevoMeetingCode('sesion-reconexiones');
  const email = 'alumno@test.com';
  await asegurarUsuarioYReunion(meetingCode, email);

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');
  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  const alumno1 = await abrirCliente();
  enviar(alumno1.ws, { type: 'join', meetingCode, role: 'student', email });
  await esperarTipo(alumno1.mensajes, 'class_status');
  await esperarCondicion(async () => (await obtenerSesiones(meetingCode, email)).length === 1);
  await cerrarYEsperar(alumno1.ws);
  await esperarCondicion(async () => {
    const [sesion] = await obtenerSesiones(meetingCode, email);
    return sesion && sesion.desconectadoEn !== null;
  });

  const alumno2 = await abrirCliente();
  enviar(alumno2.ws, { type: 'join', meetingCode, role: 'student', email });
  await esperarTipo(alumno2.mensajes, 'class_status');

  const hayDosTramos = await esperarCondicion(async () => (await obtenerSesiones(meetingCode, email)).length === 2);
  assert.ok(hayDosTramos, 'Una reconexión durante la misma clase activa debería generar un tramo de sesión nuevo.');

  const sesiones = await obtenerSesiones(meetingCode, email);
  assert.ok(sesiones[0].desconectadoEn !== null, 'El primer tramo debería estar cerrado.');
  assert.equal(sesiones[1].desconectadoEn, null, 'El segundo tramo (la reconexión) debería seguir abierto.');

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno2.ws);
  await limpiarReunion(meetingCode);
});

test('Etapa 68 — un "re-join" sobre el MISMO socket físico (catch-up, ver wsClient.js) no duplica la sesión abierta', async () => {
  const meetingCode = nuevoMeetingCode('sesion-rejoin-mismo-socket');
  const email = 'alumno@test.com';
  await asegurarUsuarioYReunion(meetingCode, email);

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');
  await crearDocumentoListo(meetingCode);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email });
  await esperarTipo(alumno.mensajes, 'class_status');
  await esperarCondicion(async () => (await obtenerSesiones(meetingCode, email)).length === 1);

  // Mismo socket físico, un "join" más — exactamente lo que
  // `wsClient.js` reenvía como catch-up cuando encuentra la conexión ya
  // OPEN (ver `unirseASala` ahí).
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email });
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(
    (await obtenerSesiones(meetingCode, email)).length,
    1,
    'Un re-join sobre la misma conexión NO debería abrir una segunda sesión mientras la primera sigue en curso.'
  );

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('Etapa 68 — el nombre del alumno (Cambio 2) viaja en "students_updated"', async () => {
  const meetingCode = nuevoMeetingCode('nombre-en-listado');
  const email = 'alumno@test.com';
  const connection = await pool.getConnection();
  try {
    const [usuarioResult] = await connection.query(
      'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [email]
    );
    const [reunionResult] = await connection.query(
      'INSERT INTO meetings (meeting_code) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [meetingCode]
    );
    await connection.query(
      `INSERT INTO participations (meeting_id, user_id, role, name, normalized_name)
       VALUES (?, ?, 'student', 'Carla Ortiz', 'carla ortiz')`,
      [reunionResult.insertId, usuarioResult.insertId]
    );
  } finally {
    connection.release();
  }

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');
  profesor.mensajes.length = 0;

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email });
  await esperarTipo(alumno.mensajes, 'class_status');

  const evento = await esperarTipo(profesor.mensajes, 'students_updated');
  assert.deepEqual(evento.students, [{ email, name: 'Carla Ortiz' }]);

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});
