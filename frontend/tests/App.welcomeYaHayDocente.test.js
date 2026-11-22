// Etapa 71 — tests de integración REALES (backend Express + WS reales, base
// de datos real) de las dos capas de protección que hacen a Welcome
// sensible a si la reunión YA tiene un docente asignado: mismo patrón que
// el resto de la suite (servidor real en un puerto efímero, `App.jsx` real
// montado sobre jsdom, sin atajos simulados en el camino REST/WS).
//
// Cubre:
//   (a) Welcome muestra AMBAS opciones cuando no hay ningún docente
//       registrado todavía;
//   (b) Welcome muestra SOLO "Soy Alumno" cuando ya hay un docente
//       permanente con OTRO email — Capa 1, preventiva;
//   (c) el docente original (mismo email ya registrado) sigue llegando
//       directo a su panel, sin pasar por Welcome en absoluto;
//   (d) mientras se resuelve si ya hay un docente, se ve el spinner —
//       "Soy Docente" nunca llega a aparecer ni por un instante para
//       después desaparecer (sin el parpadeo que ya se corrigió antes,
//       Etapa 53, para un problema análogo);
//   (e) Capa 2, defensiva: si el conflicto surge DESPUÉS de que Welcome ya
//       cargó (carrera — alguien más se registra como docente en el
//       ratito entre que Welcome apareció y que se hizo el click), el
//       click en "Soy Docente" va directo a la pantalla de rechazo, SIN
//       mostrar nunca el diálogo de confirmación;
//   (f) Capa 3 (Etapa 76), casi en tiempo real: si otra persona se
//       registra como docente MIENTRAS esta sigue mirando Welcome SIN
//       clickear nada, "Soy Docente" desaparece solo (polling), sin
//       necesitar ningún click para enterarse del conflicto.
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

async function registerRealRole(meetingCode, email, role) {
  const resp = await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role: role }),
  });
  return { status: resp.status, body: await resp.json() };
}

