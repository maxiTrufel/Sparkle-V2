// Puntaje por orientación de cabeza, mirada y ojos (`src/offscreen/faceScore.js`)
// y su combinación con el del modelo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFaceScore, combineScores, FACE_WEIGHT,
} from '../src/offscreen/faceScore.js';

const STEP = 1000 / 6; // 6 fps, la cadencia de la rama geométrica del detector
const rad = (deg) => (deg * Math.PI) / 180;

const NAMES = [
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeLookDownLeft',
  'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeLookDownRight',
];

/**
 * Resultado sintético de MediaPipe. yaw + = girado a su derecha, pitch − =
 * mirando abajo. La magnitud va en la matriz (column-major) y el signo en los
 * puntos de la cara, igual que en el resultado real.
 */
function fakeResult({ yaw = 0, pitch = 0, blink = 0, gaze = {} } = {}) {
  const y = rad(Math.abs(yaw));
  const p = rad(Math.abs(pitch));
  const data = new Array(16).fill(0);
  data[0] = Math.cos(y);
  data[2] = -Math.sin(y);
  data[5] = Math.cos(p);
  data[6] = Math.cos(y) * Math.sin(p);
  data[9] = -Math.sin(p);
  data[10] = Math.cos(y) * Math.cos(p);
  data[15] = 1;

  const lm = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[234] = { x: 0.4, y: 0.5, z: 0 };
  lm[454] = { x: 0.6, y: 0.5, z: 0 };
  lm[1] = { x: yaw >= 0 ? 0.49 : 0.51, y: 0.5, z: -0.1 };
  lm[10] = { x: 0.5, y: 0.3, z: pitch < 0 ? -0.05 : 0.05 };
  lm[152] = { x: 0.5, y: 0.7, z: 0 };

  const categories = NAMES.map((n) => ({
    categoryName: n,
    score: n.startsWith('eyeBlink') ? blink : (gaze[n] ?? 0),
  }));
  return { faceLandmarks: [lm], facialTransformationMatrixes: [{ data }], faceBlendshapes: [{ categories }] };
}

const NO_FACE = { faceLandmarks: [] };

/** Registra cuadros durante `ms` desde `from`; devuelve el instante del último. */
function feed(score, from, ms, gen) {
  let t = from;
  let i = 0;
  for (; t < from + ms; t += STEP, i += 1) score.record(gen(i, t), t);
  return t - STEP;
}

/** Puntaje nuevo alimentado 10 s con `gen`; devuelve su valor al final. */
function scoreOf(gen) {
  const score = createFaceScore();
  return score.value(feed(score, 0, 10000, gen));
}

test('mirando al frente con los ojos abiertos da 100 %', () => {
  assert.equal(scoreOf(() => fakeResult()), 100);
});

test('mide desde el primer cuadro, sin esperar calibración', () => {
  const score = createFaceScore();
  const end = feed(score, 0, 6000, () => fakeResult());
  assert.equal(score.value(end), 100);
});

test('sin cuadros suficientes no da puntaje', () => {
  assert.equal(createFaceScore().value(0), null);
  const score = createFaceScore();
  const end = feed(score, 0, 2000, () => fakeResult());
  assert.equal(score.value(end), null);
});

test('si el alumno llega tarde, los segundos sin rostro no lo marcan para siempre', () => {
  // 5 s sin nadie y después sentado mirando: a los 10 s de llegar ya es 100 %.
  const score = createFaceScore();
  const t = feed(score, 0, 5000, () => NO_FACE) + STEP;
  const end = feed(score, t, 12000, () => fakeResult());
  assert.equal(score.value(end), 100);
});

test('la cabeza girada 40° a un costado da 0 %', () => {
  assert.equal(scoreOf(() => fakeResult({ yaw: 40 })), 0);
});

test('mirando abajo (el celular en la falda) da 0 %', () => {
  assert.equal(scoreOf(() => fakeResult({ pitch: -40 })), 0);
});

test('leer la parte de abajo de la pantalla sigue atento (Enmienda 11)', () => {
  // Con la cámara arriba, leer la mitad inferior de la pantalla da −20° a −30°:
  // con el límite anterior (−20°) contaba como fuera.
  assert.equal(scoreOf(() => fakeResult({ pitch: -25 })), 100);
  assert.equal(scoreOf(() => fakeResult({ pitch: -30 })), 100, 'el borde exacto cuenta como en pantalla');
  assert.equal(scoreOf(() => fakeResult({ pitch: -31 })), 0);
});

test('un giro leve, dentro del margen de la pantalla, sigue atento', () => {
  assert.equal(scoreOf(() => fakeResult({ yaw: 15 })), 100);
});

test('si gira la cabeza pero compensa con la mirada sigue atento', () => {
  assert.equal(scoreOf(() => fakeResult({
    yaw: 30, gaze: { eyeLookOutLeft: 1, eyeLookInRight: 1 },
  })), 100);
});

test('un parpadeo corto no baja el puntaje; un cierre sostenido sí', () => {
  assert.equal(scoreOf((i) => fakeResult({ blink: i % 18 === 0 ? 1 : 0 })), 100);
  const closed = scoreOf(() => fakeResult({ blink: 1 }));
  assert.ok(closed < 10, `cierre sostenido dio ${closed} %`);
});

test('sin rostro cuenta como no atento', () => {
  const v = scoreOf((i) => (i % 2 ? NO_FACE : fakeResult()));
  assert.ok(Math.abs(v - 50) < 3, `dio ${v} %`);
});

test('reset descarta la ventana', () => {
  const score = createFaceScore();
  const end = feed(score, 0, 10000, () => fakeResult());
  score.reset();
  assert.equal(score.value(end), null);
});

test('el promedio pondera 90 % cara y 10 % modelo', () => {
  assert.equal(FACE_WEIGHT, 0.9);
  assert.ok(Math.abs(combineScores(80, 30) - 75) < 1e-9);
  assert.equal(combineScores(null, 30), 30);
  assert.equal(combineScores(80, null), 80);
  assert.equal(combineScores(null, null), null);
});
