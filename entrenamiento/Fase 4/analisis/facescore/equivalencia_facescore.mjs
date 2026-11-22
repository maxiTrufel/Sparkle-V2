// Corre el `faceScore.js` ORIGINAL sobre la muestra de cuadros reales de BIWI y
// devuelve su decisión por cuadro, para compararla con `facescore_ref.py`.
//
// Uso: node equivalencia_facescore.mjs <ruta a faceScore.js> <muestra_equivalencia.json>
//
// `faceScore` no expone la decisión por cuadro: sólo `record()` y `value()`, que
// agrega 10 s y exige 30 cuadros. Por eso cada cuadro se repite 30 veces a 6 fps
// en un puntaje nuevo, y la decisión es `value >= 50`. Con el cuadro repetido el
// valor sale 100 (en pantalla), 0 (fuera) o ~10 (ojos cerrados: los primeros
// cuadros quedan dentro de los 500 ms de gracia), así que el corte en 50 no
// tiene casos ambiguos.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , rutaFaceScore, rutaMuestra] = process.argv;
const { createFaceScore } = await import(pathToFileURL(rutaFaceScore).href);

const PASO_MS = 1000 / 6;
const REPETICIONES = 30;

function resultadoMediaPipe(cuadro, cabezaSola) {
  // Sólo se cargan los cinco landmarks que lee `faceScore`; el resto queda en
  // cero y no se consulta nunca.
  const lm = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  for (const [k, [x, y, z]] of Object.entries(cuadro.lm)) lm[Number(k)] = { x, y, z };
  const categories = cabezaSola
    ? []
    : Object.entries(cuadro.bs).map(([categoryName, score]) => ({ categoryName, score }));
  return {
    faceLandmarks: [lm],
    facialTransformationMatrixes: [{ data: cuadro.m_col }],
    faceBlendshapes: [{ categories }],
  };
}

function decision(cuadro, cabezaSola) {
  const puntaje = createFaceScore();
  const r = resultadoMediaPipe(cuadro, cabezaSola);
  let t = 0;
  for (let i = 0; i < REPETICIONES; i += 1) {
    puntaje.record(r, t);
    t += PASO_MS;
  }
  const v = puntaje.value(t - PASO_MS);
  if (v === null) throw new Error('faceScore devolvió null con 30 cuadros');
  return v >= 50;
}

const muestra = JSON.parse(readFileSync(rutaMuestra, 'utf8'));
process.stdout.write(JSON.stringify({
  cabeza: muestra.map((c) => decision(c, true)),
  completo: muestra.map((c) => decision(c, false)),
}));
