// Arrancar y reanudar la clase también piden el bot de Vexa.
//
// EL HUECO QUE ESTO CUBRE
// -----------------------
// El bot se pedía SOLO en el `join` del docente al WebSocket. Eso alcanza
// para el arranque normal, pero deja el `join` como la única oportunidad de
// conseguir un bot en toda la reunión: si el bot se cae o lo echan del Meet
// a mitad de clase, la única forma de recuperarlo era que el docente
// recargara la pestaña.
//
// Encontrado el 6/9/2026 echando el bot a mano de una reunión en curso:
// "Detener clase" + "Reanudar clase" no generó un solo `startBot`, y la
// clase siguió sin transcripción sin dar ninguna señal.
//
// Volver a pedirlo es barato: si el bot está vivo, Vexa contesta 409 y
// `startBot` corta sin tocar nada.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const pool = require('../src/db');

// Doble de Vexa, instalado antes de cargar el WS: `handlers.js` guarda el
// módulo entero, así que pisar sus propiedades alcanza.
const vexaService = require('../src/services/vexaService');
const pedidosDeBot = [];
vexaService.startBot = async (meetingCode) => { pedidosDeBot.push(meetingCode); };
vexaService.startPolling = () => {};
vexaService.stopBot = async () => {};
vexaService.stopPolling = () => {};

const { startWebSocketServer } = require('../src/ws');

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

async function esperarTipo(mensajes, tipo, timeoutMs = 3000) {
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

// "start_class" exige un documento ya analizado; estos tests son sobre el
// bot, no sobre la carga.
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
     VALUES (?, ?, 'material.pdf', 'material.pdf', 'application/pdf', 1024, 'processed')
     ON DUPLICATE KEY UPDATE analysis_status = 'processed'`,
    [reunion.insertId, usuario.insertId]
  );
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

test('"start_class" vuelve a pedir el bot, además del pedido del join', async () => {
  const meetingCode = nuevoMeetingCode('bot-start');
  const email = 'docente@test.com';
  pedidosDeBot.length = 0;

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email });
  await esperarTipo(profesor.mensajes, 'class_status');

  const pedidosTrasElJoin = pedidosDeBot.filter((c) => c === meetingCode).length;
  assert.equal(pedidosTrasElJoin, 1, 'el join siempre pidió el bot; eso no cambia');

  await crearDocumentoListo(meetingCode, email);
  enviar(profesor.ws, { type: 'start_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_started');

  assert.equal(
    pedidosDeBot.filter((c) => c === meetingCode).length,
    2,
    'arrancar la clase no volvió a pedir el bot: si se cayó, no hay forma de recuperarlo sin recargar'
  );

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});

test('"resume_class" también vuelve a pedir el bot', async () => {
  // Es el caso real que lo destapó: al docente le echaron el bot, apretó
  // "Detener clase" y "Reanudar clase", y no pasó nada.
  const meetingCode = nuevoMeetingCode('bot-resume');
  const email = 'docente@test.com';

  await crearDocumentoListo(meetingCode, email);
  // Una finalización automática recién ocurrida es lo que hace reanudable a
  // una clase (ver `isResumable` en classService, umbral de 5 minutos).
  await pool.query(
    `UPDATE meetings SET active = 0, last_ended_type = 'automatic', last_ended_at = NOW()
     WHERE meeting_code = ?`,
    [meetingCode]
  );

  const profesor = await abrirCliente();
  enviar(profesor.ws, { type: 'join', meetingCode, role: 'teacher', email });
  await esperarTipo(profesor.mensajes, 'class_status');

  pedidosDeBot.length = 0;
  enviar(profesor.ws, { type: 'resume_class', meetingCode });
  await esperarTipo(profesor.mensajes, 'class_resumed');

  assert.ok(
    pedidosDeBot.includes(meetingCode),
    'reanudar la clase no volvió a pedir el bot'
  );

  await cerrarYEsperar(profesor.ws);
  await limpiarReunion(meetingCode);
});