async function getRealHasTeacher(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/has-teacher?${params.toString()}`);
  return resp.json();
}

// Monta un `App.jsx` REAL contra el backend REAL (REST + WS) — mismo patrón
// que el resto de la suite, incluyendo el ruteo de `SPARKLE_GET_HAS_TEACHER`
// (el foco de este archivo) contra el endpoint real.
async function mountRealApp({ meetingCode, email }) {
  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);

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

// ─── (a) — sin ningún docente, Welcome muestra ambas opciones ───

test('Welcome muestra AMBAS opciones cuando no hay ningún docente registrado todavía', async () => {
  const meetingCode = newMeetingCode();
  const email = 'alumno-o-docente@test.com';

  const { container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    const reachedWelcome = await waitUntil(() => container.textContent.includes('Bienvenido a Sparkle V2'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedWelcome, `Debería mostrar Welcome. Texto: ${container.textContent}`);
    assert.ok(buttonWithText(container, 'Soy Docente'), 'Debería existir la tarjeta "Soy Docente".');
    assert.ok(buttonWithText(container, 'Soy Alumno'), 'Debería existir la tarjeta "Soy Alumno".');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── (b) — Capa 1, preventiva: ya hay un docente con otro email ───

test('Welcome muestra SOLO "Soy Alumno" cuando ya hay un docente permanente con OTRO email', async () => {
  const meetingCode = newMeetingCode();
  const teacherEmail = 'docente-ya-registrado@test.com';
  const newEmail = 'recien-llegado@test.com';

  await registerRealRole(meetingCode, teacherEmail, 'teacher');

  const { container, unmount } = await mountRealApp({ meetingCode, email: newEmail });

  try {
    const reachedWelcome = await waitUntil(() => container.textContent.includes('Bienvenido a Sparkle V2'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedWelcome, `Debería mostrar Welcome. Texto: ${container.textContent}`);
    assert.ok(buttonWithText(container, 'Soy Alumno'), 'Debería seguir existiendo "Soy Alumno".');
    assert.ok(
      !buttonWithText(container, 'Soy Docente'),
      `"Soy Docente" NO debería renderizarse en absoluto. Texto: ${container.textContent}`
    );
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── (c) — el docente original sigue entrando directo a su panel ───

test('el docente original (mismo email ya registrado) llega directo a su panel, sin pasar por Welcome', async () => {
  const meetingCode = newMeetingCode();
  const email = 'docente-original@test.com';
  await registerRealRole(meetingCode, email, 'teacher');

  const { container, unmount } = await mountRealApp({ meetingCode, email });

  try {
    // Se registra CADA mutación del DOM para no perderse un parpadeo de
    // Welcome aunque sea de un solo tick -- mismo patrón que ya usaba el
    // test del chip en `App.integracionBackendReal.test.js` (Etapa 61).
    const observedTexts = [];
    const observer = new global.MutationObserver(() => observedTexts.push(container.textContent));
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    const reachedStartClass = await waitUntil(() => container.textContent.includes('Comenzar Clase'), {
      timeoutMs: 4000,
    });
    observer.disconnect();

    assert.ok(reachedStartClass, `Debería llegar directo a su panel. Texto: ${container.textContent}`);
    assert.ok(
      !observedTexts.some((text) => text.includes('Bienvenido a Sparkle V2')),
      'Nunca debería haber pasado por Welcome, ni siquiera brevemente.'
    );
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── (d) — sin parpadeo mientras se resuelve "¿ya hay un docente?" ───

test('mientras se resuelve si ya hay un docente, se ve el spinner — "Soy Docente" nunca aparece para después desaparecer', async () => {
  const meetingCode = newMeetingCode();
  const teacherEmail = 'docente-para-parpadeo@test.com';
  const newEmail = 'nuevo-para-parpadeo@test.com';

  await registerRealRole(meetingCode, teacherEmail, 'teacher');

  const { container, unmount } = await mountRealApp({ meetingCode, email: newEmail });

  try {
    const observedTexts = [container.textContent];
    const observer = new global.MutationObserver(() => observedTexts.push(container.textContent));
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    const reachedWelcome = await waitUntil(() => container.textContent.includes('Bienvenido a Sparkle V2'), {
      timeoutMs: 4000,
    });
    observer.disconnect();

    assert.ok(reachedWelcome, `Debería asentarse en Welcome. Texto: ${container.textContent}`);
    assert.ok(
      !observedTexts.some((text) => text.includes('Soy Docente')),
      `"Soy Docente" no debería haber aparecido en NINGÚN momento. Snapshots: ${JSON.stringify(observedTexts)}`
    );
    // Confirma que hubo genuinamente un estado de carga antes de asentarse
    // (si nunca se vio "Cargando…", sería porque la consulta resolvió
    // sincrónicamente y el test no estaría probando nada real).
    assert.ok(
      observedTexts.some((text) => text.includes('Cargando')),
      'Debería haberse visto el spinner de carga en algún momento del boot.'
    );
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── (e) — Capa 2, defensiva: carrera detectada recién al click ───

function chipText(container) {
  const chip = container.querySelector('.sparkle-role-badge');
  return chip ? chip.textContent : null;
}

test('Capa 2 (defensiva) — si el conflicto surge DESPUÉS de cargar Welcome, el click en "Soy Docente" va directo al rechazo, sin mostrar el diálogo', async () => {
  const meetingCode = newMeetingCode();
  const earlyEmail = 'docente-que-se-adelanta@test.com';
  const clickingEmail = 'docente-que-llega-tarde@test.com';

  // Reunión BRAND NEW: nadie registrado todavía cuando este panel monta.
  const { container, unmount } = await mountRealApp({ meetingCode, email: clickingEmail });

  try {
    const reachedWelcome = await waitUntil(() => container.textContent.includes('Bienvenido a Sparkle V2'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedWelcome, `Debería mostrar Welcome. Texto: ${container.textContent}`);
    assert.ok(
      buttonWithText(container, 'Soy Docente'),
      `"Soy Docente" debería estar visible -- todavía no hay conflicto. Texto: ${container.textContent}`
    );

    // La carrera: otra persona se registra como docente DESPUÉS de que
    // Welcome ya cargó (y ya decidió mostrar "Soy Docente"), pero ANTES de
    // que este usuario llegue a clickearlo.
    const { status: earlyStatus } = await registerRealRole(meetingCode, earlyEmail, 'teacher');
    assert.equal(earlyStatus, 200);

    // Se registra CADA mutación para confirmar que el diálogo de
    // confirmación NUNCA llega a aparecer, ni el chip a mostrar "Docente".
    const observedTexts = [];
    const observedChips = [chipText(container)];
    const observer = new global.MutationObserver(() => {
      observedTexts.push(container.textContent);
      observedChips.push(chipText(container));
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    buttonWithText(container, 'Soy Docente').click();

    const rejected = await waitUntil(
      () => container.textContent.includes('Ya hay un docente asignado para esta reunión.'),
      { timeoutMs: 4000 }
    );
    observer.disconnect();

    assert.ok(
      rejected,
      `Debería ir directo a la pantalla de rechazo. Texto final: ${container.textContent}`
    );
    assert.ok(
      !observedTexts.some((text) => text.includes('¿Sos el docente de esta clase?')),
      `El diálogo de confirmación NUNCA debería haber aparecido. Snapshots: ${JSON.stringify(observedTexts)}`
    );
    assert.ok(
      !observedChips.some((text) => text === 'Docente'),
      `El chip NUNCA debería haber mostrado "Docente". Snapshots: ${JSON.stringify(observedChips)}`
    );

    // Y confirmado también contra la base: quien clickeó nunca quedó
    // registrado como profesor.
    const params = new URLSearchParams({ meetingCode, email: clickingEmail });
    const resp = await fetch(`${apiUrl}/api/meetings/role?${params.toString()}`);
    const { role } = await resp.json();
    assert.equal(role, null, 'Quien fue rechazado por la Capa 2 no debería tener ningún rol persistido.');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── (f) — Capa 3 (Etapa 76), polling: sin necesitar ningún click ───

test('Capa 3 (polling) — "Soy Docente" desaparece solo si otra persona confirma el rol mientras esta sigue mirando Welcome', async () => {
  const meetingCode = newMeetingCode();
  const idleEmail = 'invitado-que-no-clickea@test.com';
  const laterTeacherEmail = 'docente-que-confirma-despues@test.com';

  // Reunión BRAND NEW: nadie registrado todavía cuando este panel monta.
  const { container, unmount } = await mountRealApp({ meetingCode, email: idleEmail });

  try {
    const reachedWelcome = await waitUntil(() => container.textContent.includes('Bienvenido a Sparkle V2'), {
      timeoutMs: 4000,
    });
    assert.ok(reachedWelcome, `Debería mostrar Welcome. Texto: ${container.textContent}`);
    assert.ok(
      buttonWithText(container, 'Soy Docente'),
      `"Soy Docente" debería estar visible -- todavía no hay conflicto. Texto: ${container.textContent}`
    );

    // Otra persona confirma el rol de docente MIENTRAS este invitado sigue
    // mirando Welcome, sin haber clickeado nada todavía -- a diferencia del
    // test de Capa 2 de arriba, acá NUNCA se hace click en "Soy Docente": el
    // único mecanismo que puede enterarse de este cambio es el polling de
    // Capa 3 (`useInitialRoleResolution.js`, `HAS_TEACHER_POLL_MS`).
    const { status } = await registerRealRole(meetingCode, laterTeacherEmail, 'teacher');
    assert.equal(status, 200);

    const teacherOptionGone = await waitUntil(() => !buttonWithText(container, 'Soy Docente'), {
      timeoutMs: 9000,
    });
    assert.ok(
      teacherOptionGone,
      `"Soy Docente" debería desaparecer solo, sin ningún click. Texto final: ${container.textContent}`
    );
    assert.ok(buttonWithText(container, 'Soy Alumno'), 'Debería seguir existiendo "Soy Alumno".');
  } finally {
    unmount();
    await cleanupMeeting(meetingCode);
  }
});
