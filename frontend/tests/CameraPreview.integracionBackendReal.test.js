// Etapa 64 — investigación del bug reportado: "activo el switch de cámara,
// recarco la página (F5), y la preferencia no se recuerda". Antes de
// aplicar cualquier fix, se confirmó la causa real con logs contra el
// backend real (no una suposición a ciegas):
//
//   - `POST /api/meetings/camera` y `GET /api/meetings/camera` (Etapa 63,
//     `backend/src/routes/meetings.js`) están bien escritos, PERO la
//     columna que tocan (`participations.camera_enabled`, agregada al
//     SCRIPT `backend/scripts/init-db.js` en la Etapa 63) nunca se había
//     vuelto a aplicar contra la base de datos de desarrollo real -- la
//     columna no existía. Confirmado a mano, contra el pool real: un
//     `UPDATE`/`SELECT` directo sobre `p.camera_enabled` fallaba con
//     "Unknown column 'p.camera_enabled' in 'field list'".
//   - Ese error quedaba INVISIBLE del lado del frontend: tanto
//     `handleToggle` (guardar) como la consulta inicial (leer) son
//     best-effort (`.catch(() => {})`, mismo criterio que el resto de la
//     persistencia de esta app) -- un 500 del backend nunca llegaba a
//     verse, y el estado por defecto (`enabled = false`) es indistinguible
//     de "nunca se guardó nada".
//   - El fix real fue una migración aditiva contra la base (`ALTER TABLE
//     participations ADD COLUMN camera_enabled ...`, no destructiva) --
//     no hizo falta tocar la lógica de `useCameraPreference` ni de las
//     rutas, que ya estaban bien. Sí se sumó logging (`console.log`) en
//     los `catch` que antes tragaban el error del todo, para que la
//     próxima vez algo así falle de forma visible en vez de muda.
//
// Este test reproduce el flujo COMPLETO extremo a extremo contra un backend
// real (mismo patrón que `App.integracionBackendReal.test.js`: Express +
// pool real, MISMO proceso, sin ningún atajo simulado para el REST de
// cámara) para blindar la regresión: activar el switch -> desmontar
// `App.jsx` (simula el F5, misma limpieza que un reload real destruyendo el
// realm de JS) -> montar una instancia NUEVA con el mismo meetingCode+email
// -> confirmar que el switch arranca ya activado, sin que el usuario tenga
// que volver a tocarlo.
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
    body: JSON.stringify({ meetingCode, email, role: role }),
  });
  return { status: resp.status, body: await resp.json() };
}

async function getRealCamera(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const resp = await fetch(`${apiUrl}/api/meetings/camera?${params.toString()}`);
  return resp.json();
}

async function updateRealCamera(meetingCode, email, enabled) {
  const resp = await fetch(`${apiUrl}/api/meetings/camera`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, enabled: enabled }),
  });
  return { status: resp.status, body: await resp.json() };
}

