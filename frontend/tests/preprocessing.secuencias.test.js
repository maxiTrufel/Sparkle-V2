// Preprocesamiento de las secuencias antes de la inferencia
// (`offscreen/preprocessing.js`), con un `preprocesamiento.json` SINTÉTICO
// chico (3 cuadros, embeddings de 2 dimensiones) servido por un `fetch`
// simulado: así cada número de salida se puede verificar a mano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_NAMES } from '../src/offscreen/features.js';
import {
  loadPreprocessing,
  getConfig,
  interpolateNaN,
  resumenDinamica,
  prepareGeometric,
  prepareEmbeddings,
  noFaceFraction,
} from '../src/offscreen/preprocessing.js';

const F22 = 22;

function configSintetica(overrides = {}) {
  return {
    feature_names_22: [...FEATURE_NAMES],
    n_frames: 3,
    n_emb_frames: 2,
    emb_dim: 2,
    geom_medians: Array.from({ length: F22 }, (_, i) => i / 10),
    emb_medians: [0.5, -0.5],
    // 22 features + 2 deltas (ear_avg y yaw).
    geom_scaler_mean: Array(24).fill(0),
    geom_scaler_scale: Array(24).fill(1),
    emb_scaler_mean: [1, 1],
    emb_scaler_scale: [2, 2],
    delta_features: ['ear_avg', 'yaw'],
    ...overrides,
  };
}

function conFetch(respuesta, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => respuesta;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const ok = (cfg) => ({ ok: true, status: 200, json: async () => cfg });

test('getConfig antes de cargar el JSON avisa que falta loadPreprocessing', () => {
  assert.throws(() => getConfig(), /sin cargar/);
});

test('loadPreprocessing rechaza un HTTP fallido, otra cantidad de features, otro orden o un delta desconocido', async () => {
  await conFetch({ ok: false, status: 404 }, async () => {
    await assert.rejects(() => loadPreprocessing('x'), /HTTP 404/);
  });
  await conFetch(ok(configSintetica({ feature_names_22: FEATURE_NAMES.slice(0, 21) })), async () => {
    await assert.rejects(() => loadPreprocessing('x'), /declara 21 features/);
  });
  const cruzadas = [...FEATURE_NAMES];
  [cruzadas[3], cruzadas[4]] = [cruzadas[4], cruzadas[3]];
  await conFetch(ok(configSintetica({ feature_names_22: cruzadas })), async () => {
    await assert.rejects(() => loadPreprocessing('x'), /Desfase en el orden de features en la posición 3/);
  });
  await conFetch(ok(configSintetica({ delta_features: ['no_existe'] })), async () => {
    await assert.rejects(() => loadPreprocessing('x'), /Delta feature desconocida: no_existe/);
  });
});

test('loadPreprocessing con un JSON válido deja la configuración lista', async () => {
  const cfg = await conFetch(ok(configSintetica()), () => loadPreprocessing('models/preprocesamiento.json'));
  assert.equal(cfg.nFrames, 3);
  assert.deepEqual(cfg.deltaIdx, [0, 3]);
  assert.ok(cfg.geomMedians instanceof Float32Array);
  assert.equal(getConfig(), cfg);
});

test('interpolateNaN: lineal entre válidos, bordes con el vecino más cercano y columna vacía con la mediana', () => {
  // 5 cuadros × 2 columnas. Columna 0: [NaN, 1, NaN, 3, NaN]. Columna 1: todo NaN.
  const seq = Float32Array.from([NaN, NaN, 1, NaN, NaN, NaN, 3, NaN, NaN, NaN]);
  interpolateNaN(seq, 5, 2, [0, 7]);
  assert.deepEqual([0, 2, 4, 6, 8].map((i) => seq[i]), [1, 1, 2, 3, 3]);
  assert.deepEqual([1, 3, 5, 7, 9].map((i) => seq[i]), [7, 7, 7, 7, 7]);

  const sinMedianas = Float32Array.from([NaN, NaN]);
  interpolateNaN(sinMedianas, 2, 1, null);
  assert.deepEqual([...sinMedianas], [0, 0]);
});

function secuenciaGeometrica() {
  // 3 cuadros; ear_avg = 0.2, 0.4, NaN (se completa con 0.4); yaw = 0, 10, 20.
  const raw = new Float32Array(3 * F22).fill(1);
  [0.2, 0.4, NaN].forEach((v, f) => { raw[f * F22 + 0] = v; });
  [0, 10, 20].forEach((v, f) => { raw[f * F22 + 3] = v; });
  return raw;
}

test('prepareGeometric agrega los deltas de las features pedidas y estandariza con media/escala', () => {
  const out = prepareGeometric(secuenciaGeometrica());
  const F32 = 24;
  assert.equal(out.length, 3 * F32);
  // Deltas del cuadro 0 siempre 0; luego ear_avg: +0.2, 0; yaw: +10, +10.
  assert.deepEqual([0, 1, 2].map((f) => Number(out[f * F32 + 22].toFixed(4))), [0, 0.2, 0]);
  assert.deepEqual([0, 1, 2].map((f) => out[f * F32 + 23]), [0, 10, 10]);
  assert.ok(Math.abs(out[2 * F32 + 0] - 0.4) < 1e-6, 'el NaN del último cuadro se completó con el anterior');
});

test('resumenDinamica promedia el cambio absoluto por cuadro de cada delta, escalado', () => {
  const { dinamica, porColumna } = resumenDinamica(secuenciaGeometrica());
  assert.ok(Math.abs(porColumna[0] - 0.1) < 1e-6, 'ear_avg: (0,2 + 0) / 2');
  assert.equal(porColumna[1], 10, 'yaw: (10 + 10) / 2');
  assert.ok(Math.abs(dinamica - 5.05) < 1e-6);
});

test('prepareEmbeddings interpola y estandariza, o devuelve la secuencia cruda si se pide', () => {
  const raw = Float32Array.from([3, NaN, NaN, NaN]);
  assert.deepEqual([...prepareEmbeddings(raw)], [1, -0.75, 1, -0.75]);
  assert.deepEqual([...prepareEmbeddings(raw, { standardize: false })], [3, -0.5, 3, -0.5]);
});

test('noFaceFraction cuenta la fracción de cuadros con al menos un NaN', () => {
  const raw = Float32Array.from([1, 2, NaN, 3, 4, 5, NaN, NaN]);
  assert.equal(noFaceFraction(raw, 4, 2), 0.5);
});
