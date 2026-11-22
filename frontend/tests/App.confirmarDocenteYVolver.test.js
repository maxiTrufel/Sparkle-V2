// Etapa 69 — tests de integración REALES (backend Express + WS reales,
// base de datos real) de los tres cambios en el flujo de selección de rol:
// mismo patrón que `App.integracionBackendReal.test.js`/
// `App.registroNombreAlumno.test.js` (servidor real en un puerto efímero,
// `App.jsx` real montado sobre jsdom, sin atajos simulados en el camino
// REST/WS).
//
// Cubre:
//   (a) el diálogo de confirmación al elegir "Soy Docente" — cancelar no
//       asigna nada y vuelve a Welcome; confirmar sí asigna el rol;
//   (b) [Etapa 71] confirmar el rol de docente es DEFINITIVO — ya no existe
//       ningún link "Volver" en la vista idle de TeacherPanel ("Cargar
//       Archivo"), y no hay forma de liberar el rol una vez confirmado
//       (reemplaza al test viejo de esta letra, que probaba justo lo
//       contrario: un link "Volver" que SÍ liberaba el rol — ver más abajo
//       el comentario junto al test para el detalle completo);
//   (c) el botón "Volver" de la pantalla de registro de nombre no deja
//       ningún rol ni nombre registrado.
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

// Monta un `App.jsx` REAL contra el backend REAL (REST + WS) — mismo patrón
// que el resto de la suite.
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

