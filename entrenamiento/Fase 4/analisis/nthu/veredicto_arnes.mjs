// Arnés de fidelidad del veredicto (Preregistro_FaceScore.md §5.1.3).
//
// Corre los módulos ORIGINALES del producto —`faceScore.js`, `reglas.js` y
// `noFaceFraction` de `preprocessing.js`— sobre las mismas secuencias que el port
// `veredicto_ref.py`, y devuelve el veredicto V1 en cada instante. El orden de
// ramas de `predict()` se porta por lectura (líneas 588–797 de `257d454`), como
// declara §5.1.3: `predict()` no corre fuera del navegador.
//
// Uso: node veredicto_arnes.mjs <dir de offscreen> <secuencias.json>
//
// secuencias.json: [{ id, muestras: [{ t, rostro, m_col, lm, bs, yaw, ear }] }]
//   yaw/ear: null cuando no hay rostro o no hay matriz (el producto los tendría NaN)
//
// Salida: [{ id, instantes: [{ i, estado, fuente, cara, r1, r2, fracSinRostro }] }]

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , dirOffscreen, rutaSecuencias] = process.argv;
const carga = (n) => import(pathToFileURL(`${dirOffscreen}/${n}`).href);
const { createFaceScore } = await carga('faceScore.js');
const { evaluar: evaluarReglas, medianaFinita } = await carga('reglas.js');
const { noFaceFraction } = await carga('preprocessing.js');

const VENTANA_ROSTRO = 60;      // cfg.nFrames
const VENTANA_REGLAS = 300;     // 5 × 60 = 50 s a 6 fps
const N_FEATURES = 22;
const MAX_SIN_ROSTRO = 0.30;
const UMBRAL = 0.50;
const BANDA_BAJA = 400 / 9;
const BANDA_ALTA = 500 / 9;
const N_CALIB = 180;            // línea base de EAR: 30 s con rostro (Enmienda_5)

function resultadoMediaPipe(m) {
  if (!m.rostro) return { faceLandmarks: [] };
  const lm = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  for (const [k, [x, y, z]] of Object.entries(m.lm ?? {})) lm[Number(k)] = { x, y, z };
  if (m.m_col === null || m.m_col === undefined) return { faceLandmarks: [lm] };
  return {
    faceLandmarks: [lm],
    facialTransformationMatrixes: [{ data: m.m_col }],
    faceBlendshapes: [{ categories: Object.entries(m.bs).map(([categoryName, score]) => ({ categoryName, score })) }],
  };
}

// Matriz cruda como la vería `predict()`: una fila por muestra, NaN donde el
// producto no tendría valor. `noFaceFraction` sólo mira si hay algún NaN.
function crudo(muestras) {
  const raw = new Float32Array(VENTANA_ROSTRO * N_FEATURES).fill(0);
  muestras.forEach((m, f) => {
    const sinValor = !m.rostro || m.yaw === null || m.yaw === undefined;
    if (sinValor) for (let c = 0; c < N_FEATURES; c += 1) raw[f * N_FEATURES + c] = NaN;
  });
  return raw;
}

const secuencias = JSON.parse(readFileSync(rutaSecuencias, 'utf8'));
const salida = secuencias.map(({ id, muestras }) => {
  // Línea base de EAR del video, como `detector.js`: los primeros 180 finitos.
  const finitos = muestras.map((m) => m.ear).filter((e) => Number.isFinite(e));
  const baselineEar = finitos.length >= N_CALIB ? medianaFinita(finitos.slice(0, N_CALIB)) : null;

  const puntaje = createFaceScore();
  const instantes = [];
  muestras.forEach((m, i) => {
    puntaje.record(resultadoMediaPipe(m), m.t);
    if (i < VENTANA_REGLAS - 1 || (i - (VENTANA_REGLAS - 1)) % VENTANA_ROSTRO !== 0) return;

    const ventanaRostro = muestras.slice(i - VENTANA_ROSTRO + 1, i + 1);
    const fracSinRostro = noFaceFraction(crudo(ventanaRostro), VENTANA_ROSTRO, N_FEATURES);
    const cara = puntaje.value(m.t);

    let estado; let fuente;
    if (fracSinRostro > MAX_SIN_ROSTRO) {
      estado = 'sin_veredicto'; fuente = 'no_face';
    } else {
      const ventana = muestras.slice(i - VENTANA_REGLAS + 1, i + 1);
      const yawWin = Float32Array.from(ventana.map((x) => (x.yaw === null || x.yaw === undefined ? NaN : x.yaw)));
      const earWin = Float32Array.from(ventana.map((x) => (x.ear === null || x.ear === undefined ? NaN : x.ear)));
      const reglas = evaluarReglas(yawWin, earWin, baselineEar);
      if (reglas.dispara) {
        const valor = cara === null ? 0 : 0.9 * cara + 0.1 * 0;
        estado = valor / 100 <= UMBRAL ? 'desatento' : 'atento';
        fuente = reglas.fuente;
      } else if (cara === null) {
        estado = 'indeterminado'; fuente = 'modelo';
      } else if (cara <= BANDA_BAJA) {
        estado = 'desatento'; fuente = 'cara';
      } else if (cara > BANDA_ALTA) {
        estado = 'atento'; fuente = 'cara';
      } else {
        estado = 'indeterminado'; fuente = 'modelo';
      }
      instantes.push({ i, estado, fuente, cara, r1: reglas.R1.dispara, r2: reglas.R2.dispara, fracSinRostro });
      return;
    }
    instantes.push({ i, estado, fuente, cara, r1: null, r2: null, fracSinRostro });
  });
  return { id, baselineEar, instantes };
});

process.stdout.write(JSON.stringify(salida));
