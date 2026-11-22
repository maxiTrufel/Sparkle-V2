// Cambio pedido: el guard `firstWindow` de `useFatigueAlert.js` pasa de
// `totalPredictions < 2 * k` a `totalPredictions < k` -- la primera alerta
// ahora puede disparar apenas el buffer tiene `k` capturas, no recién con
// el doble. Se prueba contra el hook REAL (montado con `react-dom/client`
// sobre jsdom vía el harness de `tests/fixtures/fatigueAlertHarness.jsx`),
// no contra una reimplementación de la lógica -- así el test se rompe de
// verdad si el guard cambia sin que este archivo se actualice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  bundleAppForTest,
  installDom,
  waitUntil,
  cleanupTestBundles,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);

test.after(async () => {
  await cleanupTestBundles();
});

test('la alerta de fatiga dispara apenas el buffer llega a k lecturas (no recién en 2*k)', async () => {
  const dom = installDom({ url: 'https://meet.google.com/test-fatiga-primera-ventana' });
  const bundlePath = await bundleAppForTest('tests/fixtures/fatigueAlertHarness.jsx');
  const { mount, unmount } = require(bundlePath);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);

  // Nunca se cachea el objeto `__harness` en una variable: el componente
  // lo reasigna en CADA render, y cachearlo capturaría el `result` (y sus
  // setters) de un render viejo -- se relee `global.window.__harness`
  // fresco en cada llamada.
  const harness = () => global.window.__harness;

  try {
    mount(container);
    // `createRoot().render()` programa el primer commit de forma
    // asíncrona (no sincrónica como el `ReactDOM.render` legacy) -- sin
    // esto, `global.window.__harness` todavía es `undefined` justo después
    // de `mount()`.
    await waitUntil(() => harness() !== undefined);

    // Fixture: k=3, threshold=0.6, qThreshold=0.5, cameraActive=true desde
    // el montaje (sin transición false->true, así que el grace period de
    // 10s del hook nunca se activa y las lecturas se cuentan de una).
    harness().pushConcentration(0); // 0% concentración <= 60 => desatento
    await waitUntil(() => harness().getResult().inattentiveInWindow >= 1);
    harness().pushConcentration(0);
    await waitUntil(() => harness().getResult().inattentiveInWindow >= 2);
    harness().pushConcentration(0);
    await waitUntil(() => harness().getResult().inattentiveInWindow >= 3);

    // Con exactamente k=3 lecturas (todas desatentas, ratio=1 > qThreshold
    // 0.5) la alerta ya debería estar visible -- antes del cambio hacía
    // falta llegar a 2*k=6 para que `firstWindow` dejara de bloquearla.
    const disparoOk = await waitUntil(() => harness().getResult().alertVisible === true, { timeoutMs: 1500 });
    assert.equal(disparoOk, true, 'la alerta debería dispararse apenas el buffer llega a k lecturas');
    assert.equal(harness().getResult().inattentiveInWindow, 3);
  } finally {
    unmount();
  }
});
