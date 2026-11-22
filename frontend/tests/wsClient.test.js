// Test de los Problemas 1 (Etapa 52) y del ping/pong de liveness (Etapa
// 54): "WebSocket no conectado a esa sala todavía — reintentá en un
// momento." apareciendo en CUALQUIER botón del docente
// (comenzar/finalizar/reanudar clase), y conexiones "zombie" (reportan
// `readyState === OPEN` pero ya no transportan nada) que un simple chequeo
// de `readyState` no puede distinguir de una conexión sana. Corre en Node
// puro, sin browser real: se mockean los únicos dos globals que
// `services/wsClient.js` toca (`WebSocket` nativo y `chrome.tabs`), así
// que puede probarse la lógica de espera/reintento/reconstrucción/liveness
// de la sala sin necesitar Chrome ni un backend real levantado (a
// diferencia de `backend/tests/ws.test.js`, que sí prueba contra un
// servidor real).
//
// Etapa de traducción (Paso 1/3) — las funciones importadas de
// `services/wsClient.js` ya tienen sus nombres nuevos en inglés; el
// PROTOCOLO WS en sí (`type: 'join'`/`'start_class'`/etc., campo `rol`)
// todavía es el de siempre — se traduce recién en el Paso 3, junto con el
// backend (ver DOCUMENTACION.md, Etapa 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  // Registro de TODAS las instancias creadas — el módulo real no expone su
  // Map interno de salas, así que este es el único gancho para llegar,
  // desde el test, al socket físico que `wsClient.js` acaba de crear.
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sentMessages = [];
    this._listeners = {};
    // Etapa 54 — por defecto, un mock "sano" contesta cualquier
    // `{ type: 'ping' }` con un `{ type: 'pong' }`, simulando al servidor
    // real (ver `backend/src/ws/index.js`) — así los tests que NO están
    // probando específicamente el liveness check (la mayoría, heredados de
    // la Etapa 52) no se ven afectados por él. Los tests que SÍ quieren
    // simular una conexión zombie ponen esto en `false` a mano.
    this.respondsToPing = true;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, cb) {
    (this._listeners[type] ??= []).push(cb);
  }

  removeEventListener(type, cb) {
    this._listeners[type] = (this._listeners[type] || []).filter((fn) => fn !== cb);
  }

  send(data) {
    const message = JSON.parse(data);
    this.sentMessages.push(message);
    if (message.type === 'ping' && this.respondsToPing) {
      // Async (macrotask), no sincrónico -- más fiel a una respuesta real
      // de red, y evita reentrancia rara si algún día un listener de
      // 'message' termina disparando otro `send` en el mismo tick.
      setTimeout(() => this._emit('message', { data: JSON.stringify({ type: 'pong' }) }), 0);
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    // Etapa 56: el 'close' real del navegador siempre viaja con un
    // `CloseEvent` (`code`/`reason`) — el código bajo prueba ahora lo lee
    // para loguear diagnóstico, así que el mock tiene que imitarlo.
    this._emit('close', { code: 1000, reason: '' });
  }

  // Helper de test, no parte de la API real de WebSocket: simula que el
  // handshake termina recién ahora (la latencia real de red/reconexión que
  // el bug original no toleraba).
  _open() {
    this.readyState = MockWebSocket.OPEN;
    this._emit('open');
  }

  _emit(type, ...args) {
    for (const cb of this._listeners[type] || []) cb(...args);
  }
}

globalThis.WebSocket = MockWebSocket;

// Etapa 57 — a diferencia de `chrome.tabs`, `chrome.alarms` SÍ se toca en
// el top-level de `wsClient.js` (el `chrome.alarms.create(...)` que
// registra el keepalive corre al evaluar el módulo, no dentro de ninguna
// función) — así que este mock tiene que estar listo ANTES del import
// dinámico de más abajo. `createdAlarms` y `triggerAlarm` quedan
// expuestos para que los tests de Etapa 57 puedan verificar el registro y
// simular que Chrome disparó el alarm, sin depender de esperar 30s reales.
const createdAlarms = [];
let alarmListener = null;
function triggerAlarm(name) {
  alarmListener?.({ name });
}

globalThis.chrome = {
  tabs: {
    sendMessage(_tabId, _message) {
      return Promise.resolve();
    },
  },
  alarms: {
    create(name, options) {
      createdAlarms.push({ name, options });
    },
    onAlarm: {
      addListener(fn) {
        alarmListener = fn;
      },
    },
  },
};

