// Período de gracia ante la desconexión del docente.
//
// EL BUG QUE ESTO CUBRE
// ---------------------
// Chrome congela las pestañas en segundo plano y termina cerrándoles el
// WebSocket. Desde el servidor eso es idéntico a "el docente cerró la
// pestaña y se fue", así que la clase se finalizaba SOLA mientras el
// docente seguía en la reunión de Meet sin haber tocado nada. Pasó en
// producción durante la clase de prueba del 5/9/2026 (dos veces en
// veinticinco minutos) y también corriendo en local.
//
// El arreglo es demorar la finalización automática: si el docente vuelve
// dentro de la ventana, se cancela y la clase nunca se entera.
//
// ⚠️ POR QUÉ ESTE ARCHIVO ESTÁ SEPARADO DE `ws.test.js`
// La ventana se lee de `process.env` UNA VEZ, cuando se carga
// `src/ws/handlers.js`. Para probarla hay que fijarla en milisegundos
// ANTES de ese require — y dejarla en 150 ms para todo `ws.test.js`
// cambiaría el comportamiento de los otros tests de ese archivo. `node
// --test` corre cada archivo en su propio proceso, así que un archivo
// aparte es la forma limpia de tener otra configuración.
process.env.TEACHER_DISCONNECT_GRACE_MS = '150';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const pool = require('../src/db');
const { startWebSocketServer } = require('../src/ws');

const GRACIA_MS = 150;

let server;
let wss;
let wsUrl;

test.before(async () => {
  server = http.createServer();
  wss = startWebSocketServer(server, []);
  await new Promise((resolve) => server.listen(0, resolve));
  wsUrl = `ws://localhost:${server.address().port}/ws`;
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
  return `test-${etiqueta}-${crypto.randomBytes(4).toString('hex')}`;
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
  throw new Error(`No llegó "${tipo}" en ${timeoutMs}ms. Recibidos: ${JSON.stringify(mensajes)}`);
}

function cerrarYEsperar(ws) {
  return new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

// Mismo sembrado que `ws.test.js`: "start_class" exige un documento ya
// analizado, y estos tests son sobre la desconexión, no sobre la carga.
async function crearDocumentoListo(meetingCode, teacherEmail) {
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

async function claseSigueActiva(meetingCode) {
  const [filas] = await pool.query('SELECT active FROM meetings WHERE meeting_code = ?', [meetingCode]);
  return Boolean(filas[0] && filas[0].active);
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

// Espera bastante MÁS que la ventana, para que un fallo signifique "no
// finalizó" y no "todavía no le tocó".
function esperarVencimientoDeLaGracia() {
  return new Promise((r) => setTimeout(r, GRACIA_MS * 6));
}

test('El docente que se desconecta y VUELVE dentro del período de gracia no pierde la clase', async () => {
  const meetingCode = nuevoMeetingCode('gracia-vuelve');
  const email = 'docente@test.com';

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email });
  await esperarTipo(profesor.mensajes, 'class_status');

  await crearDocumentoListo(meetingCode, email);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  // La pestaña se congela: el socket se cierra sin que el docente haya
  // hecho nada. Esto es lo que antes finalizaba la clase al instante.
  await cerrarYEsperar(profesor.ws);

  // Vuelve enseguida, como cuando la pestaña pasa de nuevo al frente.
  const reconexion = await abrirCliente();
  enviar(reconexion.ws, { type: 'join', meetingCode, role: 'teacher', email });
  const estado = await esperarTipo(reconexion.mensajes, 'class_status');

  assert.equal(estado.active, true, 'Al reconectar dentro de la gracia, la clase tiene que seguir ACTIVA.');

  // Y sigue activa después de que la ventana original habría vencido: la
  // reconexión canceló el timer, no lo pospuso.
  await esperarVencimientoDeLaGracia();
  assert.ok(
    await claseSigueActiva(meetingCode),
    'El timer de finalización tendría que haberse CANCELADO al volver el docente, no solo retrasado.'
  );
  assert.ok(
    !reconexion.mensajes.some((m) => m.type === 'class_ended'),
    'No tendría que haber llegado ningún "class_ended".'
  );

  await cerrarYEsperar(reconexion.ws);
  await limpiarReunion(meetingCode);
});

test('El docente que NO vuelve termina finalizando la clase, igual que antes', async () => {
  const meetingCode = nuevoMeetingCode('gracia-no-vuelve');
  const email = 'docente@test.com';

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email });
  await esperarTipo(profesor.mensajes, 'class_status');

  await crearDocumentoListo(meetingCode, email);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  // Un alumno queda conectado: así la sala no se vacía y se comprueba que
  // lo que finaliza la clase es la ausencia del DOCENTE, no que no quede
  // nadie. Además es quien recibe el "class_ended".
  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  await cerrarYEsperar(profesor.ws);

  // Inmediatamente después de la desconexión la clase TODAVÍA está activa
  // — esa es justamente la diferencia con el comportamiento anterior.
  assert.ok(
    await claseSigueActiva(meetingCode),
    'La finalización tiene que ser DIFERIDA: apenas se corta el socket, la clase sigue activa.'
  );

  await esperarTipo(alumno.mensajes, 'class_ended', GRACIA_MS * 20);
  assert.ok(
    !(await claseSigueActiva(meetingCode)),
    'Vencida la gracia sin que el docente vuelva, la clase tiene que quedar finalizada.'
  );

  await cerrarYEsperar(alumno.ws);
  await limpiarReunion(meetingCode);
});

test('"Detener Clase" sigue siendo inmediato — el período de gracia no lo demora', async () => {
  const meetingCode = nuevoMeetingCode('gracia-manual');
  const email = 'docente@test.com';

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email });
  await esperarTipo(profesor.mensajes, 'class_status');

  await crearDocumentoListo(meetingCode, email);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  enviar(profesor.ws, { type: 'end_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_ended');

  // Sin esperar nada: la finalización manual es una intención explícita y
  // no pasa por la ventana de gracia.
  assert.ok(
    !(await claseSigueActiva(meetingCode)),
    'Una finalización manual tiene que impactar en la base al instante.'
  );

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});
