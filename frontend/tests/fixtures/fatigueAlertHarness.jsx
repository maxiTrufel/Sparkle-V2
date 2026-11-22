// Harness mínimo para ejercitar `useFatigueAlert` de forma aislada (sin
// montar `App.jsx` entero) — expone `window.__harness` con lo necesario
// para empujar lecturas de concentración y leer el resultado del hook
// desde el test. Mismo patrón de bundling que `tests/helpers/reactHarness.js`
// ya usa para `App.jsx` (esbuild + jsdom), solo que acá el "componente"
// bajo prueba es este wrapper en vez de la app real.
import { useState } from 'react';
import { useFatigueAlert } from '../../src/hooks/useFatigueAlert.js';

let seq = 0;

export default function FatigueAlertHarness() {
  const [attention, setAttention] = useState({ phase: 'idle', concentration: null, lastUpdated: 0 });
  const [config, setConfig] = useState({
    threshold: 0.6,
    k: 3,
    qThreshold: 0.5,
    cooldownSeconds: 90,
    classStarted: true,
    cameraActive: true,
  });

  const result = useFatigueAlert(attention, config);

  // `lastUpdated` tiene que cambiar en CADA push (el hook ignora una
  // lectura si coincide con la última procesada) -- un contador propio,
  // no `Date.now()`, evita colisiones entre llamadas rápidas seguidas.
  window.__harness = {
    pushConcentration(value) {
      seq += 1;
      setAttention({ phase: 'active', concentration: value, lastUpdated: seq });
    },
    setConfig(partial) {
      setConfig((prev) => ({ ...prev, ...partial }));
    },
    getResult() {
      return result;
    },
  };

  return <div id="result">{JSON.stringify(result)}</div>;
}