// Import dinámico: `chrome.alarms.create(...)` SÍ corre en el top-level de
// `wsClient.js` al evaluarse el módulo (Etapa 57) — los mocks de arriba
// tienen que estar instalados ANTES de este import, no después.
const { joinRoom, keepRoomAlive, endClass, startClass, leaveRoom } = await import(
  '../src/services/wsClient.js'
);

function lastCreatedSocket() {
  return MockWebSocket.instances.at(-1);
}

test('Problema 1 — un comando del docente ya NO falla instantáneamente si el socket todavía está CONNECTING', async () => {
  const meetingCode = 'sala-connecting';
  joinRoom(1, meetingCode, 'teacher', 'docente@test.com'); // crea el socket, queda CONNECTING

  const socket = lastCreatedSocket();
  assert.equal(socket.readyState, MockWebSocket.CONNECTING);

  const commandPromise = endClass(1, meetingCode, 'docente@test.com');

  // Todavía no se "abrió" el socket a propósito — con el código VIEJO, la
  // promesa de arriba ya habría rechazado en este punto (chequeo
  // instantáneo de `readyState === OPEN`). Con el fix, sigue pendiente.
  await new Promise((r) => setTimeout(r, 50));

  // Recién ahora "termina" el handshake (simula la latencia real de red).
  socket._open();

  const result = await commandPromise;
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    socket.sentMessages.find((m) => m.type === 'end_class'),
    { type: 'end_class', meetingCode }
  );
});

test('Problema 1 — un comando se autorepara si la sala no existía en el background (ej. service worker reiniciado)', async () => {
  const meetingCode = 'sala-perdida';
  // A propósito NO se llama `joinRoom` antes -- simula que el service
  // worker se reinició y perdió el Map en memoria, pero el content script
  // (que sí sobrevivió) igual manda el comando con el mismo tabId/email de
  // siempre.
  const commandPromise = startClass(7, meetingCode, 'docente@test.com');

  await new Promise((r) => setTimeout(r, 50));
  const socket = lastCreatedSocket();
  assert.ok(socket, 'el comando debería haber reconstruido la sala y creado un socket nuevo');

  socket._open();

  const result = await commandPromise;
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    socket.sentMessages.find((m) => m.type === 'start_class'),
    { type: 'start_class', meetingCode }
  );
});

test('Problema 1 — si la conexión nunca llega a abrirse, el comando rechaza con un error claro (no se cuelga para siempre)', async () => {
  const meetingCode = 'sala-nunca-conecta';
  joinRoom(1, meetingCode, 'teacher', 'docente@test.com');
  // A propósito nunca se llama `socket._open()` acá.

  await assert.rejects(
    () => endClass(1, meetingCode, 'docente@test.com'),
    /WebSocket no conectado a esa sala todavía/
  );
});

