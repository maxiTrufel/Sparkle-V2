// Período de gracia antes de sacar el bot de Vexa de la reunión.
//
// EL BUG QUE ESTO CUBRE
// ---------------------
// Es el hermano del de `teacherDisconnectGrace.test.js`, en el camino de al
// lado, y el arreglo de v0.1.2 no lo cubría. Cuando la sala WS de Sparkle
// quedaba COMPLETAMENTE vacía, el bot de transcripción salía de la reunión
// en el acto. Como Chrome congela las pestañas en segundo plano y les
// cierra el WebSocket, basta con que las pestañas del docente y del alumno
// se congelen casi a la vez para que la sala parezca vacía por un instante
// y el bot abandone una reunión que sigue en curso.
//
// Pasó en producción en la reunión "jaa-ybou-siz" (6/9/2026): los dos
// sockets se cerraron con 200 ms de diferencia, el bot salió, y los dos
// volvieron dos segundos después. La clase se salvó —esa ya tenía gracia—
// pero el bot no, y el bot NUEVO que pidió la reconexión se quedó esperando
// que alguien lo admitiera en Meet hasta que Google lo descartó.
//
// ⚠️ POR QUÉ ESTE ARCHIVO ESTÁ SEPARADO
// Mismo motivo que el otro: la ventana se lee de `process.env` UNA sola
// vez, al cargar `src/ws/handlers.js`, así que hay que fijarla antes de ese
// require. `node --test` corre cada archivo en su propio proceso.
process.env.EMPTY_ROOM_BOT_GRACE_MS = '150';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const pool = require('../src/db');

// El doble de Vexa se instala ANTES de cargar el WS: `handlers.js` guarda
// el módulo entero, no cada función, así que pisar las propiedades del
// objeto exportado alcanza y no hace falta ningún framework de mocks.
// Sin esto los tests pegarían contra la Vexa de verdad (o fallarían por no
// tener sus variables de entorno).
const vexaService = require('../src/services/vexaService');
const llamadas = { stopBot: [], stopPolling: [], startBot: [], startPolling: [] };
vexaService.stopBot = async (meetingCode) => { llamadas.stopBot.push(meetingCode); };
vexaService.stopPolling = (meetingCode) => { llamadas.stopPolling.push(meetingCode); };
vexaService.startBot = async (meetingCode) => { llamadas.startBot.push(meetingCode); };
vexaService.startPolling = (meetingCode) => { llamadas.startPolling.push(meetingCode); };

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

// Bastante MÁS que la ventana, para que un fallo signifique "no salió" y no
// "todavía no le tocó".
function esperarVencimientoDeLaGracia() {
  return new Promise((r) => setTimeout(r, GRACIA_MS * 6));
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

test('La sala que queda vacía y se repuebla dentro de la gracia NO pierde el bot', async () => {
  const meetingCode = nuevoMeetingCode('bot-vuelve');
  llamadas.stopBot.length = 0;

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  // Las dos pestañas se congelan: la sala queda vacía sin que nadie se haya
  // ido de verdad. Esto es lo que antes sacaba el bot al instante.
  await cerrarYEsperar(profesor.ws);

  const reconexion = await abrirCliente();
  enviar(reconexion.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(reconexion.mensajes, 'class_status');

  await esperarVencimientoDeLaGracia();

  assert.equal(
    llamadas.stopBot.includes(meetingCode),
    false,
    'el bot salió de la reunión pese a que la sala se repobló dentro del período de gracia'
  );

  await cerrarYEsperar(reconexion.ws);
  await limpiarReunion(meetingCode);
});

test('Un ALUMNO que vuelve también cancela la salida del bot, no solo el docente', async () => {
  // Lo que dispara la salida es que no quede NADIE, así que cualquier rol
  // que vuelva tiene que alcanzar para cancelarla. Si esto se rompiera, el
  // caso real —docente y alumno congelándose juntos y el alumno volviendo
  // primero— dejaría la reunión sin transcripción igual.
  const meetingCode = nuevoMeetingCode('bot-alumno');
  llamadas.stopBot.length = 0;

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  const alumno = await abrirCliente();
  enviar(alumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(alumno.mensajes, 'class_status');

  await cerrarYEsperar(profesor.ws);
  await cerrarYEsperar(alumno.ws);

  const vuelveElAlumno = await abrirCliente();
  enviar(vuelveElAlumno.ws, { type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' });
  await esperarTipo(vuelveElAlumno.mensajes, 'class_status');

  await esperarVencimientoDeLaGracia();

  assert.equal(
    llamadas.stopBot.includes(meetingCode),
    false,
    'el bot salió aunque un alumno había vuelto a la sala'
  );

  await cerrarYEsperar(vuelveElAlumno.ws);
  await limpiarReunion(meetingCode);
});

test('Si no vuelve nadie, el bot SÍ sale cuando vence la gracia', async () => {
  // La contracara: demorar la salida no puede convertirse en no sacarlo
  // nunca. Un bot olvidado en una reunión terminada sigue grabando y
  // consumiendo la notebook.
  const meetingCode = nuevoMeetingCode('bot-se-va');
  llamadas.stopBot.length = 0;
  llamadas.stopPolling.length = 0;

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' });
  await esperarTipo(profesor.mensajes, 'class_status');

  await cerrarYEsperar(profesor.ws);
  await esperarVencimientoDeLaGracia();

  assert.ok(llamadas.stopBot.includes(meetingCode), 'el bot se quedó en una reunión que nadie volvió a poblar');
  assert.ok(llamadas.stopPolling.includes(meetingCode), 'el polling de transcripción siguió corriendo sin nadie en la sala');

  await limpiarReunion(meetingCode);
});
