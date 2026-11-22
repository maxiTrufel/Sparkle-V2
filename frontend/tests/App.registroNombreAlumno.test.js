// Etapa 68, Cambio 1 — tests de integración REALES (backend Express + WS
// reales, base de datos real) del flujo completo de registro de nombre del
// alumno: mismo patrón que `App.integracionBackendReal.test.js` (servidor
// real levantado en un puerto efímero, `App.jsx` real montado sobre jsdom,
// sin ningún atajo simulado en el camino REST/WS).
//
// Cubre:
//   (a) el flujo completo Welcome → "Soy Alumno" → pantalla de nombre →
//       nombre duplicado rechazado → nombre válido aceptado, con el rechazo
//       y la aceptación confirmados independientemente contra la base
//       (no solo inferidos de la UI);
//   (b) el rol NO se asigna hasta confirmar el nombre (se consulta
//       `GET /rol` mientras la pantalla de nombre sigue abierta);
//   (c) un alumno que ya tiene nombre registrado no vuelve a ver la
//       pantalla al reconectarse (remonta `App.jsx` con el mismo
//       meetingCode/email);
//   (d) el mismo flujo de registro de nombre también se dispara desde
//       "Unirme como alumno" (Fix 3, cuando el rol "profesor" es
//       rechazado) — no solo desde Welcome.
//
// Etapa de traducción (Paso 3/4) — las rutas REST (`/api/meetings/...`), los
// campos del body/respuesta (`role`, `name`) y los `type` de los mensajes
// `chrome.runtime` (`SPARKLE_*`, 100% internos a la extensión) ya están en
// inglés.
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

async function registerRealStudent(meetingCode, email, name) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, name: name }),
  });
  return { status: resp.status, body: await resp.json() };
}

async function registerRealRole(meetingCode, email, role) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role: role }),
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

function openWsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

