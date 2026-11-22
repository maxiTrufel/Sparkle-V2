// Investigación de regresiones reportadas DESPUÉS de probar en Chrome real,
// en dos rondas:
//
//   Ronda 1 (Etapa 59): la restricción de "un solo profesor" (resultó NO
//   ser un bug real) y "Detener Clase" no llevaba a "Reanudar clase" (SÍ
//   era un bug real, arreglado esa etapa).
//   Ronda 2 (Etapa 60, estos tres problemas): el rol "profesor" quedaba
//   persistido en la base aunque el WS rechazara la conexión; el botón
//   "Unirme como alumno" no aparecía en Chrome real (build stale, ver
//   DOCUMENTACION.md); y el mensaje "El docente ha detenido la clase."
//   cambiaba solo a los pocos segundos.
//
// El motivo por el que rondas anteriores de tests no agarraron todo esto:
// se mockeaba `SPARKLE_REGISTER_ROLE`/`SPARKLE_GET_ROLE` como un simple
// `{ ok: true }`/`backendRole` fijo, sin pasar NUNCA por el endpoint REST
// real -- exactamente donde vivía el Problema 1 de esta ronda. Estos tests
// levantan, en el MISMO `http.Server` (igual que `backend/src/server.js`
// en producción), tanto el servidor WS real como la app Express real con
// el router `/api/meetings` real -- así `Welcome.jsx` →
// `registerMeetingRole` → REST real → chequeo real contra el estado real
// de conexiones del WS (misma instancia de módulo, mismo `salas` Map) es
// una cadena end-to-end sin ningún atajo simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleAppForTest,
  installDom,
  installChromeMock,
  addActiveCallSignals,
  createRealWsBridge,
  wait,
  waitUntil,
  cleanupTestBundles,
  uploadRealDocument,
  chooseAttentionMode,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Requiere el backend real por ruta relativa -- Node resuelve sus propias
// dependencias (mysql2, express, etc.) contra `backend/node_modules`, no
// contra `frontend/node_modules` (ver el mismo patrón en Etapa 59).
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', 'backend');
// `express` se requiere por ruta absoluta contra `backend/node_modules`
// (no es una dependencia de `frontend/`) -- mismo motivo que requerir los
// módulos de `backend/src` de abajo por ruta en vez de por specifier.
const express = require(path.join(BACKEND_ROOT, 'node_modules', 'express'));

// La finalización automática por desconexión del docente espera 90 s en
// producción antes de dar la clase por terminada (ver
// `GRACIA_DESCONEXION_DOCENTE_MS` en `backend/src/ws/handlers.js`: sin esa
// gracia, el congelado de pestañas de Chrome cerraba el WebSocket y
// terminaba la clase sola). Acá se levanta el backend REAL en este mismo
// proceso, así que esa espera es la de verdad — y el test de "reanudar"
// de más abajo se quedaría esperando minuto y medio.
//
// ⚠️ Tiene que ir ANTES del `require` de `src/ws`: la constante se lee del
// entorno una sola vez, cuando se carga el módulo.
process.env.TEACHER_DISCONNECT_GRACE_MS = '100';

const { startWebSocketServer } = require(path.join(BACKEND_ROOT, 'src', 'ws'));
const meetingsRouter = require(path.join(BACKEND_ROOT, 'src', 'routes', 'meetings'));
const pool = require(path.join(BACKEND_ROOT, 'src', 'db'));

let server;
let wss;
let wsUrl;
let apiUrl;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);

  server = http.createServer(app);
  wss = startWebSocketServer(server, []);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  wsUrl = `ws://localhost:${port}/ws`;
  apiUrl = `http://localhost:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await cleanupTestBundles();
});

async function cleanupMeeting(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

// `getMeetingCode()` (`frontend/src/utils/meetContext.js`) exige el
// formato REAL de Meet -- 3 grupos de SOLO LETRAS separados por guiones
// (`/^[a-z]+-[a-z]+-[a-z]+$/i`), sin dígitos ni guiones de más. Un código
// que no matchee ese patrón hace que `getMeetingCode()` devuelva `null`
// silenciosamente, con lo cual TODA la app queda inerte (nunca se une a
// ninguna sala) sin ningún error visible -- confirmado como trampa real en
// la Etapa 59.
function newMeetingCode() {
  const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `${letters(3)}-${letters(4)}-${letters(3)}`;
}

// Llamadas REST directas contra el servidor real -- exactamente lo que
// `frontend/src/services/api.js` hace, salvo por la URL (esa sale de
// `VITE_BACKEND_URL`, con default a :3000; acá usamos el puerto efímero
// real de este test).
async function registerRealRole(meetingCode, email, role) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role: role }),
  });
  return { status: resp.status, body: await resp.json() };
}

async function getRealRole(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/role?${params.toString()}`);
  return resp.json();
}

