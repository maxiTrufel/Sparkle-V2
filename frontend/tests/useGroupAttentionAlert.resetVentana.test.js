// Cambio pedido: en `useGroupAttentionAlert.js`, un cambio de
// `windowSecondsTeacher` a mitad de sesión tiene que resetear
// `observationStartRef` a `null` -- sin esto, achicar la ventana podía
// dejar el reloj apuntando a un inicio viejo cuyo tiempo YA transcurrido
// alcanza para "completar" la ventana nueva de inmediato, disparando la
// alerta con tiempo acumulado de ANTES del cambio. Se prueba contra el
// hook REAL, montado sobre jsdom con el harness de
// `tests/fixtures/groupAttentionAlertHarness.jsx`.
//
// Se mantiene un "heartbeat" de snapshots de roster durante todo el test
// (en vez de un único push) a propósito: con un solo snapshot, la entrada
// que arranca la observación y la que sobrevive al podado de la ventana
// nueva son la MISMA -- no hay forma de separar "el reloj viejo ya
// cumplió la ventana nueva" de "la entrada vieja se podó sola". Con pushes
// seguidos cada 150ms (bien por debajo de cualquier ventana usada acá), el
// buffer nunca queda vacío por el podado, así que el único camino que
// puede resetear `observationStartRef` es el cambio de `windowSecondsTeacher`
// en sí -- exactamente lo que este test quiere aislar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  bundleAppForTest,
  installDom,
  wait,
  waitUntil,
  cleanupTestBundles,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);

test.after(async () => {
  await cleanupTestBundles();
});

async function heartbeat(harness, times, intervalMs) {
  for (let i = 0; i < times; i += 1) {
    harness().pushRoster(1, 1); // 1 de 1 alumno desatento -> ratio de grupo = 1
    // eslint-disable-next-line no-await-in-loop
    await wait(intervalMs);
  }
}

test('el reloj de la ventana grupal se reinicia al cambiar windowSecondsTeacher, sin disparar con tiempo acumulado viejo', async () => {
  const dom = installDom({ url: 'https://meet.google.com/test-grupo-reset-ventana' });
  const bundlePath = await bundleAppForTest('tests/fixtures/groupAttentionAlertHarness.jsx');
  const { mount, unmount } = require(bundlePath);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);

  // Nunca se cachea el objeto `__harness`: el componente lo reasigna en
  // CADA render, y cachearlo capturaría el `result` de un render viejo.
  const harness = () => global.window.__harness;

  try {
    mount(container);
    // `createRoot().render()` programa el primer commit de forma
    // asíncrona -- sin esto, `harness()` todavía es `undefined` justo
    // después de `mount()`.
    await waitUntil(() => harness() !== undefined);

    // Ventana inicial larga (5s): qThresholdTeacher=0.5/pThreshold=0.5 del
    // fixture ya se cumplen de sobra (ratio=1), pero la ventana de 5s ni
    // arrancó a completarse en los ~600ms de acá abajo.
    harness().setConfig({ windowSecondsTeacher: 5 });
    await wait(20);

    await heartbeat(harness, 4, 150); // t ~ 0, 150, 300, 450 -> termina en t~600
    assert.equal(
      harness().getResult().alertVisible,
      false,
      'con la ventana de 5s todavía no debería haber disparado'
    );

    // Cambio a mitad de sesión hacia una ventana MÁS CORTA (500ms) que el
    // tiempo ya transcurrido desde el inicio de observación (~600ms) --
    // sin el reset, el reloj viejo ya "cumple" la ventana nueva de
    // inmediato.
    harness().setConfig({ windowSecondsTeacher: 0.5 });
    await wait(50);
    assert.equal(
      harness().getResult().alertVisible,
      false,
      'el cambio de ventana no debería disparar la alerta instantáneamente con tiempo acumulado de antes del cambio'
    );

    // La ventana nueva sigue funcionando de verdad: con el heartbeat
    // sosteniendo el buffer no vacío, el reloj reiniciado termina
    // completando la ventana de 500ms y disparando la alerta -- solo que
    // ahora contado desde CERO, no desde el inicio viejo.
    await heartbeat(harness, 10, 150); // ~1500ms más, de sobra para un tick del evaluador (1s) tras el reinicio
    const disparoOk = await waitUntil(() => harness().getResult().alertVisible === true, { timeoutMs: 1500 });
    assert.equal(disparoOk, true, 'la ventana nueva debería completarse y disparar la alerta con el reloj reiniciado');
  } finally {
    unmount();
  }
});
