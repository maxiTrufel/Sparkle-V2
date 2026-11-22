// Corre el `faceScore.js` ORIGINAL sobre secuencias de cuadros con su tiempo
// real, y devuelve `value()` al final de cada una. Verifica la parte temporal
// del port (`PuntajeCara` en `facescore_ref.py`): cierre sostenido, ventana de
// 10 s y mínimo de 30 cuadros.
//
// Uso: node equivalencia_clips.mjs <ruta a faceScore.js> <clips.json>
//
// clips.json: [{ cuadros: [{ t, rostro, m_col, lm, bs }] }]
//   rostro=false            -> resultado sin landmarks
//   rostro=true, m_col=null -> landmarks sin matriz (el JS no lo registra)
// Cada clip se corre dos veces: con los blendshapes reales y con blendshapes
// vacíos (cabeza sola).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , rutaFaceScore, rutaClips] = process.argv;
const { createFaceScore } = await import(pathToFileURL(rutaFaceScore).href);

function resultado(c, cabezaSola) {
  if (!c.rostro) return { faceLandmarks: [] };
  const lm = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  for (const [k, [x, y, z]] of Object.entries(c.lm)) lm[Number(k)] = { x, y, z };
  if (c.m_col === null) return { faceLandmarks: [lm] };
  const categories = cabezaSola
    ? []
    : Object.entries(c.bs).map(([categoryName, score]) => ({ categoryName, score }));
  return {
    faceLandmarks: [lm],
    facialTransformationMatrixes: [{ data: c.m_col }],
    faceBlendshapes: [{ categories }],
  };
}

function valor(clip, cabezaSola) {
  const puntaje = createFaceScore();
  let ultimo = 0;
  for (const c of clip.cuadros) {
    puntaje.record(resultado(c, cabezaSola), c.t);
    ultimo = c.t;
  }
  return puntaje.value(ultimo);
}

const clips = JSON.parse(readFileSync(rutaClips, 'utf8'));
process.stdout.write(JSON.stringify({
  completo: clips.map((c) => valor(c, false)),
  cabeza: clips.map((c) => valor(c, true)),
}));