// Etapa 71 — ¿ya hay un docente permanente para esta reunión con otro
// email? Ver `App.welcomeYaHayDocente.test.js` para los tests dedicados a
// esto (Capa 1/Capa 2); acá solo hace falta rutearlo para que el boot de
// `App.jsx` (y el chequeo fresco al clickear "Soy Docente") peguen contra
// el backend real en vez de caer en el `{ ok: true }` genérico del mock.
async function getRealHasTeacher(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/has-teacher?${params.toString()}`);
  return resp.json();
}

// Etapa 68 — registro de nombre (Cambio 1): a diferencia de
// `registerRealRole`, acá SÍ importa el `status` (200 vs 409), que es lo
// que `StudentName.jsx` usa para distinguir "aceptado" de "nombre
// duplicado" — ver `services/api.js`.
async function registerRealStudent(meetingCode, email, name) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, name: name }),
  });
  return { status: resp.status, body: await resp.json() };
}

// Inserta una fila de `participations` DIRECTO por SQL, bypasseando el
// chequeo del endpoint REST -- simula el estado corrupto que dejaba el bug
// viejo (Problema 1: `role='teacher'` persistido pese a estar rechazado),
// para poder probar que el WS lo autolimpia al rechazar esa conexión (ver
// Problema 1, segundo test más abajo).
async function insertDirectParticipation(meetingCode, email, role) {
  const [userResult] = await pool.query(
    'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [email]
  );
  const [meetingResult] = await pool.query(
    'INSERT INTO meetings (meeting_code) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [meetingCode]
  );
  await pool.query(
    `INSERT INTO participations (meeting_id, user_id, role) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [meetingResult.insertId, userResult.insertId, role]
  );
}

// Cliente WS crudo (Node WebSocket nativo, Node 22+) para representar "la
// otra persona ya conectada" sin montar una segunda instancia de App.jsx
// -- dos instancias de App.jsx simultáneas competirían por los mismos
// globals de jsdom (`global.window`/`global.document`, ver
// `installDom()`), así que un cliente WS crudo es la forma fiel de
// simular una SEGUNDA conexión física real sin ese conflicto.
function openWsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const messages = [];
    ws.addEventListener('message', (event) => messages.push(JSON.parse(event.data)));
    ws.addEventListener('open', () => resolve({ ws, messages }), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function sendWs(ws, message) {
  ws.send(JSON.stringify(message));
}

async function waitForType(messages, type, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find((m) => m.type === type);
    if (found) return found;
    await wait(25);
  }
  throw new Error(`No llegó un mensaje de tipo "${type}" dentro de ${timeoutMs}ms. Recibidos: ${JSON.stringify(messages)}`);
}

// Monta un `App.jsx` REAL conectado al backend REAL, tanto por WS
// (`createRealWsBridge`) como por REST (`registerRealRole`/`getRealRole`
// de acá arriba, contra el mismo servidor) -- sin `backendRole` fijo por
// mock: si nadie registró un rol antes para este email+reunión, `App.jsx`
// arranca genuinamente en `Welcome.jsx`, igual que en Chrome real.
async function mountRealApp({ meetingCode, email }) {
  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);

  const bridge = createRealWsBridge({ wsUrl });

  const chromeMock = installChromeMock(async (type, payload) => {
    if (type === 'SPARKLE_GET_ROLE') return getRealRole(payload.meetingCode, payload.email);
    if (type === 'SPARKLE_REGISTER_ROLE') {
      const { body } = await registerRealRole(payload.meetingCode, payload.email, payload.role);
      return body;
    }
    // Etapa 68 — devuelve `{ status, body }` tal cual `services/api.js`: es lo
    // que `StudentName.jsx` necesita para distinguir 200 de 409.
    if (type === 'SPARKLE_REGISTER_STUDENT') {
      return registerRealStudent(payload.meetingCode, payload.email, payload.name);
    }
    if (type === 'SPARKLE_GET_HAS_TEACHER') {
      return getRealHasTeacher(payload.meetingCode, payload.email);
    }
    // Requisito de producto — el panel del docente consulta el documento
    // vigente de la reunión contra el backend real, mismo criterio que el
    // resto de este mock (sin atajos simulados). Ver
    // `frontend/src/hooks/useDocumentUpload.js`.
    if (type === 'SPARKLE_GET_DOCUMENT') {
      const params = new URLSearchParams({ email: payload.email });
      const resp = await fetch(`${apiUrl}/api/meetings/${payload.meetingCode}/documents?${params.toString()}`);
      return resp.json();
    }
    if (type === 'SPARKLE_UPLOAD_DOCUMENT') {
      const blob = new Blob([payload.fileData.buffer], { type: payload.fileData.type });
      const formData = new FormData();
      formData.append('email', payload.email);
      formData.append('file', blob, payload.fileData.name);
      const resp = await fetch(`${apiUrl}/api/meetings/${payload.meetingCode}/documents`, { method: 'POST', body: formData });
      return { status: resp.status, body: await resp.json() };
    }
    const wsResult = await bridge.handleWsCommand(type, payload);
    if (wsResult !== undefined) return wsResult;
    return { ok: true };
  });
  bridge.setEmitter(chromeMock.emitFromBackground);

  const bundlePath = await bundleAppForTest('src/App.jsx');
  const { mount, unmount } = require(bundlePath);

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  mount(container);

  return {
    dom,
    container,
    unmount: () => {
      unmount();
      bridge.close();
    },
  };
}

