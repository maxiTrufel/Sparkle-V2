// Etapa 68, Cambio 2 — test de integración REAL (backend Express + WS
// reales, base real) para el lado del docente: mismo patrón que
// `App.integracionBackendReal.test.js`/`App.registroNombreAlumno.test.js`.
//
// Cubre:
//   - Cambio 2: el listado de "alumnos conectados" del docente muestra el
//     NOMBRE (destacado) además del email (secundario).
//
// Pedido explícito posterior — el botón "Ver historial de participantes"
// (Cambio 3) y la pantalla `StudentHistory.jsx` que abría se sacaron del
// panel del docente; los dos tests que cubrían esa vista se sacaron de acá
// con el mismo pedido (uno de punta a punta, otro del estado vacío).
//
// El alumno de estos tests se simula con un cliente WS crudo (no una
// segunda instancia de `App.jsx`, que competiría por los mismos globals de
// jsdom que la del docente — ver el comentario de `openWsClient` en
// `App.integracionBackendReal.test.js`) — alcanza para ejercitar el lado
// del docente de punta a punta, que es lo que estos tests verifican.
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
  waitUntil,
  cleanupTestBundles,
  uploadRealDocument,
  chooseAttentionMode,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', 'backend');
const express = require(path.join(BACKEND_ROOT, 'node_modules', 'express'));
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

function newMeetingCode() {
  const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `${letters(3)}-${letters(4)}-${letters(3)}`;
}

async function cleanupMeeting(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

async function getRealRole(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/role?${params.toString()}`);
  return resp.json();
}

async function registerRealRole(meetingCode, email, role) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role: role }),
  });
  return { status: resp.status, body: await resp.json() };
}

async function registerRealStudent(meetingCode, email, name) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, name: name }),
  });
  return { status: resp.status, body: await resp.json() };
}

// Etapa 71 — ver `App.welcomeYaHayDocente.test.js` para los tests
// dedicados; acá solo hace falta rutearlo para que el boot real de
// `App.jsx` no dependa del `{ ok: true }` genérico del mock.
async function getRealHasTeacher(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/has-teacher?${params.toString()}`);
  return resp.json();
}

