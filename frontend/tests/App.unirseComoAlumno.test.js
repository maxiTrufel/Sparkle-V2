// Fix 3 — cuando el servidor rechaza a un "profesor" porque ya hay otro
// conectado a esta reunión (ver `backend/src/ws/index.js`), la pantalla de
// rechazo (`TeacherPanel.jsx`) ya no deja a esa persona sin ninguna acción
// posible: agrega un botón "Unirme como alumno" que la lleva a la pantalla
// de registro de nombre (`App.jsx`, `handleJoinAsStudent` →
// `StudentName.jsx`) — Etapa 68, Cambio 1: ya NO registra el rol "alumno"
// directo, ese único camino ahora pasa siempre por confirmar un nombre.
//
// Mismo patrón que `App.parpadeoYMensajes.test.js`: se monta el `App.jsx`
// REAL sobre un DOM de `jsdom`, con `chrome.runtime` mockeado a mano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleAppForTest,
  installDom,
  installChromeMock,
  addActiveCallSignals,
  waitUntil,
  cleanupTestBundles,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.after(async () => {
  await cleanupTestBundles();
});

test('Fix 3 — el docente rechazado por "ya hay un profesor" puede unirse como alumno desde esa misma pantalla', async () => {
  const meetingCode = 'ppp-qqqq-rrr';
  const email = 'docente-rechazado@test.com';
  const receivedMessages = [];

  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);

  const chromeMock = installChromeMock(async (type, payload) => {
    receivedMessages.push({ type, payload });

    if (type === 'SPARKLE_GET_ROLE') return { role: 'teacher' };

    if (type === 'SPARKLE_WS_JOIN_ROOM' && payload.role === 'teacher') {
      // El servidor rechaza este join: ya hay otro profesor en la sala.
      setTimeout(() => {
        chromeMock.emitFromBackground({
          type: 'SPARKLE_WS_EVENT',
          payload: { type: 'join_rejected', meetingCode, reason: 'teacher_exists' },
        });
      }, 20);
      return { ok: true };
    }

    if (type === 'SPARKLE_WS_JOIN_ROOM' && payload.role === 'student') {
      // El re-intento como alumno sí se acepta: no hay clase activa.
      setTimeout(() => {
        chromeMock.emitFromBackground({
          type: 'SPARKLE_WS_EVENT',
          payload: { type: 'class_status', meetingCode, active: false },
        });
      }, 20);
      return { ok: true };
    }

    // Etapa 68 — confirma cualquier nombre no vacío (`StudentName.jsx` ya
    // validó eso del lado del cliente antes de mandar el mensaje); acá solo
    // importa devolver la MISMA forma que `services/api.js` (`{ status, body }`).
    if (type === 'SPARKLE_REGISTER_STUDENT') {
      return { status: 200, body: { role: 'student', name: payload.name } };
    }

    return { ok: true };
  });

  const bundlePath = await bundleAppForTest('src/App.jsx');
  const { mount, unmount } = require(bundlePath);

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  mount(container);

  try {
    await waitUntil(() => container.textContent.includes('Ya hay un docente asignado para esta reunión.'), {
      timeoutMs: 3000,
    });

    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Unirme como alumno')
    );
    assert.ok(button, `Debería existir un botón "Unirme como alumno". Texto: ${container.textContent}`);

    button.click();

    // Etapa 68 — "Unirme como alumno" ya no asigna el rol de una: lleva a
    // la pantalla de registro de nombre, igual que "Soy Alumno" en Welcome.
    await waitUntil(() => container.textContent.includes('¿Cómo te llamás?'), { timeoutMs: 3000 });
    assert.ok(
      !container.textContent.includes('Ya hay un docente asignado para esta reunión.'),
      `No debería seguir mostrando la pantalla de rechazo. Texto: ${container.textContent}`
    );

    const input = container.querySelector('.sparkle-input');
    assert.ok(input, `Debería haber un campo de texto para el nombre. Texto: ${container.textContent}`);
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Alumno Rechazado');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    const confirmButton = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Confirmar'));
    assert.ok(confirmButton, `Debería existir el botón "Confirmar". Texto: ${container.textContent}`);
    confirmButton.click();

    await waitUntil(() => container.textContent.includes('La clase está detenida'), { timeoutMs: 3000 });

    const registration = receivedMessages.find((m) => m.type === 'SPARKLE_REGISTER_STUDENT');
    assert.ok(registration, 'Debería haber registrado el nombre (y con él, el rol "alumno") contra el backend.');
    assert.equal(registration.payload.name, 'Alumno Rechazado');

    // El cartel de clase detenida puede aparecer antes de que salga el pedido
    // de unirse como alumno; en una máquina rápida, mirar la lista en ese
    // mismo instante daba un falso negativo. Se espera a que llegue.
    const esReJoin = (m) => m.type === 'SPARKLE_WS_JOIN_ROOM' && m.payload.role === 'student';
    await waitUntil(() => receivedMessages.some(esReJoin), { timeoutMs: 3000 });
    const reJoin = receivedMessages.find(esReJoin);
    assert.ok(reJoin, 'Debería haber unido la sala con rol "alumno" recién después de confirmar el nombre.');
  } finally {
    unmount();
  }
});