// Monta un `App.jsx` REAL contra el backend REAL (REST + WS), sin ningún
// `backendRole` fijo por mock — mismo patrón que
// `App.integracionBackendReal.test.js`. `SPARKLE_REGISTER_STUDENT` devuelve
// `{ status, body }` tal cual lo hace `services/api.js` de verdad (ver
// `StudentName.jsx`, que mira `result.status` para distinguir 200 de 409).
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
    if (type === 'SPARKLE_REGISTER_STUDENT') {
      return registerRealStudent(payload.meetingCode, payload.email, payload.name);
    }
    if (type === 'SPARKLE_GET_HAS_TEACHER') {
      return getRealHasTeacher(payload.meetingCode, payload.email);
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

// Simula tipear en un input controlado de React bajo jsdom: asignar
// `.value` directo no dispara el listener de `onChange` de React (que
// engancha el descriptor nativo, no la propiedad "de instancia") — hay que
// pasar por el setter nativo del prototipo y disparar el evento a mano,
// mismo patrón que usa Testing Library internamente.
function typeIntoInput(window, input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

// ─── (a)+(b) — flujo completo desde Welcome, con unicidad y sin asignar rol antes de confirmar ───

test('Welcome → "Soy Alumno" muestra la pantalla de nombre SIN asignar ningún rol todavía', async () => {
  const meetingCode = newMeetingCode();
  const email = 'alumno-flujo@test.com';
  const { container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    const reachedWelcome = await waitUntil(() => container.textContent.includes('Soy Alumno'), { timeoutMs: 4000 });
    assert.ok(reachedWelcome, `Debería mostrar Welcome primero. Texto: ${container.textContent}`);

    buttonWithText(container, 'Soy Alumno').click();

    const reachedName = await waitUntil(() => container.textContent.includes('¿Cómo te llamás?'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedName, `Debería mostrar la pantalla de registro de nombre. Texto: ${container.textContent}`);

    // El punto central del Cambio 1: elegir "Soy Alumno" todavía NO asignó
    // ningún rol — se confirma independientemente contra la base, no solo
    // infiriéndolo de la UI.
    const { role } = await getRealRole(meetingCode, email);
    assert.equal(role, null, 'No debería haber ningún rol asignado mientras la pantalla de nombre sigue abierta.');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

test('un nombre ya usado en la MISMA reunión se rechaza con un mensaje claro, y el rol sigue sin asignar', async () => {
  const meetingCode = newMeetingCode();
  const existingEmail = 'alumno-existente@test.com';
  const newEmail = 'alumno-nuevo@test.com';
  await registerRealStudent(meetingCode, existingEmail, 'Lucía Fernández');

  const { dom, container, unmount } = await mountRealApp({ meetingCode, email: newEmail });

  try {
    await waitUntil(() => container.textContent.includes('Soy Alumno'), { timeoutMs: 4000 });
    buttonWithText(container, 'Soy Alumno').click();
    await waitUntil(() => container.textContent.includes('¿Cómo te llamás?'), { timeoutMs: 4000 });

    const input = container.querySelector('.sparkle-input');
    assert.ok(input, `Debería haber un campo de texto para el nombre. Texto: ${container.textContent}`);
    typeIntoInput(dom.window, input, 'Lucía Fernández');
    buttonWithText(container, 'Confirmar').click();

    const sawError = await waitUntil(() => container.textContent.includes('ya está en uso en esta clase'), {
      timeoutMs: 4000,
    });
    assert.ok(sawError, `Debería mostrar el error de nombre duplicado. Texto: ${container.textContent}`);

    const { role: roleAfterRejection } = await getRealRole(meetingCode, newEmail);
    assert.equal(roleAfterRejection, null, 'El nombre duplicado no debería haber asignado ningún rol.');

    // Corrige con un nombre distinto -- debería aceptarse y pasar al panel.
    typeIntoInput(dom.window, input, 'Bruno Aguirre');
    buttonWithText(container, 'Confirmar').click();

    const reachedStudent = await waitUntil(() => container.textContent.includes('La clase está detenida'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedStudent, `Tras un nombre válido debería pasar al panel de alumno. Texto final: ${container.textContent}`);

    const { role: finalRole, name: finalName } = await getRealRole(meetingCode, newEmail);
    assert.equal(finalRole, 'student');
    assert.equal(finalName, 'Bruno Aguirre');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

test('el mismo nombre SÍ se acepta en una reunión DISTINTA (la unicidad es por reunión, no global)', async () => {
  const meetingCodeA = newMeetingCode();
  const meetingCodeB = newMeetingCode();
  await registerRealStudent(meetingCodeA, 'alumno-x@test.com', 'Carla Ortiz');

  const { dom, container, unmount } = await mountRealApp({ meetingCode: meetingCodeB, email: 'alumno-y@test.com' });

  try {
    await waitUntil(() => container.textContent.includes('Soy Alumno'), { timeoutMs: 4000 });
    buttonWithText(container, 'Soy Alumno').click();
    await waitUntil(() => container.textContent.includes('¿Cómo te llamás?'), { timeoutMs: 4000 });

    const input = container.querySelector('.sparkle-input');
    typeIntoInput(dom.window, input, 'Carla Ortiz');
    buttonWithText(container, 'Confirmar').click();

    const reachedStudent = await waitUntil(() => container.textContent.includes('La clase está detenida'), {
      timeoutMs: 4000,
    });
    assert.ok(
      reachedStudent,
      `El mismo nombre en otra reunión debería aceptarse sin problema. Texto final: ${container.textContent}`
    );
  } finally {
    unmount();
    await cleanupMeeting(meetingCodeA);
    await cleanupMeeting(meetingCodeB);
  }
});

// ─── (c) — reconexión: no vuelve a pedir el nombre ───

test('un alumno que ya tiene nombre registrado NO vuelve a ver la pantalla de nombre al reconectarse', async () => {
  const meetingCode = newMeetingCode();
  const email = 'alumno-reconecta@test.com';
  await registerRealStudent(meetingCode, email, 'Valentina Cruz');

  const { container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    const reachedPanelDirectly = await waitUntil(() => container.textContent.includes('La clase está detenida'), {
      timeoutMs: 4000,
    });
    assert.ok(
      reachedPanelDirectly,
      `Un alumno ya registrado debería entrar directo a su panel. Texto: ${container.textContent}`
    );
    assert.ok(
      !container.textContent.includes('¿Cómo te llamás?'),
      `No debería haber pasado por la pantalla de nombre en la reconexión. Texto: ${container.textContent}`
    );
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── (d) — "Unirme como alumno" (Fix 3) también pasa por el registro de nombre ───

test('"Unirme como alumno" desde la pantalla de rechazo también pide el nombre antes de asignar el rol', async () => {
  const meetingCode = newMeetingCode();
  const existingTeacherEmail = 'docente-existente@test.com';
  const rejectedEmail = 'aspirante-a-docente@test.com';

  const existingTeacherWs = await openWsClient();
  existingTeacherWs.send(JSON.stringify({ type: 'join', meetingCode, role: 'teacher', email: existingTeacherEmail }));

  const { dom, container, unmount } = await mountRealApp({ meetingCode, email: rejectedEmail });

  try {
    await waitUntil(() => container.textContent.includes('Soy Docente'), { timeoutMs: 4000 });
    buttonWithText(container, 'Soy Docente').click();
    await waitUntil(() => container.textContent.includes('¿Sos el docente de esta clase?'), { timeoutMs: 4000 });
    buttonWithText(container, 'Sí, soy el docente').click();

    const rejected = await waitUntil(
      () => container.textContent.includes('Ya hay un docente asignado para esta reunión.'),
      { timeoutMs: 4000 }
    );
    assert.ok(rejected, `Debería ver la pantalla de rechazo. Texto: ${container.textContent}`);

    buttonWithText(container, 'Unirme como alumno').click();

    const reachedName = await waitUntil(() => container.textContent.includes('¿Cómo te llamás?'), {
      timeoutMs: 4000,
    });
    assert.ok(
      reachedName,
      `"Unirme como alumno" debería llevar a la pantalla de nombre, no asignar el rol directo. Texto: ${container.textContent}`
    );

    const { role: roleBeforeConfirm } = await getRealRole(meetingCode, rejectedEmail);
    assert.equal(roleBeforeConfirm, null, 'Todavía no debería tener ningún rol asignado.');

    const input = container.querySelector('.sparkle-input');
    typeIntoInput(dom.window, input, 'Nicolás Paz');
    buttonWithText(container, 'Confirmar').click();

    const reachedStudent = await waitUntil(() => container.textContent.includes('La clase está detenida'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedStudent, `Debería llegar al panel de alumno tras confirmar. Texto final: ${container.textContent}`);

    const { role: finalRole, name: finalName } = await getRealRole(meetingCode, rejectedEmail);
    assert.equal(finalRole, 'student');
    assert.equal(finalName, 'Nicolás Paz');
  } finally {
    unmount();
    existingTeacherWs.close();
    await cleanupMeeting(meetingCode);
  }
});

// ─── Etapa 76 — bug real: "Volver" desde la pantalla de nombre, llegado vía rechazo, dejaba "role" en 'teacher' ───

test('"Volver" desde la pantalla de nombre (llegado vía rechazo de docente) NO deja volver a elegir "Soy Docente"', async () => {
  const meetingCode = newMeetingCode();
  const existingTeacherEmail = 'docente-existente-volver@test.com';
  const rejectedEmail = 'aspirante-a-docente-vuelve@test.com';

  // Reproduce el escenario reportado tal cual, con el mismo orden temporal:
  // AMBOS invitados ya están en Welcome (nadie registrado todavía) cuando
  // uno de ellos (acá simulado por la llamada REST de abajo, DESPUÉS del
  // mount) confirma el rol de docente -- exactamente la carrera de Capa 2
  // que ya cubre el test (e) de `App.welcomeYaHayDocente.test.js`. A
  // diferencia del test (d) de arriba (que simula "la otra persona" con un
  // cliente WS crudo, sin persistir nada), acá el docente existente se
  // registra por el mismo camino REST real que usaría `ConfirmTeacher.jsx`
  // -- un docente YA CONFIRMADO (persistido en la base), no solo ocupando
  // el lugar en memoria.
  const { container, unmount } = await mountRealApp({ meetingCode, email: rejectedEmail });

  try {
    await waitUntil(() => container.textContent.includes('Soy Docente'), { timeoutMs: 4000 });

    // La carrera: el otro invitado confirma como docente DESPUÉS de que
    // Welcome de esta persona ya cargó (y ya decidió mostrar "Soy
    // Docente"), pero ANTES de que esta persona llegue a clickearlo -- la
    // Capa 2 (chequeo fresco en `handleSelectRole`) lo detecta recién al
    // click, y manda DIRECTO a la pantalla de rechazo, sin mostrar el
    // diálogo de confirmación -- igual que en el reporte original.
    await registerRealRole(meetingCode, existingTeacherEmail, 'teacher');

    buttonWithText(container, 'Soy Docente').click();

    await waitUntil(() => container.textContent.includes('Ya hay un docente asignado para esta reunión.'), {
      timeoutMs: 4000,
    });
    buttonWithText(container, 'Unirme como alumno').click();

    await waitUntil(() => container.textContent.includes('¿Cómo te llamás?'), { timeoutMs: 4000 });

    // El bug real (Etapa 76): en vez de confirmar un nombre, esta persona se
    // arrepiente y presiona "Volver" -- antes del fix, `role` seguía en
    // 'teacher' (seteado por la Capa 2 de `handleSelectRole` para disparar
    // el rechazo por WS) y nunca se reseteaba, así que la app volvía a
    // mostrar el panel del DOCENTE ("Comenzar Clase"/"Cargar Archivo") en
    // vez de Welcome -- como si esta persona SÍ fuera la docente de la
    // reunión, pese a que ya hay otra persona confirmada en ese rol.
    buttonWithText(container, 'Volver').click();

    const backAtWelcome = await waitUntil(() => container.textContent.includes('Bienvenido a Sparkle V2'), {
      timeoutMs: 4000,
    });
    assert.ok(backAtWelcome, `"Volver" debería regresar a Welcome. Texto final: ${container.textContent}`);
    assert.ok(
      !container.textContent.includes('Comenzar Clase') && !container.textContent.includes('Cargar Archivo'),
      `NO debería mostrar el panel del docente. Texto final: ${container.textContent}`
    );

    // El punto central del fix: como la reunión YA tiene un docente
    // confirmado (Capa 2 ya dejó `hasTeacher = true`), Welcome debería
    // mostrar ÚNICAMENTE "Soy Alumno" -- sin posibilidad de volver a elegir
    // "Soy Docente".
    assert.ok(buttonWithText(container, 'Soy Alumno'), 'Debería seguir existiendo "Soy Alumno".');
    assert.ok(
      !buttonWithText(container, 'Soy Docente'),
      `"Soy Docente" NO debería reaparecer como opción. Texto final: ${container.textContent}`
    );

    // Y confirmado también contra la base: nunca quedó ningún rol asignado
    // para esta persona en esta reunión.
    const { role } = await getRealRole(meetingCode, rejectedEmail);
    assert.equal(role, null, 'No debería haber quedado ningún rol persistido tras "Volver".');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});
