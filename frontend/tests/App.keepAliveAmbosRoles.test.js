// Test de la Etapa 57 — el re-join periódico de la Etapa 52 (`setInterval`
// de 15s en `App.jsx`) estaba restringido a `rolBackend === 'teacher'`: el
// alumno nunca tuvo ningún mecanismo de keepalive. Esto importa porque,
// según la investigación de la Etapa 57 (ver DOCUMENTACION.md), CADA
// mensaje de `chrome.runtime` que recibe el service worker cuenta como
// actividad de la extensión y evita que Chrome lo suspenda por los ~30s de
// inactividad que tolera — sin ningún mensaje periódico, el service worker
// del lado del ALUMNO quedaba sin nada que lo mantuviera despierto.
//
// Este test monta el `App.jsx` REAL (mismo harness que
// `App.parpadeoYMensajes.test.js`) como ALUMNO y confirma, esperando el
// tiempo real que hace falta (no simulado), que el mensaje periódico de
// keepalive SÍ se dispara para ese rol — antes de este fix, jamás iba a
// aparecer un segundo `SPARKLE_WS_KEEP_ALIVE` (ni siquiera el primero,
// porque el mensaje ni existía).
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
  wait,
  cleanupTestBundles,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.after(async () => {
  await cleanupTestBundles();
});

test(
  'Etapa 57 — el keepalive periódico (cada 15s) corre también para el ALUMNO, no solo para el docente',
  async () => {
    const meetingCode = 'ppp-qqqq-rrr';
    const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
    addActiveCallSignals(dom.window.document, 'alumno@test.com');

    const messagesByType = {};
    installChromeMock(async (type) => {
      messagesByType[type] = (messagesByType[type] || 0) + 1;
      if (type === 'SPARKLE_GET_ROLE') return { role: 'student' };
      return { ok: true };
    });

    const bundlePath = await bundleAppForTest('src/App.jsx');
    const { mount, unmount } = require(bundlePath);

    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    mount(container);

    try {
      // El join inicial es inmediato (SPARKLE_WS_JOIN_ROOM); el tick
      // periódico de keepalive recién a los 15000ms — se espera un margen
      // por encima de eso para no depender de que el timer sea exacto al
      // milisegundo.
      await wait(16500);

      assert.equal(
        messagesByType['SPARKLE_WS_JOIN_ROOM'],
        1,
        'el join inicial debería haber ocurrido una sola vez'
      );
      assert.ok(
        (messagesByType['SPARKLE_WS_KEEP_ALIVE'] || 0) >= 1,
        `el keepalive periódico debería haberse disparado al menos una vez para el ALUMNO — mensajes recibidos: ${JSON.stringify(messagesByType)}`
      );
    } finally {
      unmount();
    }
  }
);