function typeIntoInput(window, input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

// ─── (a) — diálogo de confirmación al elegir "Soy Docente" ───

test('Welcome → "Soy Docente" muestra el diálogo de confirmación; "Volver" cancela sin asignar rol; confirmar sí lo asigna', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-confirmacion@test.com';
  const { container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    await waitUntil(() => container.textContent.includes('Soy Docente'), { timeoutMs: 4000 });
    buttonWithText(container, 'Soy Docente').click();

    const reachedConfirm = await waitUntil(
      () => container.textContent.includes('¿Sos el docente de esta clase?'),
      { timeoutMs: 4000 }
    );
    assert.ok(reachedConfirm, `Debería mostrar el diálogo de confirmación. Texto: ${container.textContent}`);

    // El punto central: elegir "Soy Docente" todavía NO asignó nada.
    const { role: roleBeforeDeciding } = await getRealRole(meetingCode, email);
    assert.equal(roleBeforeDeciding, null, 'No debería haber ningún rol asignado mientras se muestra la confirmación.');

    // Cancela ("Volver") — debería volver a Welcome, sin asignar nada.
    buttonWithText(container, 'Volver').click();

    const backToWelcome = await waitUntil(
      () => container.textContent.includes('Bienvenido a Sparkle V2'),
      { timeoutMs: 4000 }
    );
    assert.ok(backToWelcome, `Cancelar debería volver a Welcome. Texto: ${container.textContent}`);

    const { role: roleAfterCancel } = await getRealRole(meetingCode, email);
    assert.equal(roleAfterCancel, null, 'Cancelar no debería haber asignado ningún rol.');

    // Vuelve a elegir "Soy Docente", esta vez confirma de verdad.
    buttonWithText(container, 'Soy Docente').click();
    await waitUntil(() => container.textContent.includes('¿Sos el docente de esta clase?'), { timeoutMs: 4000 });
    buttonWithText(container, 'Sí, soy el docente').click();

    const reachedStartClass = await waitUntil(() => container.textContent.includes('Comenzar Clase'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedStartClass, `Confirmar debería llevar al panel del docente. Texto: ${container.textContent}`);

    const { role: roleAfterConfirm } = await getRealRole(meetingCode, email);
    assert.equal(roleAfterConfirm, 'teacher', 'Confirmar sí debería haber asignado el rol de docente.');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── (b) — el rol de docente confirmado es DEFINITIVO (Etapa 71) ───
//
// Reemplaza al test viejo de esta letra ("'Volver' desde la vista de Cargar
// Archivo libera el rol de docente en la base, y otra persona puede
// tomarlo después"): esa era exactamente la funcionalidad que esta etapa
// ELIMINA a propósito. Ahora se prueba lo contrario — que ese link ya NO
// existe, y que NINGÚN camino de la UI puede revertir el rol una vez
// confirmado.
test('el rol de docente confirmado es DEFINITIVO: no hay ningún link "Volver" en Cargar Archivo, y nadie más puede tomar el lugar', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-definitivo@test.com';
  const intruderEmail = 'docente-que-no-puede-tomar-el-lugar@test.com';

  const { container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    await waitUntil(() => container.textContent.includes('Soy Docente'), { timeoutMs: 4000 });
    buttonWithText(container, 'Soy Docente').click();
    await waitUntil(() => container.textContent.includes('¿Sos el docente de esta clase?'), { timeoutMs: 4000 });
    buttonWithText(container, 'Sí, soy el docente').click();

    await waitUntil(() => container.textContent.includes('Comenzar Clase'), { timeoutMs: 4000 });

    const { role } = await getRealRole(meetingCode, email);
    assert.equal(role, 'teacher', 'Debería quedar registrado como docente al confirmar.');

    // El punto central: ya no hay NINGÚN botón/link "Volver" en esta vista.
    assert.ok(
      !buttonWithText(container, 'Volver'),
      `No debería existir ningún "Volver" en la vista de Cargar Archivo. Texto: ${container.textContent}`
    );

    // Sigue mostrando el panel normal, nunca vuelve a Welcome por su cuenta.
    assert.ok(container.textContent.includes('Comenzar Clase'));
    assert.ok(!container.textContent.includes('Bienvenido a Sparkle V2'));

    // Y el rol sigue firme en la base — nadie más puede tomar su lugar,
    // exactamente la misma restricción permanente de siempre (Etapa 61),
    // ahora sin ninguna forma de liberarlo desde la UI.
    const { status } = await registerRealRole(meetingCode, intruderEmail, 'teacher');
    assert.equal(status, 409, 'Nadie más debería poder registrarse como docente de esta reunión.');

    const { role: roleAfterAttempt } = await getRealRole(meetingCode, email);
    assert.equal(roleAfterAttempt, 'teacher', 'El rol original debería seguir intacto.');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── (c) — "Volver" desde la pantalla de nombre no deja rastro ───

test('"Volver" desde la pantalla de registro de nombre no deja ningún rol ni nombre registrado', async () => {
  const meetingCode = newMeetingCode();
  const email = 'alumno-que-vuelve@test.com';

  const { dom, container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    await waitUntil(() => container.textContent.includes('Soy Alumno'), { timeoutMs: 4000 });
    buttonWithText(container, 'Soy Alumno').click();

    await waitUntil(() => container.textContent.includes('¿Cómo te llamás?'), { timeoutMs: 4000 });

    // Tipea un nombre pero NO llega a confirmar -- exactamente el caso que
    // este botón tiene que cubrir (arrepentirse a mitad de camino).
    const input = container.querySelector('.sparkle-input');
    typeIntoInput(dom.window, input, 'Nombre Sin Confirmar');

    const backButton = buttonWithText(container, 'Volver');
    assert.ok(backButton, `Debería existir el botón "Volver" en la pantalla de nombre. Texto: ${container.textContent}`);
    backButton.click();

    const backToWelcome = await waitUntil(
      () => container.textContent.includes('Bienvenido a Sparkle V2'),
      { timeoutMs: 4000 }
    );
    assert.ok(backToWelcome, `"Volver" debería regresar a Welcome. Texto: ${container.textContent}`);

    const { role, name } = await getRealRole(meetingCode, email);
    assert.equal(role, null, 'No debería haber quedado ningún rol registrado.');
    assert.equal(name, null, 'No debería haber quedado ningún nombre registrado.');

    // Confirmado también directo contra la base (no solo por el endpoint):
    // no debería existir NINGUNA fila de `participations` para este email
    // en esta reunión.
    const [rows] = await pool.query(
      `SELECT p.id
       FROM participations p
       JOIN meetings r ON r.id = p.meeting_id
       JOIN users u ON u.id = p.user_id
       WHERE r.meeting_code = ? AND u.email = ?`,
      [meetingCode, email]
    );
    assert.equal(rows.length, 0, 'No debería haber quedado ninguna fila de participations para este email.');

    // Y el nombre tipeado ("Nombre Sin Confirmar") queda libre para
    // cualquier otro alumno de esta misma reunión -- no se "reservó" nada.
    const registration = await fetch(`${apiUrl}/api/meetings/register-student`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingCode, email: 'otro-alumno@test.com', name: 'Nombre Sin Confirmar' }),
    });
    assert.equal(registration.status, 200, 'El nombre tipeado y no confirmado no debería haber quedado reservado.');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── Regresión — bug real "primer ingreso como docente tras varios días
// sin usar la extensión" ───
//
// Reproduce la causa raíz exacta: el primer intento de `registerMeetingRole`
// falla (acá, simulado — en el caso real era una detección de email que
// llegaba tarde en una carga fría de Meet, ver `hooks/useInitialRoleResolution.js`).
// Antes de este fix, `ConfirmTeacher.jsx` tragaba ese error (best-effort) y
// abría igual el panel de docente con un rol NUNCA persistido — este test
// confirma que ahora: (1) el panel NO se abre mientras el registro no se
// confirme, (2) se muestra un error real (nunca silenciado) con un botón
// "Reintentar", y (3) reintentar con la MISMA identidad, una vez que el
// registro sí puede completarse, deja el rol correctamente persistido y
// recién ahí abre el panel — sin duplicar nada (`registerMeetingRole` es
// idempotente del lado del backend, ver `roleService.registerRole`).
test('si "registrar rol" falla, el panel de docente NO se abre y muestra "Reintentar" — reintentar sí lo persiste', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-primer-intento-falla@test.com';

  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);
  const bridge = createRealWsBridge({ wsUrl });

  let registerAttempts = 0;
  const chromeMock = installChromeMock(async (type, payload) => {
    if (type === 'SPARKLE_GET_ROLE') return getRealRole(payload.meetingCode, payload.email);
    if (type === 'SPARKLE_GET_HAS_TEACHER') return getRealHasTeacher(payload.meetingCode, payload.email);
    if (type === 'SPARKLE_REGISTER_ROLE') {
      registerAttempts += 1;
      if (registerAttempts === 1) {
        // Primer intento — simula exactamente lo que pasaba en la carga
        // fría real: el mensaje nunca llega a completarse del lado del
        // service worker (rechazo explícito acá, mismo efecto que un
        // `chrome.runtime.lastError`).
        throw new Error('Simulado: el service worker no respondió a tiempo (carga fría).');
      }
      const { body } = await registerRealRole(payload.meetingCode, payload.email, payload.role);
      return body;
    }
    const wsResult = await bridge.handleWsCommand(type, payload);
    if (wsResult !== undefined) return wsResult;
    return { ok: true };
  });
  bridge.setEmitter(chromeMock.emitFromBackground);

  const bundlePath = await bundleAppForTest('src/App.jsx');
  const { mount, unmount: unmountReact } = require(bundlePath);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  mount(container);
  const unmount = () => {
    unmountReact();
    bridge.close();
  };

  try {
    await waitUntil(() => container.textContent.includes('Soy Docente'), { timeoutMs: 4000 });
    buttonWithText(container, 'Soy Docente').click();
    await waitUntil(() => container.textContent.includes('¿Sos el docente de esta clase?'), { timeoutMs: 4000 });
    buttonWithText(container, 'Sí, soy el docente').click();

    // El punto central del fix: mientras el registro falla, el panel de
    // docente NUNCA se abre — se queda en esta misma pantalla, con un error
    // visible y un "Reintentar" (nunca un `alert()`, nunca silenciado).
    const showedError = await waitUntil(
      () => buttonWithText(container, 'Reintentar') && container.textContent.includes('No se pudo guardar tu rol'),
      { timeoutMs: 4000 }
    );
    assert.ok(showedError, `Debería mostrar el error y el botón "Reintentar". Texto: ${container.textContent}`);
    assert.ok(
      !container.textContent.includes('Comenzar Clase'),
      `El panel de docente NO debería haberse abierto mientras el rol no esté confirmado. Texto: ${container.textContent}`
    );

    const { role: roleAfterFailure } = await getRealRole(meetingCode, email);
    assert.equal(roleAfterFailure, null, 'El rol no debería haber quedado persistido tras el intento fallido.');

    // Reintenta — esta vez el mock deja pasar el registro real.
    buttonWithText(container, 'Reintentar').click();

    const reachedStartClass = await waitUntil(() => container.textContent.includes('Comenzar Clase'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedStartClass, `Reintentar debería abrir el panel del docente. Texto: ${container.textContent}`);
    assert.equal(registerAttempts, 2, 'Debería haber exactamente dos intentos de registro: el fallido y el reintento.');

    const { role: roleAfterRetry } = await getRealRole(meetingCode, email);
    assert.equal(roleAfterRetry, 'teacher', 'El reintento sí debería haber persistido el rol de docente.');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── Regresión — causa raíz EXACTA (no un mock genérico de "falla y
// listo"): reproduce la carga fría real de Meet ───
//
// A diferencia del test anterior (simula una falla de `registerMeetingRole`
// en abstracto), este reproduce el mecanismo EXACTO: el DOM arranca SIN el
// botón de cuenta de Google todavía (como una pestaña de Meet recién
// cargada, sin caché, tras varios días sin visitar el sitio) — el boot de
// `useInitialRoleResolution` agota sus reintentos (3s) sin encontrarlo, así
// que `email` queda en `null`. El botón de cuenta recién "aparece" en el DOM
// (Meet termina de renderizar) DESPUÉS de eso, mientras la persona ya está
// mirando Welcome/ConfirmTeacher — exactamente la ventana real del bug.
// `ensureEmail()` (el fix) tiene que encontrarlo en su intento bajo demanda,
// justo antes de registrar el rol, sin que la persona necesite recargar la
// página.
test('carga fría real de Meet: el botón de cuenta aparece TARDE — ensureEmail() lo encuentra igual, sin recargar', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-carga-fria@test.com';

  // DOM inicial SIN el botón de cuenta (a diferencia de `addActiveCallSignals`)
  // — solo lo mínimo para que `callStage.js` resuelva 'in-call'.
  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  const exitButton = dom.window.document.createElement('button');
  exitButton.setAttribute('aria-label', 'Leave call');
  dom.window.document.body.appendChild(exitButton);
  const filler = dom.window.document.createElement('div');
  filler.textContent =
    'Contenido de relleno para simular una página de Meet ya renderizada, con ' +
    'suficiente texto visible como para no disparar la ventana de gracia de ' +
    'callStage.js pensada para un DOM recién montado y todavía casi vacío.';
  dom.window.document.body.appendChild(filler);

  const bridge = createRealWsBridge({ wsUrl });
  const chromeMock = installChromeMock(async (type, payload) => {
    if (type === 'SPARKLE_GET_ROLE') return getRealRole(payload.meetingCode, payload.email);
    if (type === 'SPARKLE_GET_HAS_TEACHER') return getRealHasTeacher(payload.meetingCode, payload.email);
    if (type === 'SPARKLE_REGISTER_ROLE') {
      const { body } = await registerRealRole(payload.meetingCode, payload.email, payload.role);
      return body;
    }
    const wsResult = await bridge.handleWsCommand(type, payload);
    if (wsResult !== undefined) return wsResult;
    return { ok: true };
  });
  bridge.setEmitter(chromeMock.emitFromBackground);

  const bundlePath = await bundleAppForTest('src/App.jsx');
  const { mount, unmount: unmountReact } = require(bundlePath);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  mount(container);
  const unmount = () => {
    unmountReact();
    bridge.close();
  };

  try {
    // El boot agota sus reintentos (3s) sin encontrar el email — Welcome se
    // muestra igual (según `Welcome.jsx`, no depende de tener un email
    // resuelto), pero sin ningún rol resuelto por el backend.
    const reachedWelcome = await waitUntil(() => container.textContent.includes('Soy Docente'), {
      timeoutMs: 5000,
    });
    assert.ok(reachedWelcome, `Debería llegar a Welcome igual, sin email resuelto. Texto: ${container.textContent}`);

    buttonWithText(container, 'Soy Docente').click();
    await waitUntil(() => container.textContent.includes('¿Sos el docente de esta clase?'), { timeoutMs: 4000 });

    // Recién ACÁ "aparece" el botón de cuenta — Meet terminó de renderizar,
    // como en la carga real, mientras la persona ya estaba mirando el panel.
    const account = dom.window.document.createElement('div');
    account.setAttribute('aria-label', `Cuenta de Google: Test (${email})`);
    dom.window.document.body.appendChild(account);

    buttonWithText(container, 'Sí, soy el docente').click();

    const reachedStartClass = await waitUntil(() => container.textContent.includes('Comenzar Clase'), {
      timeoutMs: 4000,
    });
    assert.ok(
      reachedStartClass,
      `ensureEmail() debería haber encontrado el email recién aparecido y registrado el rol, sin recargar. Texto: ${container.textContent}`
    );

    const { role } = await getRealRole(meetingCode, email);
    assert.equal(role, 'teacher', 'El rol debería haber quedado persistido con el email detectado tarde.');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});
