// Extracción de las 22 features geométricas (`offscreen/features.js`) sobre
// resultados SINTÉTICOS de FaceLandmarker: se arma una malla de 478 puntos
// con los ojos y la boca en posiciones conocidas y se verifica cada feature
// contra el valor calculado a mano. El orden y los nombres se fijan contra
// el notebook en `preprocessing.js`; acá se fija la aritmética.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_NAMES,
  N_FEATURES,
  BLENDSHAPES_OF_INTEREST,
  featuresFromResult,
  faceWidthFromResult,
  cropFaceFromResult,
  cropToTensor,
  debugCompareWithPython,
} from '../src/offscreen/features.js';

const W = 640;
const H = 480;

// Malla de 478 puntos en el centro; se mueven solo los que usan EAR y MAR.
function mallaBase() {
  return Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
}

function ponerOjo(malla, ids, cx, cy, ancho, alto) {
  // ids = [esquina1, sup1, sup2, esquina2, inf2, inf1] (orden de features.js)
  const [p0, p1, p2, p3, p4, p5] = ids;
  malla[p0] = { x: (cx - ancho / 2) / W, y: cy / H };
  malla[p3] = { x: (cx + ancho / 2) / W, y: cy / H };
  malla[p1] = { x: (cx - ancho / 6) / W, y: (cy - alto / 2) / H };
  malla[p5] = { x: (cx - ancho / 6) / W, y: (cy + alto / 2) / H };
  malla[p2] = { x: (cx + ancho / 6) / W, y: (cy - alto / 2) / H };
  malla[p4] = { x: (cx + ancho / 6) / W, y: (cy + alto / 2) / H };
}

const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const LEFT_EYE = [362, 385, 387, 263, 373, 380];

// Matriz identidad con traslación en data[12..14] (column-major, como la
// entrega MediaPipe Web): yaw = pitch = 0.
function matrizIdentidad() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, -1.2, -40, 1];
}

function resultado({ malla = mallaBase(), matriz = matrizIdentidad(), blendshapes } = {}) {
  return {
    faceLandmarks: [malla],
    facialTransformationMatrixes: matriz ? [{ data: matriz }] : [],
    faceBlendshapes: blendshapes ? [{ categories: blendshapes }] : [],
  };
}

test('FEATURE_NAMES: 22 features, las 6 geométricas primero y después los 16 blendshapes', () => {
  assert.equal(N_FEATURES, 22);
  assert.equal(FEATURE_NAMES.length, 22);
  assert.deepEqual(FEATURE_NAMES.slice(0, 6), ['ear_avg', 'ear_left', 'ear_right', 'yaw', 'pitch', 'mar']);
  assert.deepEqual(FEATURE_NAMES.slice(6), BLENDSHAPES_OF_INTEREST);
});

test('featuresFromResult sin rostro devuelve 22 NaN (el cuadro se interpola después)', () => {
  for (const sinRostro of [null, {}, { faceLandmarks: [] }, { faceLandmarks: [[]] }]) {
    const f = featuresFromResult(sinRostro, W, H);
    assert.equal(f.length, 22);
    assert.ok([...f].every(Number.isNaN));
  }
});

test('featuresFromResult calcula EAR, MAR, ángulos y blendshapes con los valores esperados', () => {
  const malla = mallaBase();
  // Ojo derecho: 60 px de ancho y 15 px de alto → EAR = (15 + 15) / (2·60) = 0,25.
  ponerOjo(malla, RIGHT_EYE, 250, 200, 60, 15);
  // Ojo izquierdo: 60 × 30 → EAR = 0,5.
  ponerOjo(malla, LEFT_EYE, 390, 200, 60, 30);
  // Boca: comisuras a 80 px, apertura de 20 px → MAR = 0,25.
  malla[61] = { x: 280 / W, y: 320 / H };
  malla[291] = { x: 360 / W, y: 320 / H };
  malla[13] = { x: 320 / W, y: 310 / H };
  malla[14] = { x: 320 / W, y: 330 / H };

  const blendshapes = BLENDSHAPES_OF_INTEREST
    .filter((nombre) => nombre !== 'jawOpen')
    .map((categoryName, i) => ({ categoryName, score: i / 100 }));
  const f = featuresFromResult(resultado({ malla, blendshapes }), W, H);

  assert.ok(Math.abs(f[2] - 0.25) < 1e-6, `ear_right=${f[2]}`);
  assert.ok(Math.abs(f[1] - 0.5) < 1e-6, `ear_left=${f[1]}`);
  assert.ok(Math.abs(f[0] - 0.375) < 1e-6, `ear_avg=${f[0]}`);
  assert.ok(Math.abs(f[3]) < 1e-9, 'yaw = 0 con la identidad');
  assert.ok(Math.abs(f[4]) < 1e-9, 'pitch = 0 con la identidad');
  assert.ok(Math.abs(f[5] - 0.25) < 1e-6, `mar=${f[5]}`);
  assert.ok(Math.abs(f[6] - 0) < 1e-6, 'eyeBlinkLeft');
  assert.ok(Math.abs(f[7] - 0.01) < 1e-6, 'eyeBlinkRight');
  assert.ok(Number.isNaN(f[21]), 'un blendshape ausente queda NaN (jawOpen)');
});