async function cleanupMeeting(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

// Monta un `App.jsx` REAL, conectado por REST y WS al backend real de este
// archivo (mismo patrón que `mountRealApp` en
// `App.integracionBackendReal.test.js`) -- pero acá el chromeMock también
// resuelve `SPARKLE_GET_CAMERA`/`SPARKLE_UPDATE_CAMERA` contra el endpoint
// REST real de cámara, sin ningún atajo simulado: exactamente el mismo
// camino que recorre `background/main.js` en producción.
// `mockCamera` (Etapa 65, Ajuste 1): `jsdom` no implementa
// `navigator.mediaDevices` en absoluto -- sin este mock, cualquier test que
// llegue a `active=true` en `useCameraPreference` (switch + clase activa +
// en-llamada) reventaría al llamar a `getUserMedia`. El mock devuelve un
// stream FALSO con un track cuyo `stop()` es espiable, para poder confirmar
// (Ajuste 1) que salir de la llamada corta la cámara DE VERDAD, no solo
// visualmente -- cada `MediaStream` creado se registra en `createdStreams`,
// devuelto en la sesión, para que el test pueda inspeccionar todos los
// intentos (incluida una eventual reconexión).
async function mountRealApp({ meetingCode, email, mockCamera = false }) {
  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);

  const createdStreams = [];
  if (mockCamera) {
    dom.window.navigator.mediaDevices = {
      getUserMedia: async () => {
        const track = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
        const stream = { getTracks: () => [track] };
        createdStreams.push(stream);
        return stream;
      },
    };
  }

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
    if (type === 'SPARKLE_GET_CAMERA') {
      return getRealCamera(payload.meetingCode, payload.email);
    }
    if (type === 'SPARKLE_UPDATE_CAMERA') {
      const { body } = await updateRealCamera(payload.meetingCode, payload.email, payload.enabled);
      return body;
    }
    const wsResult = await bridge.handleWsCommand(type, payload);
    if (wsResult !== undefined) return wsResult;
    return { ok: true };
  });

  // Se registran los eventos WS reenviados (además de dejarlos seguir su
  // camino normal hacia `App.jsx`) para poder esperar a que el servidor
  // haya terminado de procesar el "join" antes de desmontar -- sin esto, un
  // `unmount()`/`bridge.close()` demasiado temprano puede cerrar el socket
  // mientras el "join" todavía está en vuelo del lado del servidor (efecto
  // colateral inofensivo pero ruidoso: un `pool.query` que corre después de
  // que `test.after()` ya cerró el pool, si este es el último test del
  // archivo).
  const observedEvents = [];
  bridge.setEmitter((message) => {
    observedEvents.push(message);
    chromeMock.emitFromBackground(message);
  });

  const bundlePath = await bundleAppForTest('src/App.jsx');
  const { mount, unmount } = require(bundlePath);

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  mount(container);

  return {
    container,
    document: dom.window.document,
    createdStreams,
    waitForJoinConfirmed: () =>
      waitUntil(() => observedEvents.some((m) => m.payload?.type === 'class_status'), { timeoutMs: 3000 }),
    unmount: () => {
      unmount();
      bridge.close();
    },
  };
}

function cameraSwitch(container) {
  return container.querySelector('.sparkle-camera-switch-input');
}

// Cliente WS crudo (Node WebSocket nativo) para representar al DOCENTE que
// inicia la clase -- mismo patrón que `openWsClient` en
// `App.integracionBackendReal.test.js`, pero acá alcanza con dejarlo
// conectado y arrancar la clase (no hace falta leer sus mensajes). Se deja
// la conexión ABIERTA (no se cierra hasta el final del test) a propósito:
// si el docente se desconecta, el servidor finaliza la clase automáticamente
// (Etapa 50) y `classStarted` volvería a `false` del lado del alumno --
// justo la variable que este test necesita mantener en `true` para poder
// aislar el efecto de `callStage` (Ajuste 1 de la Etapa 65).
async function startClassAsTeacher(meetingCode) {
  const teacherEmail = 'docente-camara@test.com';
  // Requisito de producto — "start_class" exige un documento cargado para
  // la reunión (ver `backend/src/ws/handlers.js#handleStartClass`), y
  // subirlo por REST exige que el rol "teacher" ya esté persistido (mismo
  // chequeo de autorización que usa el endpoint real). Ninguno de los dos
  // pasos existía antes acá porque el "join" crudo alcanzaba, por sí solo,
  // para que el servidor aceptara "start_class" -- ya no.
  await registerRealRole(meetingCode, teacherEmail, 'teacher');
  await uploadRealDocument(apiUrl, meetingCode, teacherEmail, { pool });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.send(JSON.stringify({ type: 'join', meetingCode, role: 'teacher', email: teacherEmail }));
  await wait(150); // le da tiempo al servidor a procesar el "join" antes de iniciar
  ws.send(JSON.stringify({ type: 'start_class', meetingCode }));
  await wait(150);
  return ws;
}

// Simula, vía mutaciones REALES del DOM (no un atajo que fuerce `callStage`
// a mano), la transición que `callStage.js` reconoce como "salió de la
// llamada": saca el botón de "salir" (aria-label) -- sin él, `hasExitButton`
// pasa a `false` -- y agrega un texto que matchea el combo de "reunión
// terminada" (Nivel B: verbo "left" + sustantivo "meeting" a menos de 60
// caracteres, ver `MEETING_ENDED_ORDER2_REGEX` en `callStage.js`). El
// `MutationObserver` real de `watchCallStage()` (debounce de 300ms) es quien
// termina de resolver la reevaluación -- por eso el test espera un margen
// por encima de ese debounce después de llamar a esta función.
function simulateCallExit(document) {
  const button = [...document.querySelectorAll('[aria-label]')].find((el) =>
    /leave call/i.test(el.getAttribute('aria-label') || '')
  );
  button?.remove();
  const notice = document.createElement('div');
  notice.id = 'sparkle-test-exit-notice';
  notice.textContent = 'You have left the meeting.';
  document.body.appendChild(notice);
}

