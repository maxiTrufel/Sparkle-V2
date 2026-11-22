// Carga y predicción del ensemble (`offscreen/ensemble.js`) con un modelo
// SINTÉTICO mínimo: 2 cuadros, 1 feature geométrica y embeddings de 2
// dimensiones partidos en dos cabezas de 1 dimensión. La fidelidad numérica
// contra Python ya la fija `ensemble.fidelidadConPython.test.js`; acá se
// fijan las validaciones del JSON y la combinación de las cabezas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadEnsemble,
  isEnsembleLoaded,
  getEnsembleConfig,
  predictEnsemble,
} from '../src/offscreen/ensemble.js';

function cabeza(bloque, { coef = [0, 0, 0, 0], intercept = 0, scale = [1, 1, 1, 1] } = {}) {
  return { bloque, coef, intercept, scaler_mean: [0, 0, 0, 0], scaler_scale: scale };
}

function modelo(overrides = {}) {
  return {
    formato: 'sparkle-ensemble-v1',
    n_frames: 2,
    n_geom: 1,
    n_emb_frames: 2,
    emb_dim: 2,
    d_bloque: 1,
    usa_emb_scaler: false,
    n_cabezas: 2,
    cabezas: [cabeza([0, 1]), cabeza([1, 2], { intercept: 2 })],
    ...overrides,
  };
}

async function cargar(cfg, ok = true) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok, status: ok ? 200 : 500, json: async () => cfg });
  try {
    return await loadEnsemble('models/modelo_ensemble.json');
  } finally {
    globalThis.fetch = original;
  }
}

test('Sin cargar, el ensemble avisa en vez de predecir con un modelo vacío', () => {
  assert.equal(isEnsembleLoaded(), false);
  assert.throws(() => getEnsembleConfig(), /no cargado/);
  assert.throws(() => predictEnsemble([], []), /no cargado/);
});

test('loadEnsemble rechaza cada forma de JSON inconsistente con un mensaje que dice qué está mal', async () => {
  await assert.rejects(() => cargar(modelo(), false), /No se pudo cargar el ensemble: 500/);
  await assert.rejects(() => cargar(modelo({ formato: 'otro' })), /Formato de ensemble desconocido/);
  await assert.rejects(() => cargar(modelo({ n_cabezas: 3 })), /declara 3 cabezas y trae 2/);
  await assert.rejects(() => cargar(modelo({ usa_emb_scaler: true })), /usa_emb_scaler=true/);
  await assert.rejects(
    () => cargar(modelo({ cabezas: [cabeza([0, 1], { coef: [1] }), cabeza([1, 2])] })),
    /cabeza 0: coef\/scaler de largos/
  );
  await assert.rejects(
    () => cargar(modelo({ cabezas: [cabeza([0, 1]), cabeza([1, 2], { scale: [1, 0, 1, 1] })] })),
    /cabeza 1: scaler_scale con ceros/
  );
  await assert.rejects(
    () => cargar(modelo({ cabezas: [cabeza([0, 1]), cabeza([1, 3])] })),
    /cabeza 1: bloque \[1,3\] inválido/
  );
  assert.equal(isEnsembleLoaded(), false, 'ningún JSON inválido deja un modelo a medias');
});

test('predictEnsemble promedia la probabilidad de cada cabeza (sigmoide del logit)', async () => {
  // Cabeza 0: logit = coef sobre media geométrica (1·media). Cabeza 1: intercept 2.
  await cargar(modelo({ cabezas: [cabeza([0, 1], { coef: [1, 0, 0, 0] }), cabeza([1, 2], { intercept: 2 })] }));
  assert.equal(isEnsembleLoaded(), true);
  assert.equal(getEnsembleConfig().cabezas.length, 2);

  // Geometría estandarizada: 2 cuadros × 1 feature con media 0 → logit 0.
  const { p, perHead } = predictEnsemble(Float32Array.from([1, -1]), Float32Array.from([0.3, 0.7, 0.5, NaN]));
  const sigmoide = (x) => 1 / (1 + Math.exp(-x));
  assert.ok(Math.abs(perHead[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(perHead[1] - sigmoide(2)) < 1e-12);
  assert.ok(Math.abs(p - (0.5 + sigmoide(2)) / 2) < 1e-12);
});