test('Etapa 54 — una conexión "zombie" (OPEN pero no responde al ping) se detecta y se reconecta antes de ejecutar el comando', async () => {
  const meetingCode = 'sala-zombie';
  joinRoom(1, meetingCode, 'teacher', 'docente@test.com');

  const zombieSocket = lastCreatedSocket();
  zombieSocket._open(); // readyState queda OPEN...
  zombieSocket.respondsToPing = false; // ...pero no contesta nada -- conexión muerta que el navegador todavía no notó

  const instanceCountBefore = MockWebSocket.instances.length;
  const commandPromise = endClass(1, meetingCode, 'docente@test.com');

  // Con el código VIEJO (Etapa 52, solo chequeaba `readyState`), esto
  // habría mandado "end_class" directo al socket zombie y resuelto
  // "exitosamente" sin que el mensaje fuera a llegar nunca a ningún lado —
  // exactamente el bug reportado ("deja de tener efecto" tras estar
  // inactivo). Con el fix, se espera a que aparezca una conexión NUEVA
  // (la vieja se cierra sola al no contestar el ping a tiempo).
  let newSocket;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (MockWebSocket.instances.length > instanceCountBefore) {
      newSocket = MockWebSocket.instances.at(-1);
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(newSocket, 'debería haberse creado un socket nuevo tras detectar la conexión zombie');
  assert.notEqual(newSocket, zombieSocket);

  newSocket._open(); // esta sí contesta el ping (respondsToPing sigue en `true` por default)

  const result = await commandPromise;
  assert.deepEqual(result, { ok: true });
  // El comando tiene que haber viajado por el socket NUEVO, nunca por el
  // zombie (que ni siquiera tiene sentido revisar: el "ping" sin contestar
  // es lo único que le llegó a mandar).
  assert.deepEqual(
    newSocket.sentMessages.find((m) => m.type === 'end_class'),
    { type: 'end_class', meetingCode }
  );
  assert.equal(
    zombieSocket.sentMessages.some((m) => m.type === 'end_class'),
    false
  );
});

test('Etapa 80 — con tráfico entrante reciente, el comando se manda directo, sin ping previo', async () => {
  const meetingCode = 'sala-trafico-reciente';
  joinRoom(1, meetingCode, 'teacher', 'docente@test.com');
  const socket = lastCreatedSocket();
  socket._open();
  // El servidor acaba de mandar algo (en una clase real, `attention_roster_updated`).
  socket._emit('message', { data: JSON.stringify({ type: 'students_updated', students: [] }) });
  socket.sentMessages.length = 0;

  const result = await endClass(1, meetingCode, 'docente@test.com');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(socket.sentMessages, [{ type: 'end_class', meetingCode }]);
});

test('Etapa 80 — sin tráfico reciente se sigue verificando con ping antes del comando', async () => {
  const meetingCode = 'sala-sin-trafico';
  joinRoom(1, meetingCode, 'teacher', 'docente@test.com');
  const socket = lastCreatedSocket();
  socket._open();
  socket.sentMessages.length = 0;

  await endClass(1, meetingCode, 'docente@test.com');

  assert.deepEqual(
    socket.sentMessages.map((m) => m.type),
    ['ping', 'end_class']
  );
});

test('Etapa 57 — se registra un chrome.alarms de keepalive con el período mínimo permitido', () => {
  const alarm = createdAlarms.find((a) => a.name === 'sparkle-keepalive');
  assert.ok(alarm, 'debería haber registrado un alarm de keepalive al cargar el módulo');
  assert.equal(alarm.options.periodInMinutes, 0.5);
  assert.equal(alarm.options.delayInMinutes, 0.5);
});

test('Etapa 57 — keepRoomAlive reconstruye la sala (join completo) si no existía', async () => {
  const meetingCode = 'sala-keepalive-perdida';
  keepRoomAlive(2, meetingCode, 'teacher', 'docente@test.com');

  await new Promise((r) => setTimeout(r, 50));
  const socket = lastCreatedSocket();
  assert.ok(socket, 'debería haber creado una conexión física nueva');

  socket._open();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    socket.sentMessages.some((m) => m.type === 'join'),
    'al reconstruir una sala perdida sí hace falta un "join" completo'
  );
});

test('Etapa 57 — keepRoomAlive NO reenvía un "join" completo si la sala ya está sana (evita ruido de broadcasts)', async () => {
  const meetingCode = 'sala-keepalive-sana';
  joinRoom(1, meetingCode, 'student', 'alumno@test.com');
  const socket = lastCreatedSocket();
  socket._open();
  await new Promise((r) => setTimeout(r, 20));
  socket.sentMessages.length = 0; // limpio el "join" inicial, me interesa solo lo que manda el tick de keepalive

  keepRoomAlive(1, meetingCode, 'student', 'alumno@test.com');
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    socket.sentMessages.some((m) => m.type === 'join'),
    false,
    'una sala ya conectada no debería recibir un "join" completo en cada tick de keepalive'
  );
  assert.ok(
    socket.sentMessages.some((m) => m.type === 'ping'),
    'sí debería haber mandado un ping de verificación de liveness'
  );
});

// Etapa 66 — bug real reportado ("el docente no ve al alumno que ya estaba
// conectado desde antes"): investigando se confirmó que el servidor SIEMPRE
// mandaba el catch-up correcto (ver `backend/tests/ws.test.js`) -- el bug
// real vivía acá, del lado del cliente. Antes de este fix, `rooms` se
// indexaba SOLO por `meetingCode`: si el MISMO background (mismo navegador,
// dos pestañas de la misma reunión -- el escenario típico al probar la
// extensión con ambos roles a mano) manejaba una pestaña "alumno" y otra
// "profesor" para el mismo `meetingCode`, la segunda `joinRoom` reusaba
// la conexión física de la primera y le pisaba la identidad (`room.role`/
// `room.email`), reenviando un "join" con el rol nuevo sobre EL MISMO
// socket -- el servidor no tiene forma de distinguir eso de "esta conexión
// ahora es otra persona" (ver `handleJoin` en `backend/src/ws/index.js`),
// así que la conexión que estaba registrada como alumno se convertía en la
// del docente, y el alumno desaparecía sin haberse desconectado de verdad.
test('Etapa 66 — dos identidades distintas (alumno y profesor) para el mismo meetingCode obtienen conexiones físicas INDEPENDIENTES', async () => {
  const meetingCode = 'sala-dos-identidades';

  joinRoom(1, meetingCode, 'student', 'alumno@test.com');
  const studentSocket = lastCreatedSocket();
  studentSocket._open();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    studentSocket.sentMessages.map((m) => m.type),
    ['join'],
    'el socket del alumno debería haber mandado exactamente un "join" propio'
  );

  const instanceCountBefore = MockWebSocket.instances.length;
  joinRoom(2, meetingCode, 'teacher', 'docente@test.com');

  assert.equal(
    MockWebSocket.instances.length,
    instanceCountBefore + 1,
    'el join del profesor debería haber creado una conexión física NUEVA, no reusar la del alumno'
  );
  const teacherSocket = lastCreatedSocket();
  assert.notEqual(teacherSocket, studentSocket);

  teacherSocket._open();
  await new Promise((r) => setTimeout(r, 20));

  // El bug real: antes de este fix, el socket del alumno recibía un SEGUNDO
  // "join" con rol="profesor" (pisando su propia identidad). Con el fix,
  // el socket del alumno queda intacto -- solo tiene su "join" original.
  assert.deepEqual(
    studentSocket.sentMessages,
    [{ type: 'join', meetingCode, role: 'student', email: 'alumno@test.com' }],
    'el join del profesor NO debería haber tocado el socket físico del alumno'
  );
  assert.deepEqual(
    teacherSocket.sentMessages.find((m) => m.type === 'join'),
    { type: 'join', meetingCode, role: 'teacher', email: 'docente@test.com' }
  );
});