// Inverso de la de arriba: repone el botón de "salir" (alcanza por sí solo
// para que `detectCallStage()` vuelva a resolver 'in-call', sin importar
// si queda algún rastro del texto de "salida" -- ver el fix de prioridad de
// la Etapa 36 documentado en `callStage.js`) y saca el aviso de salida.
function simulateBackInCall(document) {
  document.getElementById('sparkle-test-exit-notice')?.remove();
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Leave call');
  document.body.appendChild(button);
}

test('Etapa 64 (integración real) — la preferencia del switch de cámara sobrevive a un remount completo (F5)', async () => {
  const meetingCode = newMeetingCode();
  const email = 'alumno-camara@test.com';

  // Se registra como alumno de antemano (equivalente a haber elegido "Soy
  // Alumno" en una sesión anterior) para que `App.jsx` resuelva
  // `role='student'` de una, sin pasar por Welcome.
  await registerRealRole(meetingCode, email, 'student');

  let session = await mountRealApp({ meetingCode, email });
  try {
    // El switch vive en el Header, visible sin importar el estado de la
    // clase (Etapa 64) -- no hace falta ninguna clase activa para este
    // flujo.
    const switchAppeared = await waitUntil(() => cameraSwitch(session.container) !== null, { timeoutMs: 3000 });
    assert.ok(switchAppeared, 'El switch de cámara debería aparecer en el Header para un alumno.');

    const initialInput = cameraSwitch(session.container);
    assert.equal(initialInput.checked, false, 'Sin preferencia guardada, el switch debe arrancar desactivado.');

    // Togglea (equivalente a un click real del usuario) y espera a que el
    // POST real termine de persistir -- confirmado consultando el backend
    // DIRECTO (sin pasar por App.jsx), no solo el estado local de React.
    initialInput.click();
    const persistedInBackend = await waitUntil(
      async () => {
        const { enabled } = await getRealCamera(meetingCode, email);
        return enabled === true;
      },
      { timeoutMs: 3000 }
    );
    assert.ok(persistedInBackend, 'POST /api/meetings/camera debería haber persistido enabled=true.');
    await session.waitForJoinConfirmed();
  } finally {
    session.unmount();
  }

  // Simula el F5: destruye el árbol de React y el realm de jsdom anterior
  // por completo, y monta una instancia CONCEPTUALMENTE NUEVA (mismo
  // patrón que un reload real: nada de estado de JS sobrevive, todo se
  // vuelve a resolver desde cero contra el backend).
  session = await mountRealApp({ meetingCode, email });
  try {
    const switchAppeared = await waitUntil(() => cameraSwitch(session.container) !== null, { timeoutMs: 3000 });
    assert.ok(switchAppeared, 'El switch debería volver a aparecer tras el remount.');

    // No alcanza con esperar a que el switch EXISTA en el DOM -- la consulta
    // de preferencia (`useCameraPreference`) es asíncrona, así que arranca
    // en `false` y recién se actualiza cuando responde el GET real. Hay que
    // esperar a que el estado consultado (`checked`) refleje lo guardado.
    const reflectsStored = await waitUntil(() => cameraSwitch(session.container)?.checked === true, {
      timeoutMs: 3000,
    });
    assert.ok(
      reflectsStored,
      `El switch debería arrancar activado tras el remount (preferencia guardada). ` +
        `checked=${cameraSwitch(session.container)?.checked}`
    );
    await session.waitForJoinConfirmed();
  } finally {
    session.unmount();
    await cleanupMeeting(meetingCode);
  }
});

test('Etapa 64 (integración real) — sin preferencia guardada, el switch arranca desactivado', async () => {
  const meetingCode = newMeetingCode();
  const email = 'alumno-sin-preferencia@test.com';

  await registerRealRole(meetingCode, email, 'student');

  const session = await mountRealApp({ meetingCode, email });
  try {
    const switchAppeared = await waitUntil(() => cameraSwitch(session.container) !== null, { timeoutMs: 3000 });
    assert.ok(switchAppeared);
    assert.equal(cameraSwitch(session.container).checked, false);
    await session.waitForJoinConfirmed();
  } finally {
    session.unmount();
    await cleanupMeeting(meetingCode);
  }
});