async function getRealHistory(meetingCode) {
  const params = new URLSearchParams({ meetingCode });
  const resp = await fetch(`${apiUrl}/api/meetings/history?${params.toString()}`);
  return resp.json();
}

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
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No llegó un mensaje de tipo "${type}" dentro de ${timeoutMs}ms.`);
}

async function mountRealAppAsTeacher({ meetingCode, email }) {
  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);

  const bridge = createRealWsBridge({ wsUrl });

  const chromeMock = installChromeMock(async (type, payload) => {
    if (type === 'SPARKLE_GET_ROLE') return getRealRole(payload.meetingCode, payload.email);
    if (type === 'SPARKLE_REGISTER_ROLE') {
      const { body } = await registerRealRole(payload.meetingCode, payload.email, payload.role);
      return body;
    }
    if (type === 'SPARKLE_GET_HISTORY') return getRealHistory(payload.meetingCode);
    if (type === 'SPARKLE_GET_HAS_TEACHER') {
      return getRealHasTeacher(payload.meetingCode, payload.email);
    }
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

// Etapa 69 — "Soy Docente" ya no asigna el rol de una: pasa por
// `ConfirmTeacher.jsx` primero (ver `App.integracionBackendReal.test.js`,
// mismo helper).
async function chooseAndConfirmTeacher(container) {
  buttonWithText(container, 'Soy Docente').click();
  await waitUntil(() => container.textContent.includes('¿Sos el docente de esta clase?'), { timeoutMs: 4000 });
  buttonWithText(container, 'Sí, soy el docente').click();
}

// Espera a que "Comenzar Clase" no solo esté en el DOM sino HABILITADO —
// requisito de producto (documento cargado) — antes de clickearlo. Un
// `.click()` sobre un `<button disabled>` es un no-op silencioso tanto en
// jsdom como en un navegador real, así que un test que no espera esto
// puede seguir de largo sin haber arrancado la clase de verdad y recién
// fallar varios pasos después, lejos de la causa real (el bug que motivó
// este helper).
async function waitForStartClassEnabled(container) {
  return waitUntil(() => Boolean(buttonWithText(container, 'Comenzar Clase')) && !buttonWithText(container, 'Comenzar Clase').disabled, {
    timeoutMs: 4000,
  });
}

test('el docente ve nombre + email del alumno conectado en el listado de Alumnos', async () => {
  const meetingCode = newMeetingCode();
  const teacherEmail = 'docente-historial@test.com';
  const studentEmail = 'alumno-historial@test.com';

  let { container, unmount } = await mountRealAppAsTeacher({ meetingCode, email: teacherEmail });
  let studentWs;

  try {
    await waitUntil(() => container.textContent.includes('Soy Docente'), { timeoutMs: 4000 });
    await chooseAndConfirmTeacher(container);

    const reachedStartClass = await waitUntil(() => container.textContent.includes('Comenzar Clase'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedStartClass, `Debería llegar al panel del docente. Texto: ${container.textContent}`);

    // El material se sube DESPUÉS de que el panel ya montó una vez (`role`
    // recién se confirmó arriba) — `useDocumentUpload` solo consulta el
    // documento vigente UNA VEZ al montar, sin polling, así que hace falta
    // cerrar y volver a abrir el panel para que la próxima consulta lo
    // encuentre. Ese mismo remount ejercita, de paso, el requisito real
    // "el documento se recupera al volver a abrir el panel" (ver
    // `hooks/useDocumentUpload.js`).
    unmount();
    await uploadRealDocument(apiUrl, meetingCode, teacherEmail, { pool });
    ({ container, unmount } = await mountRealAppAsTeacher({ meetingCode, email: teacherEmail }));

    await chooseAttentionMode(container);
    const startEnabled = await waitForStartClassEnabled(container);
    assert.ok(
      startEnabled,
      `"Comenzar Clase" debería habilitarse tras cargar el material. Texto: ${container.textContent}`
    );

    buttonWithText(container, 'Comenzar Clase').click();
    const classStarted = await waitUntil(() => container.textContent.includes('Clase en curso'), { timeoutMs: 4000 });
    assert.ok(classStarted, `La clase debería haber arrancado. Texto: ${container.textContent}`);

    // El alumno confirma su nombre (vía REST, como haría `StudentName.jsx`
    // de verdad) y se une por WS con la clase YA activa.
    await registerRealStudent(meetingCode, studentEmail, 'Sofía Torres');
    const studentConnection = await openWsClient();
    studentWs = studentConnection.ws;
    const studentMessages = studentConnection.messages;
    sendWs(studentWs, { type: 'join', meetingCode, role: 'student', email: studentEmail });
    await waitForType(studentMessages, 'class_status');

    // Cambio 2 — el padrón de la tab "Alumnos" (Ajuste post-entrega: ahora es
    // el listado real, no un mock) muestra nombre + estado por alumno.
    buttonWithText(container, 'Alumnos').click();
    const sawName = await waitUntil(() => container.textContent.includes('Sofía Torres'), { timeoutMs: 4000 });
    assert.ok(sawName, `Debería mostrar el nombre del alumno conectado. Texto: ${container.textContent}`);

    const studentItem = [...container.querySelectorAll('.sparkle-roster-item')].find((el) =>
      el.textContent.includes('Sofía Torres')
    );
    assert.ok(studentItem, 'Debería existir un ítem de listado para este alumno.');
    const nameEl = studentItem.querySelector('.sparkle-roster-name');
    assert.equal(nameEl?.textContent, 'Sofía Torres');
    assert.ok(
      studentItem.textContent.includes('En línea'),
      `El alumno recién conectado debería figurar "En línea". Texto: ${studentItem.textContent}`
    );
  } finally {
    // `studentWs` puede no haber llegado a abrirse si el test falló antes
    // — cerrarlo acá (no solo al final del `try`) es lo que evita dejar un
    // socket físico colgado recibiendo pings del servidor para siempre si
    // algún `assert` de arriba revienta (esa conexión huérfana era lo que
    // impedía que `wss.close()` en `test.after()` llegara a resolver, y
    // con eso, que el proceso de test terminara).
    studentWs?.close();
    unmount();
    await cleanupMeeting(meetingCode);
  }
});