function buttonWithText(container, text) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));
}

// Etapa 68 — simula tipear en un input controlado de React bajo jsdom (ver
// el mismo patrón en `App.registroNombreAlumno.test.js`, acá inlineado para
// no sumar una dependencia entre archivos de test).
function typeIntoInput(window, input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

// Etapa 68 — completa el paso de "Unirme como alumno" que ahora pasa por
// `StudentName.jsx`: espera la pantalla, escribe un nombre y confirma.
async function completeNameRegistration(dom, container, name) {
  await waitUntil(() => container.textContent.includes('¿Cómo te llamás?'), { timeoutMs: 4000 });
  const input = container.querySelector('.sparkle-input');
  typeIntoInput(dom.window, input, name);
  buttonWithText(container, 'Confirmar').click();
}

// Etapa 69 — clickear "Soy Docente" en Welcome ya no asigna el rol de una:
// muestra `ConfirmTeacher.jsx` primero. Este helper hace los dos clicks
// (elegir + confirmar) para los tests que solo les interesa llegar al otro
// lado, sin ejercitar el diálogo de confirmación en sí (eso lo cubre
// `App.confirmarDocenteYVolver.test.js`).
async function chooseAndConfirmTeacher(container) {
  buttonWithText(container, 'Soy Docente').click();
  await waitUntil(() => container.textContent.includes('¿Sos el docente de esta clase?'), { timeoutMs: 4000 });
  buttonWithText(container, 'Sí, soy el docente').click();
}

// Requisito de producto — "Comenzar Clase" queda deshabilitado sin un
// documento cargado para la reunión (ver
// `frontend/src/hooks/useDocumentUpload.js`,
// `backend/src/ws/handlers.js#handleStartClass`). Un `.click()` sobre un
// `<button disabled>` es un no-op silencioso (tanto en jsdom como en un
// navegador real) — sin este chequeo explícito, un test podía seguir de
// largo creyendo que la clase arrancó y recién fallar varios pasos
// después, lejos de la causa real.
async function waitForStartClassEnabled(container) {
  return waitUntil(
    () => Boolean(buttonWithText(container, 'Comenzar Clase')) && !buttonWithText(container, 'Comenzar Clase').disabled,
    { timeoutMs: 4000 }
  );
}

// ─── Problema 1 — el rol "profesor" ya no se persiste si el WS rechaza ───

// Etapa 61 — actualizado: bajo la restricción PERMANENTE, lo que bloquea
// a otro email es el REGISTRO persistido (`participations`), no solo una
// conexión WS activa sin registrar (eso ya no alcanza por sí solo — ver
// el flujo real en `Welcome.jsx`, que siempre registra por REST ANTES de
// que el join por WS llegue a mandarse). Este test ahora registra al
// profesor existente por REST primero, igual que haría un docente real.
test('Problema 1 (integración real) — register-role NO persiste "profesor" si ya hay otro profesor registrado y conectado', async () => {
  const meetingCode = newMeetingCode();
  const existingEmail = 'docente-uno@test.com';
  const newEmail = 'docente-dos@test.com';

  await registerRealRole(meetingCode, existingEmail, 'teacher');
  const { ws: existingWs, messages } = await openWsClient();
  sendWs(existingWs, { type: 'join', meetingCode, role: 'teacher', email: existingEmail });
  await waitForType(messages, 'class_status');

  try {
    const { status, body } = await registerRealRole(meetingCode, newEmail, 'teacher');
    assert.equal(status, 409, `Debería rechazar con 409. Body: ${JSON.stringify(body)}`);

    const { role } = await getRealRole(meetingCode, newEmail);
    assert.equal(role, null, 'No debería haber quedado NINGÚN rol persistido para el docente rechazado.');
  } finally {
    existingWs.close();
    await cleanupMeeting(meetingCode);
  }
});

test('Problema 1 (integración real, regresión) — register-role SÍ persiste "profesor" cuando no hay conflicto', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-solo@test.com';

  const { status } = await registerRealRole(meetingCode, email, 'teacher');
  assert.equal(status, 200);

  const { role } = await getRealRole(meetingCode, email);
  assert.equal(role, 'teacher');

  await cleanupMeeting(meetingCode);
});