test('featuresFromResult: ángulos desde la matriz column-major (yaw de 30° y caso singular)', () => {
  const rad = (30 * Math.PI) / 180;
  // Rotación sobre Y de 30°: r20 = -sin(θ) → yaw = atan2(sin θ, cos θ) = 30°.
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const rotY = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, -40, 1];
  const f = featuresFromResult(resultado({ matriz: rotY }), W, H);
  assert.ok(Math.abs(f[3] - 30) < 1e-4, `yaw=${f[3]}`);
  assert.ok(Math.abs(f[4]) < 1e-4, `pitch=${f[4]}`);

  // Singular (sy ≈ 0, mirada a 90°): el pitch sale de r12/r11.
  const singular = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -40, 1];
  const g = featuresFromResult(resultado({ matriz: singular }), W, H);
  assert.ok(Math.abs(g[3] - 90) < 1e-4, `yaw=${g[3]}`);
  assert.ok(Number.isFinite(g[4]));
});

test('featuresFromResult: sin matriz ni blendshapes esas posiciones quedan NaN; ojos o boca degenerados dan NaN', () => {
  const malla = mallaBase(); // todos los puntos iguales: distancia horizontal 0
  const f = featuresFromResult(resultado({ malla, matriz: null }), W, H);
  assert.ok(Number.isNaN(f[0]) && Number.isNaN(f[1]) && Number.isNaN(f[2]), 'EAR con ancho 0 es NaN');
  assert.ok(Number.isNaN(f[3]) && Number.isNaN(f[4]), 'sin matriz no hay yaw/pitch');
  assert.ok(Number.isNaN(f[5]), 'MAR con ancho 0 es NaN');
  assert.ok([...f.slice(6)].every(Number.isNaN), 'sin blendshapes');
});

test('faceWidthFromResult mide el ancho del rostro en píxeles, o NaN si no hay rostro o tamaño', () => {
  const malla = mallaBase();
  malla[0] = { x: 0.25, y: 0.5 };
  malla[1] = { x: 0.75, y: 0.5 };
  assert.equal(faceWidthFromResult(resultado({ malla }), 640, 480), 320);
  assert.ok(Number.isNaN(faceWidthFromResult(null, 640, 480)));
  assert.ok(Number.isNaN(faceWidthFromResult(resultado({ malla }), 0, 480)));
});

test('cropFaceFromResult recorta un cuadrado con margen alrededor de la malla y lo redimensiona', () => {
  const malla = mallaBase();
  malla[0] = { x: 0.4, y: 0.4 };
  malla[1] = { x: 0.6, y: 0.6 };
  const llamadas = [];
  const canvas = {
    getContext: (tipo, opciones) => {
      llamadas.push(['getContext', tipo, opciones]);
      return {
        drawImage: (...args) => llamadas.push(['drawImage', ...args.slice(1)]),
        getImageData: (x, y, w, h) => ({ x, y, width: w, height: h }),
      };
    },
  };
  const fuente = { width: 0, height: 0, videoWidth: 500, videoHeight: 500 };
  const recorte = cropFaceFromResult(fuente, resultado({ malla }), canvas, 112, 0.25);
  assert.deepEqual(recorte, { x: 0, y: 0, width: 112, height: 112 });
  // Caja de 100 px (200..300) con 25 % de margen → lado 125, centrada en 250.
  const [, ...dibujo] = llamadas.find((l) => l[0] === 'drawImage');
  assert.deepEqual(dibujo, [188, 188, 125, 125, 0, 0, 112, 112]);
  assert.deepEqual(llamadas[0], ['getContext', '2d', { willReadFrequently: true }]);
});

test('cropFaceFromResult devuelve null sin rostro, sin tamaño de cuadro o con una caja vacía', () => {
  const canvas = { getContext: () => { throw new Error('no debería dibujar'); } };
  assert.equal(cropFaceFromResult({ width: 100, height: 100 }, null, canvas), null);
  assert.equal(cropFaceFromResult({}, resultado(), canvas), null);
  const fuera = mallaBase().map(() => ({ x: 2, y: 2 })); // toda la malla fuera del cuadro
  assert.equal(cropFaceFromResult({ width: 100, height: 100 }, resultado({ malla: fuera }), canvas), null);
});

test('cropToTensor descarta el alfa y lleva [0,255] a [-1,1] (preprocess_input de MobileNetV2)', () => {
  // Dos píxeles RGBA: (0, 51, 255, α) y (255, 0, 0, α).
  const data = new Uint8ClampedArray([0, 51, 255, 255, 255, 0, 0, 0]);
  const tensor = cropToTensor({ data }, 1);
  assert.equal(tensor.length, 3, 'size×size×3 valores');
  assert.deepEqual([...cropToTensor({ data }, 2)].slice(0, 6).map((v) => Number(v.toFixed(3))), [-1, -0.6, 1, 1, -1, -1]);
});

test('debugCompareWithPython arma una tabla nombre/valor con NaN explícito', () => {
  const original = console.table;
  let impreso;
  console.table = (filas) => { impreso = filas; };
  try {
    const valores = new Float32Array(22).fill(NaN);
    valores[0] = 0.123456789;
    const filas = debugCompareWithPython(valores);
    assert.equal(filas.length, 22);
    assert.deepEqual(filas[0], { feature: 'ear_avg', value: '0.123457' });
    assert.deepEqual(filas[5], { feature: 'mar', value: 'NaN' });
    assert.equal(impreso, filas);
  } finally {
    console.table = original;
  }
});