// ─── Ajuste 1 (Etapa 65) — el preview se apaga solo al salir de la llamada ───

test('Etapa 65 (integración real) — el preview y la cámara real se apagan solos al salir de la llamada, y se reactivan solos al volver', async () => {
  const meetingCode = newMeetingCode();
  const email = 'alumno-sale-de-llamada@test.com';

  await registerRealRole(meetingCode, email, 'student');
  const teacherWs = await startClassAsTeacher(meetingCode);

  const session = await mountRealApp({ meetingCode, email, mockCamera: true });
  try {
    // 1) Activa el switch con la clase YA iniciada y en-llamada -- el
    // preview debe encenderse (getUserMedia real -- mockeado -- llamado).
    const switchAppeared = await waitUntil(() => cameraSwitch(session.container) !== null, { timeoutMs: 3000 });
    assert.ok(switchAppeared);
    cameraSwitch(session.container).click();

    const previewOn = await waitUntil(() => session.container.querySelector('.sparkle-camera-video') !== null, {
      timeoutMs: 3000,
    });
    assert.ok(previewOn, 'El preview debería aparecer con switch activado + clase activa + en-llamada.');

    // Que el <video> esté en el DOM NO implica que `getUserMedia` ya haya
    // resuelto: el componente monta el elemento primero y pide la cámara
    // después, así que entre las dos cosas hay al menos un tick. Esperar el
    // DOM y después afirmar sobre `createdStreams` en la misma vuelta es una
    // carrera — pasa en una máquina rápida y falla en un runner de CI, que
    // fue exactamente lo que pasó en la primera corrida del workflow.
    const streamCreado = await waitUntil(() => session.createdStreams.length === 1, { timeoutMs: 3000 });
    assert.ok(streamCreado, 'getUserMedia debería haberse llamado una vez.');
    assert.equal(session.createdStreams[0].getTracks()[0].stopped, false);

    // 2) Sale de la llamada (mutación REAL del DOM, ver `simulateCallExit`)
    // -- el MutationObserver de `watchCallStage` tiene un debounce de 300ms,
    // así que se espera bastante más que eso.
    simulateCallExit(session.document);
    const previewOff = await waitUntil(
      () => session.container.querySelector('.sparkle-camera-video') === null,
      { timeoutMs: 3000 }
    );
    assert.ok(previewOff, 'El preview debería desaparecer al salir de la llamada (callStage !== "in-call").');

    // Misma carrera que arriba, al revés: el elemento se va del DOM en el
    // render, y `track.stop()` corre en la limpieza del efecto.
    const trackCortado = await waitUntil(
      () => session.createdStreams[0].getTracks()[0].stopped === true,
      { timeoutMs: 3000 }
    );
    assert.ok(
      trackCortado,
      'El track de la cámara debería haberse detenido de verdad (track.stop()), no solo ocultado visualmente.'
    );

    // El switch en sí sigue reflejando la preferencia (no se tocó) --
    // solo se cortó el acceso real a la cámara.
    assert.equal(cameraSwitch(session.container).checked, true, 'El switch debe seguir "activado" (la preferencia no cambia).');

    // 3) Vuelve a estar en-llamada (reconexión a la misma reunión) -- con el
    // switch todavía activado y la clase todavía activa, el preview debe
    // reaparecer SOLO, sin que el alumno toque nada.
    simulateBackInCall(session.document);
    const previewBack = await waitUntil(
      () => session.container.querySelector('.sparkle-camera-video') !== null,
      { timeoutMs: 3000 }
    );
    assert.ok(previewBack, 'El preview debería reaparecer solo al volver a estar en-llamada.');

    const segundoStream = await waitUntil(() => session.createdStreams.length === 2, { timeoutMs: 3000 });
    assert.ok(segundoStream, 'getUserMedia debería haberse vuelto a llamar (stream nuevo).');
    assert.equal(session.createdStreams[1].getTracks()[0].stopped, false);

    await session.waitForJoinConfirmed();
  } finally {
    session.unmount();
    teacherWs.close();
    await cleanupMeeting(meetingCode);
  }
});