// Caso borde explícito (pedido junto con el fix de arriba): la MISMA
// pestaña que cambia de identidad para la MISMA reunión (ej. un docente
// rechazado por "join_rejected" que elige "Unirme como alumno", ver
// `TeacherPanel.jsx`/`App.jsx`) no debería dejar una conexión física vieja
// huérfana, registrada para siempre con esa pestaña adentro.
test('Etapa 66 — una pestaña que cambia de rol para el mismo meetingCode limpia su sala anterior (no queda huérfana)', async () => {
  const meetingCode = 'sala-cambio-de-rol';

  // Simula el join de "profesor" que el servidor terminó rechazando (desde
  // el punto de vista de `wsClient.js`, que no sabe nada de rechazos -- solo
  // le importa que esta pestaña ya estaba registrada bajo esa identidad).
  joinRoom(9, meetingCode, 'teacher', 'alguien@test.com');
  const oldSocket = lastCreatedSocket();
  oldSocket._open();
  await new Promise((r) => setTimeout(r, 20));

  // La misma pestaña (mismo tabId=9) se une ahora como "alumno" -- el flujo
  // real de "Unirme como alumno" tras un rechazo.
  joinRoom(9, meetingCode, 'student', 'alguien@test.com');
  const newSocket = lastCreatedSocket();
  assert.notEqual(newSocket, oldSocket);

  // La sala vieja se quedó sin ninguna pestaña interesada (la única que
  // tenía era la 9, recién movida) -- debería haberse cerrado sola.
  assert.equal(oldSocket.readyState, MockWebSocket.CLOSED, 'la conexión física vieja debería haberse cerrado');

  newSocket._open();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    newSocket.sentMessages.find((m) => m.type === 'join'),
    { type: 'join', meetingCode, role: 'student', email: 'alguien@test.com' }
  );

  // `leaveRoom` (llamado cuando la pestaña deja de estar 'en-llamada')
  // no debería revivir ni tocar la sala vieja ya limpiada -- confirma que
  // no queda ningún rastro fantasma de la identidad "profesor" de antes.
  await assert.doesNotReject(() => Promise.resolve(leaveRoom(9, meetingCode)));
});

test('Etapa 57 — el barrido de chrome.alarms detecta y repara una sala zombie sin necesitar ningún tabId', async () => {
  const meetingCode = 'sala-alarm-zombie';
  joinRoom(1, meetingCode, 'student', 'alumno@test.com');
  const zombieSocket = lastCreatedSocket();
  zombieSocket._open();
  zombieSocket.respondsToPing = false; // deja de contestar -- simula quedar en silencio

  assert.ok(typeof alarmListener === 'function', 'debería haberse registrado un listener de onAlarm al cargar el módulo');

  const instanceCountBefore = MockWebSocket.instances.length;
  triggerAlarm('sparkle-keepalive'); // simula que Chrome disparó el alarm (sin que ninguna pestaña haya mandado nada)

  let newSocket;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (MockWebSocket.instances.length > instanceCountBefore) {
      newSocket = MockWebSocket.instances.at(-1);
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(newSocket, 'el barrido del alarm debería haber detectado la conexión zombie y reconectado, sin depender de ningún tabId');
  assert.notEqual(newSocket, zombieSocket);
});