test('Problema 1 (integración real, regresión) — el mismo docente reconectándose (mismo email) SÍ puede re-registrarse', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente@test.com';

  const { ws, messages } = await openWsClient();
  sendWs(ws, { type: 'join', meetingCode, role: 'teacher', email });
  await waitForType(messages, 'class_status');

  try {
    // Re-registrar el MISMO rol para el MISMO email mientras esa conexión
    // sigue viva (ej. reabrió el panel) no debería contar como conflicto
    // consigo mismo -- mismo criterio que ya usa `handleJoin()` en el WS.
    const { status } = await registerRealRole(meetingCode, email, 'teacher');
    assert.equal(status, 200);
  } finally {
    ws.close();
    await cleanupMeeting(meetingCode);
  }
});

// ─── Regresiones de la Etapa 59, re-adaptadas al harness con REST real ───

test('Etapa 59 (regresión) — el mismo docente reconectándose (mismo email) llega a su panel normal, sin quedar rechazado', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente@test.com';
  await registerRealRole(meetingCode, email, 'teacher');

  const { ws: oldConnection, messages } = await openWsClient();
  sendWs(oldConnection, { type: 'join', meetingCode, role: 'teacher', email });
  await waitForType(messages, 'class_status');

  const { container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    const reachedStartClass = await waitUntil(() => container.textContent.includes('Comenzar Clase'), {
      timeoutMs: 4000,
    });
    assert.ok(
      reachedStartClass,
      `El mismo docente reconectándose debería llegar a su panel normal, no quedar rechazado. Texto: ${container.textContent}`
    );
    assert.ok(!container.textContent.includes('Ya hay un docente asignado para esta reunión.'));
  } finally {
    unmount();
    // `oldConnection` NO se cierra sola: el servidor la saca de la sala al
    // reemplazarla por la reconexión, pero nunca cierra su socket físico.
    oldConnection.close();
    await cleanupMeeting(meetingCode);
  }
});

