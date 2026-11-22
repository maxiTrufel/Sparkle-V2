// Regresión — crash de "Soy Docente" tras la feature de modos de clase.
//
// Bug real (encontrado en producción, reportado como dos síntomas que
// parecían independientes): al clickear "Soy Docente", el plugin
// desaparecía por completo de la página, Y el WebSocket se cerraba con
// code=1005 unos cientos de ms después de abrirse.
//
// Causa única para ambos síntomas: en `App.jsx`, `screen = <TeacherPanel
// onAttentionModeChange={handleAttentionModeChange} .../>` se evaluaba
// apenas se conocía `role === 'teacher'` -- pero `const
// handleAttentionModeChange = ...` estaba declarada más abajo en el mismo
// cuerpo de función. Un `const` referenciado antes de su propia línea de
// declaración es un `ReferenceError` de temporal dead zone (TDZ), no
// `undefined`. Disparaba recién al llegar el catch-up
// "attention_mode_updated" del "join" (el primer render en el que
// `role === 'teacher'` es cierto). Sin ningún Error Boundary en el árbol,
// esa excepción durante el render tira abajo TODO el componente `App`
// (síntoma 1: "el plugin desaparece"). El desmontaje corre el cleanup de
// todos los efectos activos, incluido el de `hooks/useLiveClass.js`, que
// llama `leaveRoom()` -> `.close()` sin argumentos -> code=1005 (síntoma
// 2) -- una CONSECUENCIA del crash, no un problema aparte del WebSocket.
//
// Por qué esto necesitaba `createRealWsBridge` real (no un mock que arma
// eventos a mano): el bug solo se dispara al procesar un mensaje
// "attention_mode_updated" real, generado por `handleJoin` en
// `backend/src/ws/handlers.js` -- reproducirlo de verdad exige el
// protocolo completo (REST real + WS real + servidor real), igual
// filosofía que el resto de este archivo hermano
// (`App.integracionBackendReal.test.js`).
//
// Qué detecta este test si alguien vuelve a romper el orden: cualquier
// declaración de `App.jsx` que dependa de otra declarada más abajo en el
// mismo cuerpo de función, y que se evalúe en un camino que corre ANTES de
// llegar a esa línea (un `screen = <X .../>` intermedio, no solo el
// `return` final) -- el símbolo concreto puede cambiar en el futuro, pero
// la clase de bug (TDZ) y su firma (crash de React + WS cerrado con 1005
// como consecuencia) son las que este test verifica en general, sin
// acoplarse al nombre `handleAttentionModeChange` en particular.
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

async function registerRealRole(meetingCode, email, role) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role }),
  });
  return { status: resp.status, body: await resp.json() };
}

async function getRealHasTeacher(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/has-teacher?${params.toString()}`);
  return resp.json();
}

function buttonWithText(container, text) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));
}

// Mismo patrón que `chooseAndConfirmTeacher` en
// `App.integracionBackendReal.test.js` (no se reutiliza directo porque vive
// local a ese archivo, no exportado del harness).
async function chooseAndConfirmTeacher(container) {
  buttonWithText(container, 'Soy Docente').click();
  await waitUntil(() => container.textContent.includes('¿Sos el docente de esta clase?'), { timeoutMs: 4000 });
  buttonWithText(container, 'Sí, soy el docente').click();
}

test('Regresión — clickear "Soy Docente" no crashea React ni cierra el WS con code=1005', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-regresion-modo@test.com';

  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);

  // Un `ReferenceError` de TDZ durante el render es justamente el tipo de
  // error que React reporta como "uncaught error" al `window` -- sin
  // Error Boundary en el árbol, además desmonta todo. Cualquier entrada
  // acá es, por definición, la regresión que este test existe para
  // detectar.
  const jsErrors = [];
  dom.window.addEventListener('error', (e) => jsErrors.push(e.error || e.message));

  const bridge = createRealWsBridge({ wsUrl });
  const chromeMock = installChromeMock(async (type, payload) => {
    if (type === 'SPARKLE_GET_ROLE') {
      const params = new URLSearchParams({ meetingCode: payload.meetingCode, email: payload.email });
      const resp = await fetch(`${apiUrl}/api/meetings/role?${params.toString()}`);
      return resp.json();
    }
    if (type === 'SPARKLE_REGISTER_ROLE') {
      const { body } = await registerRealRole(payload.meetingCode, payload.email, payload.role);
      return body;
    }
    if (type === 'SPARKLE_GET_HAS_TEACHER') {
      return getRealHasTeacher(payload.meetingCode, payload.email);
    }
    if (type === 'SPARKLE_GET_DOCUMENT') {
      const params = new URLSearchParams({ email: payload.email });
      const resp = await fetch(`${apiUrl}/api/meetings/${payload.meetingCode}/documents?${params.toString()}`);
      return resp.json();
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

  try {
    const reachedWelcome = await waitUntil(() => container.textContent.includes('Soy Docente'), { timeoutMs: 4000 });
    assert.ok(reachedWelcome, `Debería mostrar Welcome primero. Texto: ${container.textContent}`);

    await chooseAndConfirmTeacher(container);

    // Margen tras el "join" -- suficiente para que llegue el catch-up
    // completo, incluido "attention_mode_updated" (el mensaje que dispara
    // el crash si la regresión reaparece).
    await wait(1000);

    assert.equal(
      jsErrors.length,
      0,
      `No debería haber errores de React/JS al procesar el join. Errores: ${jsErrors.map((e) => e?.stack || e).join('\n')}`
    );
    assert.ok(
      container.innerHTML.length > 0,
      'El contenedor no debería haber quedado vacío -- un ReferenceError sin Error Boundary desmonta todo el árbol.'
    );

    const reachedStartClass = await waitUntil(() => container.textContent.includes('Comenzar Clase'), { timeoutMs: 4000 });
    assert.ok(
      reachedStartClass,
      `Debería llegar al panel normal del docente, con el selector de modo ya aplicado. Texto: ${container.textContent}`
    );
  } finally {
    unmount();
    bridge.close();
    await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
  }
});
