// Harness mínimo para ejercitar `useGroupAttentionAlert` de forma aislada
// (sin montar `App.jsx` entero) — expone `window.__harness` con lo
// necesario para empujar snapshots de roster y leer el resultado del hook
// desde el test. Mismo patrón que `fatigueAlertHarness.jsx`.
import { useState } from 'react';
import { useGroupAttentionAlert } from '../../src/hooks/useGroupAttentionAlert.js';

let seq = 0;

export default function GroupAttentionAlertHarness() {
  const [roster, setRoster] = useState([]);
  const [config, setConfig] = useState({
    pThreshold: 0.5,
    windowSecondsTeacher: 10,
    qThresholdTeacher: 0.5,
    cooldownSeconds: 999,
    classStarted: true,
    connected: true,
    hasActiveQuestion: false,
  });

  const result = useGroupAttentionAlert(roster, config);

  window.__harness = {
    // `roster` tiene que cambiar de REFERENCIA en cada llamada (el hook
    // depende de `[roster]` a propósito, ver el comentario del archivo) --
    // un array nuevo en cada push, nunca mutado.
    pushRoster(inattentiveCount, total) {
      seq += 1;
      const students = Array.from({ length: total }, (_, i) => ({
        id: `s${seq}-${i}`,
        inattentive: i < inattentiveCount,
      }));
      setRoster(students);
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