test('Etapa 59 (regresión) — tras "Detener Clase" en la MISMA conexión (sin recargar), el docente ve "Reanudar clase"', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente@test.com';
  await registerRealRole(meetingCode, email, 'teacher');
  // Requisito de producto — "Comenzar Clase" exige un documento cargado
  // (ver `waitForStartClassEnabled`). Se sube ANTES de montar (igual que
  // `registerRealRole` arriba): el rol ya está persistido en este punto,
  // así que `useDocumentUpload` lo encuentra en su primera consulta, sin
  // necesitar un remount.
  await uploadRealDocument(apiUrl, meetingCode, email, { pool });

  const { container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    const reachedStartClass = await waitUntil(() => container.textContent.includes('Comenzar Clase'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedStartClass, `Debería llegar a "Comenzar Clase" primero. Texto: ${container.textContent}`);

    await chooseAttentionMode(container);
    const startEnabled = await waitForStartClassEnabled(container);
    assert.ok(startEnabled, `"Comenzar Clase" debería estar habilitado (documento ya cargado). Texto: ${container.textContent}`);

    buttonWithText(container, 'Comenzar Clase').click();
    await waitUntil(() => container.textContent.includes('Clase en curso'), { timeoutMs: 4000 });

    const stopButton = buttonWithText(container, 'Detener Clase');
    assert.ok(stopButton, `Debería existir el botón "Detener Clase". Texto: ${container.textContent}`);
    stopButton.click();

    // Ajuste post-entrega — "Detener Clase" ahora abre un modal de
    // confirmación antes de detener la clase de verdad.
    await waitUntil(() => container.textContent.includes('¿Estás seguro de que querés detener la clase?'), {
      timeoutMs: 4000,
    });
    buttonWithText(container, 'Detener clase').click();

    const reachedResume = await waitUntil(() => container.textContent.includes('Reanudar clase'), {
      timeoutMs: 4000,
    });
    assert.ok(
      reachedResume,
      `Debería mostrar "Reanudar clase" en la MISMA conexión, sin reconectar. Texto final: ${container.textContent}`
    );
    assert.ok(
      !container.textContent.includes('Comenzar Clase'),
      `No debería volver a "Comenzar Clase" tras detener manualmente. Texto final: ${container.textContent}`
    );
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// Etapa 61 — este test se reescribió: bajo la restricción PERMANENTE
// (ver más abajo), la premisa vieja de "otra persona genuinamente distinta
// puede unirse igual porque el 'corrupto' no está conectado" ya NO
// aplica -- CUALQUIER fila `role='teacher'` existente (corrupta o no)
// bloquea a TODOS los demás emails, estén conectados o no (es la esencia
// del Cambio 1). El escenario que sigue teniendo sentido probar es otro:
// una anomalía real de datos (dos emails DISTINTOS con `role='teacher'`
// para la MISMA reunión — no debería poder pasar bajo los chequeos
// nuevos, pero podría existir como dato legado) se autolimpia del lado
// que corresponde en cuanto ese email intenta actuar como profesor de
// nuevo y es rechazado.
test('Etapa 61 (integración real) — una fila "profesor" duplicada/anómala se autolimpia del lado rechazado, sin tocar la legítima', async () => {
  const meetingCode = newMeetingCode();
  const legitimateEmail = 'docente-legitimo@test.com';
  const anomalousEmail = 'docente-anomalo@test.com';

  // Anomalía simulada a mano (vía SQL directo, bypasseando los chequeos):
  // DOS emails distintos con `role='teacher'` para la misma reunión.
  await insertDirectParticipation(meetingCode, legitimateEmail, 'teacher');
  await insertDirectParticipation(meetingCode, anomalousEmail, 'teacher');

  const { ws: anomalousWs, messages: anomalousMessages } = await openWsClient();
  sendWs(anomalousWs, { type: 'join', meetingCode, role: 'teacher', email: anomalousEmail });

  try {
    const rejection = await waitForType(anomalousMessages, 'join_rejected');
    assert.equal(rejection.reason, 'teacher_exists');

    const wasCleaned = await waitUntil(
      async () => (await getRealRole(meetingCode, anomalousEmail)).role === null,
      { timeoutMs: 2000 }
    );
    assert.ok(wasCleaned, 'La fila "profesor" del lado rechazado debería haberse limpiado.');

    const { role: legitimateRole } = await getRealRole(meetingCode, legitimateEmail);
    assert.equal(legitimateRole, 'teacher', 'La fila legítima NO debería haberse tocado.');
  } finally {
    anomalousWs.close();
    await cleanupMeeting(meetingCode);
  }
});

// ─── Problema 2 — flujo completo Welcome → rechazo → "Unirme como alumno" ───

test('Problema 2 (integración real, flujo completo) — desde Welcome: elegir Docente, ser rechazado, ver el botón, y unirse como alumno', async () => {
  const meetingCode = newMeetingCode();
  const existingEmail = 'docente-uno@test.com';
  const newEmail = 'docente-dos@test.com';

  const { ws: existingWs, messages } = await openWsClient();
  sendWs(existingWs, { type: 'join', meetingCode, role: 'teacher', email: existingEmail });
  await waitForType(messages, 'class_status');

  const { dom, container, unmount } = await mountRealApp({ meetingCode, email: newEmail });

  try {
    // Arranca en Welcome de verdad (nadie registró ningún rol para este
    // email+reunión todavía) -- no hay ningún atajo de `backendRole` acá.
    const reachedWelcome = await waitUntil(() => container.textContent.includes('Soy Docente'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedWelcome, `Debería mostrar Welcome primero. Texto: ${container.textContent}`);

    await chooseAndConfirmTeacher(container);

    const rejected = await waitUntil(
      () => container.textContent.includes('Ya hay un docente asignado para esta reunión.'),
      { timeoutMs: 4000 }
    );
    assert.ok(rejected, `Debería ver la pantalla de rechazo. Texto: ${container.textContent}`);

    // El registro de rol vía Welcome debería haber sido rechazado por el
    // backend (Problema 1) -- confirmado independientemente por SQL, no
    // solo inferido de la UI.
    const { role: roleAfterRejection } = await getRealRole(meetingCode, newEmail);
    assert.equal(roleAfterRejection, null, 'No debería haber quedado "profesor" persistido para quien fue rechazado.');

    const button = buttonWithText(container, 'Unirme como alumno');
    assert.ok(button, `Debería existir el botón "Unirme como alumno". Texto: ${container.textContent}`);
    button.click();

    // Etapa 68 — "Unirme como alumno" lleva a la pantalla de registro de
    // nombre, no asigna el rol de una (ver `completeNameRegistration`).
    await completeNameRegistration(dom, container, 'Alumno Reintentado');

    const reachedStudent = await waitUntil(() => container.textContent.includes('La clase está detenida'), {
      timeoutMs: 4000,
    });
    assert.ok(
      reachedStudent,
      `Tras confirmar el nombre debería pasar al panel de alumno. Texto final: ${container.textContent}`
    );

    const { role: finalRole } = await getRealRole(meetingCode, newEmail);
    assert.equal(finalRole, 'student', 'Debería haber quedado registrado como alumno tras confirmar el nombre.');
  } finally {
    unmount();
    existingWs.close();
    await cleanupMeeting(meetingCode);
  }
});

// ─── Problema 3 — el aviso de "clase detenida" ya no cambia solo ───

test('Problema 3 (integración real) — el aviso de "clase detenida" queda fijo, no cambia solo después de unos segundos', async () => {
  const meetingCode = newMeetingCode();
  const teacherEmail = 'docente@test.com';

  // El "docente" de este test es un cliente WS crudo (no una segunda
  // instancia de App.jsx, ver el comentario de `openWsClient`) -- lo que
  // se está probando es el timer del lado del ALUMNO, que es 100% cliente
  // y no necesita una UI de docente real para dispararse.
  //
  // Requisito de producto — "start_class" por WS exige un documento
  // cargado para la reunión (ver `backend/src/ws/handlers.js#handleStartClass`).
  // Como acá no hay ninguna UI de docente montada, se registra el rol y se
  // sube el documento por REST antes de mandar el comando crudo.
  await registerRealRole(meetingCode, teacherEmail, 'teacher');
  await uploadRealDocument(apiUrl, meetingCode, teacherEmail, { pool });

  const { ws: teacherWs, messages: teacherMessages } = await openWsClient();
  sendWs(teacherWs, { type: 'join', meetingCode, role: 'teacher', email: teacherEmail });
  await waitForType(teacherMessages, 'class_status');
  sendWs(teacherWs, { type: 'start_class', meetingCode });
  await waitForType(teacherMessages, 'class_started');

  // Registra a este alumno de antemano (equivalente a haber elegido "Soy
  // Alumno" en Welcome) ANTES de montar `App.jsx` -- la resolución de rol
  // inicial consulta el rol apenas se monta, así que registrarlo después
  // llega tarde y el componente cae en Welcome en vez de unirse directo.
  await registerRealRole(meetingCode, 'alumno@test.com', 'student');
  const { container, unmount } = await mountRealApp({ meetingCode, email: 'alumno@test.com' });

  try {
    const sawClassStarted = await waitUntil(() => container.textContent.includes('Clase en curso'), {
      timeoutMs: 4000,
    });
    assert.ok(sawClassStarted, `El alumno debería ver la clase iniciada. Texto: ${container.textContent}`);

    sendWs(teacherWs, { type: 'end_class', meetingCode });
    await waitForType(teacherMessages, 'class_ended');

    const sawNotice = await waitUntil(() => container.textContent.includes('La clase está detenida'), {
      timeoutMs: 4000,
    });
    assert.ok(sawNotice, `El alumno debería ver el aviso de detención. Texto: ${container.textContent}`);
    // El botón "Obtener resumen de la clase" es lo único que distingue este
    // caso (clase real que se detuvo) del de un alumno que nunca vio nada
    // — ambos comparten el mismo título unificado (`ui/ClassPausedCard.jsx`).
    const sawSummaryButton = () =>
      [...container.querySelectorAll('button')].some((b) => b.textContent.includes('Obtener resumen de la clase'));
    assert.ok(sawSummaryButton(), `Debería ofrecer "Obtener resumen de la clase". Texto: ${container.textContent}`);

    // Antes del fix, un timer de apagado automático apagaba el aviso solo
    // -- se espera bastante más que eso, con tiempo REAL (no timers
    // simulados), para confirmar que el mensaje NO cambia por el simple
    // paso del tiempo.
    await wait(5500);

    assert.ok(
      container.textContent.includes('La clase está detenida'),
      `El mensaje debería seguir fijo tras esperar. Texto tras esperar: ${container.textContent}`
    );
    assert.ok(
      sawSummaryButton(),
      `NO debería haber vuelto solo al caso "nunca vi una clase" (perdería el botón de resumen). Texto: ${container.textContent}`
    );

    // El mensaje SÍ debe cambiar ante un evento real: el docente reanuda.
    sendWs(teacherWs, { type: 'start_class', meetingCode });
    await waitForType(teacherMessages, 'class_started', 4000);

    const startedAgain = await waitUntil(() => container.textContent.includes('Clase en curso'), {
      timeoutMs: 4000,
    });
    assert.ok(
      startedAgain,
      `Debería reflejar la clase nueva iniciada. Texto final: ${container.textContent}`
    );
  } finally {
    unmount();
    teacherWs.close();
    await cleanupMeeting(meetingCode);
  }
});

// ─── Etapa 61 — restricción PERMANENTE de "un solo profesor por reunión" ───

test('Etapa 61 (integración real) — un profesor DESCONECTADO por completo sigue bloqueando a otro email (restricción permanente, no solo "mientras está conectado")', async () => {
  const meetingCode = newMeetingCode();
  const originalEmail = 'docente-original@test.com';
  const intruderEmail = 'docente-intruso@test.com';

  await registerRealRole(meetingCode, originalEmail, 'teacher');
  // Requisito de producto — ver el comentario equivalente en el test de
  // "Problema 3", más arriba.
  await uploadRealDocument(apiUrl, meetingCode, originalEmail, { pool });

  const { ws: originalConnection, messages: originalMessages } = await openWsClient();
  sendWs(originalConnection, { type: 'join', meetingCode, role: 'teacher', email: originalEmail });
  await waitForType(originalMessages, 'class_status');
  sendWs(originalConnection, { type: 'start_class', meetingCode });
  await waitForType(originalMessages, 'class_started');

  // El profesor original se desconecta POR COMPLETO -- ni una sola
  // conexión suya sigue viva. Bajo el diseño viejo (Etapa 60, restricción
  // solo mientras hay alguien CONECTADO) esto liberaba el lugar; bajo el
  // diseño nuevo (permanente) no debería cambiar nada.
  await new Promise((resolve) => {
    originalConnection.addEventListener('close', resolve, { once: true });
    originalConnection.close();
  });
  await wait(150); // le da tiempo a `handleTeacherDisconnection` a terminar de correr

  const { ws: intruderConnection, messages: intruderMessages } = await openWsClient();
  sendWs(intruderConnection, { type: 'join', meetingCode, role: 'teacher', email: intruderEmail });

  try {
    const rejection = await waitForType(intruderMessages, 'join_rejected');
    assert.equal(rejection.reason, 'teacher_exists');

    // Confirmado también contra el registro REST -- el intruso no debería
    // poder registrarse como profesor tampoco, por la misma razón.
    const { status } = await registerRealRole(meetingCode, intruderEmail, 'teacher');
    assert.equal(status, 409);
  } finally {
    intruderConnection.close();
    await cleanupMeeting(meetingCode);
  }
});

test('Etapa 61 (integración real) — un email que llegó a unirse como "profesor" localmente es rechazado al intentar "Comenzar Clase" si otro email ya se registró como profesor permanente', async () => {
  const meetingCode = newMeetingCode();
  const emailA = 'docente-a-primero-en-unirse@test.com';
  const emailB = 'docente-b-primero-en-registrarse@test.com';

  // Reunión BRAND NEW: nadie registrado todavía en `participations`.
  // Email A se une por WS primero (el join lo acepta: en este instante
  // nadie es profesor permanente todavía) -- pero A nunca llegó a llamar a
  // `/register-role` (ej. una demora de red, o probando directo contra el
  // WS). Mientras tanto, email B SÍ llama a `/register-role` y queda como
  // el profesor permanente. Esto reproduce el "caso borde de
  // sincronización" que pidió cubrirse: un socket con `role='teacher'`
  // local que ya no coincide con quién es el profesor permanente real.
  const { ws: wsA, messages: messagesA } = await openWsClient();
  sendWs(wsA, { type: 'join', meetingCode, role: 'teacher', email: emailA });
  await waitForType(messagesA, 'class_status');

  const { status } = await registerRealRole(meetingCode, emailB, 'teacher');
  assert.equal(status, 200, 'El registro de B debería pasar -- nadie más se había registrado todavía.');

  try {
    // A, sin enterarse de nada de lo anterior (sigue creyendo que es
    // profesor porque su "join" fue aceptado), intenta arrancar la clase.
    sendWs(wsA, { type: 'start_class', meetingCode });

    const rejection = await waitForType(messagesA, 'join_rejected');
    assert.equal(rejection.reason, 'teacher_exists');
    assert.ok(
      !messagesA.some((m) => m.type === 'class_started'),
      'La clase NO debería haber arrancado para un profesor que ya no es el permanente.'
    );

    const [rows] = await pool.query('SELECT active FROM meetings WHERE meeting_code = ?', [meetingCode]);
    assert.ok(
      rows.length === 0 || !rows[0].active,
      'La clase no debería haber quedado activa en la base tras el rechazo.'
    );
  } finally {
    wsA.close();
    await cleanupMeeting(meetingCode);
  }
});

test('Etapa 61 (integración real, regresión) — el profesor original reconectándose SÍ puede comenzar y reanudar su propia clase sin problema', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-original@test.com';

  await registerRealRole(meetingCode, email, 'teacher');
  // Requisito de producto — ver el comentario equivalente en el test de
  // "Problema 3", más arriba.
  await uploadRealDocument(apiUrl, meetingCode, email, { pool });

  const { ws: connection1, messages: messages1 } = await openWsClient();
  sendWs(connection1, { type: 'join', meetingCode, role: 'teacher', email });
  await waitForType(messages1, 'class_status');
  sendWs(connection1, { type: 'start_class', meetingCode });
  await waitForType(messages1, 'class_started');

  // Se desconecta por completo (igual que en el test de arriba) y se
  // reconecta con una conexión física NUEVA -- mismo email.
  await new Promise((resolve) => {
    connection1.addEventListener('close', resolve, { once: true });
    connection1.close();
  });
  // La espera tiene que superar el PERÍODO DE GRACIA (fijado en 100 ms
  // arriba para estos tests). Desde que existe, un docente que vuelve
  // ANTES de que venza no encuentra la clase finalizada —justamente para
  // que una pestaña congelada no la termine sola— y entonces no hay ningún
  // "class_resumable" que esperar. Este test es sobre el que vuelve TARDE:
  // lo que verifica es que al docente original NUNCA se lo rechace por la
  // restricción de "un solo profesor", y eso no cambió.
  await wait(600);

  const { ws: connection2, messages: messages2 } = await openWsClient();
  sendWs(connection2, { type: 'join', meetingCode, role: 'teacher', email });

  try {
    // La desconexión completa finalizó la clase automáticamente -- debería
    // ofrecerle reanudar (dentro de la ventana de 5 minutos, ver Etapa 50).
    const resumable = await waitForType(messages2, 'class_resumable');
    assert.ok(resumable);

    sendWs(connection2, { type: 'resume_class', meetingCode });
    const resumed = await waitForType(messages2, 'class_resumed');
    assert.ok(resumed);
    assert.ok(
      !messages2.some((m) => m.type === 'join_rejected'),
      'El profesor original reconectándose NUNCA debería ser rechazado.'
    );
  } finally {
    connection2.close();
    await cleanupMeeting(meetingCode);
  }
});

// ─── Etapa 61 — el chip de rol del header solo aparece una vez confirmado ───

function chipText(container) {
  const chip = container.querySelector('.sparkle-role-badge');
  return chip ? chip.textContent : null;
}

// Etapa 71 — el test que vivía acá ("el chip de rol NUNCA muestra 'Docente'
// para quien es rechazado") registraba al docente existente por REST ANTES
// de montar el segundo `App.jsx`, y esperaba ver "Soy Docente" en Welcome
// para poder clickearlo y quedar rechazado. Esa premisa ya no es válida:
// con la Capa 1 de esta etapa (preventiva, ver `Welcome.jsx`), un docente
// YA registrado por REST hace que "Soy Docente" ni siquiera se renderice —
// no hay nada que clickear para llegar a la pantalla de rechazo por ESE
// camino. El mismo invariante ("el chip nunca muestra 'Docente' para quien
// no es realmente el docente") se prueba ahora, de forma más precisa, en
// `App.welcomeYaHayDocente.test.js`: tanto para el caso preventivo (Welcome
// nunca ofrece "Soy Docente") como para el defensivo (Capa 2 — la carrera
// donde SÍ se llega a clickear "Soy Docente" porque el conflicto surgió
// después de cargar Welcome, y el chip tampoco muestra "Docente" ahí).

test('Etapa 61 (integración real, regresión) — el chip SÍ muestra "Docente" una vez que el rol está genuinamente confirmado (sin conflicto)', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-sin-conflicto@test.com';

  const { container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    assert.equal(chipText(container), null, 'No debería haber chip todavía, recién montado.');

    const reachedWelcome = await waitUntil(() => container.textContent.includes('Soy Docente'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedWelcome);
    assert.equal(chipText(container), null, 'Tampoco debería haber chip en Welcome.');

    await chooseAndConfirmTeacher(container);

    const reachedStartClass = await waitUntil(() => container.textContent.includes('Comenzar Clase'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedStartClass, `Debería llegar a su panel normal. Texto: ${container.textContent}`);
    assert.equal(chipText(container), 'Docente', 'El chip debería confirmar "Docente" una vez resuelto.');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});
