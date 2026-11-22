// Verifica que la implementación en JavaScript del ensemble reproduce las
// probabilidades que produce Python.
//
// POR QUÉ ESTE TEST ES EL QUE IMPORTA
// -----------------------------------
// La migración del modelo de decisión de TFLite a JavaScript es un punto donde
// el producto puede divergir del número medido SIN AVISAR: si el orden de las
// features, el divisor del desvío estándar o el escalado no coinciden, el
// sistema devuelve probabilidades plausibles y equivocadas. Es la misma clase
// de fallo que ya apareció tres veces en el proyecto.
//
// Los fixtures los genera `Modelo Tesis/Fase 3/exportar_ensemble_a_json.py` con
// el mismo código que ajustó el modelo. Si este test falla, la extensión NO
// está corriendo el modelo validado.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../src/offscreen/ensemble.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUTA_MODELO = path.join(__dirname, 'fixtures', 'modelo_ensemble.json');
const RUTA_CASOS = path.join(__dirname, 'fixtures', 'fixtures_ensemble.json');

const hayFixtures = fs.existsSync(RUTA_MODELO) && fs.existsSync(RUTA_CASOS);

// Réplica de `predictEnsemble()` que opera sobre un modelo ya parseado, para
// poder correr sin `fetch` (que no existe en el entorno de test de Node).
function predecir(cfg, geom, emb) {
  const T = cfg.n_frames; const G = cfg.n_geom;
  const TE = cfg.n_emb_frames; const D = cfg.emb_dim;
  const rg = summarize(geom, T, G);
  const perHead = cfg.cabezas.map((h) => {
    const [a, b] = h.bloque;
    const re = summarize(emb, TE, D, a, b);
    let logit = h.intercept;
    for (let i = 0; i < rg.length; i += 1) {
      logit += ((rg[i] - h.scaler_mean[i]) / h.scaler_scale[i]) * h.coef[i];
    }
    for (let i = 0; i < re.length; i += 1) {
      const k = rg.length + i;
      logit += ((re[i] - h.scaler_mean[k]) / h.scaler_scale[k]) * h.coef[k];
    }
    return 1 / (1 + Math.exp(-logit));
  });
  return { p: perHead.reduce((s, v) => s + v, 0) / perHead.length, perHead };
}

const aplanar = (m) => Float64Array.from(m.flat());

test('summarize usa desvío POBLACIONAL (divisor N, como numpy)', () => {
  // El divisor importa: con N−1 el resumen difiere y el modelo queda
  // desalineado con el que se entrenó.
  const seq = [1, 10, 2, 20, 3, 30, 4, 40];   // 4 pasos × 2 columnas
  const r = summarize(seq, 4, 2);
  assert.ok(Math.abs(r[0] - 2.5) < 1e-12, 'media col 0');
  assert.ok(Math.abs(r[1] - 25) < 1e-12, 'media col 1');
  // std poblacional de [1,2,3,4] = sqrt(1.25) ≈ 1.1180339887
  assert.ok(Math.abs(r[2] - Math.sqrt(1.25)) < 1e-12, `std col 0: ${r[2]}`);
  assert.ok(Math.abs(r[3] - Math.sqrt(125)) < 1e-12, `std col 1: ${r[3]}`);
});

test('summarize respeta el rango de columnas del bloque', () => {
  const seq = [0, 1, 2, 3, 0, 1, 2, 3];    // 2 pasos × 4 columnas
  const r = summarize(seq, 2, 4, 1, 3);    // columnas 1 y 2
  assert.equal(r.length, 4, 'dos medias y dos desvíos');
  assert.ok(Math.abs(r[0] - 1) < 1e-12);
  assert.ok(Math.abs(r[1] - 2) < 1e-12);
});

test('summarize trata los NaN como cero, sin propagarlos', () => {
  const seq = [1, NaN, 3, 5];   // 2 pasos × 2 columnas
  const r = summarize(seq, 2, 2);
  assert.ok(Number.isFinite(r[0]) && Number.isFinite(r[1]));
  assert.ok(Math.abs(r[0] - 2) < 1e-12, 'media col 0 = (1+3)/2');
  assert.ok(Math.abs(r[1] - 2.5) < 1e-12, 'media col 1 = (0+5)/2 con NaN→0');
});

test('la implementación JS reproduce las probabilidades de Python', { skip: !hayFixtures
  ? 'Faltan fixtures — correr exportar_ensemble_a_json.py y copiar a tests/fixtures/' : false },
() => {
  const cfg = JSON.parse(fs.readFileSync(RUTA_MODELO, 'utf8'));
  const { casos } = JSON.parse(fs.readFileSync(RUTA_CASOS, 'utf8'));
  assert.ok(casos.length > 0, 'no hay casos en los fixtures');

  let maxDif = 0;
  casos.forEach((c, i) => {
    const { p, perHead } = predecir(cfg, aplanar(c.geom), aplanar(c.emb));
    const dif = Math.abs(p - c.p_esperada);
    maxDif = Math.max(maxDif, dif);
    assert.ok(dif < 1e-9,
      `caso ${i}: JS ${p.toFixed(12)} vs Python ${c.p_esperada.toFixed(12)} (dif ${dif.toExponential(2)})`);
    perHead.forEach((ph, j) => {
      assert.ok(Math.abs(ph - c.p_por_cabeza[j]) < 1e-9, `caso ${i}, cabeza ${j}`);
    });
  });
  console.log(`  fidelidad JS vs Python: diferencia máxima ${maxDif.toExponential(2)} sobre ${casos.length} casos`);
});

test('el modelo exportado declara la rama de apariencia CRUDA', { skip: !hayFixtures
  ? 'Faltan fixtures' : false }, () => {
  // Si esto cambiara, `detector.js` tendría que dejar de pasarle la salida
  // cruda del extractor y el pipeline sería otro.
  const cfg = JSON.parse(fs.readFileSync(RUTA_MODELO, 'utf8'));
  assert.equal(cfg.usa_emb_scaler, false);
  assert.equal(cfg.cabezas.length, cfg.n_cabezas);
  cfg.cabezas.forEach((h, j) => {
    assert.equal(h.coef.length, cfg.n_geom * 2 + cfg.d_bloque * 2, `cabeza ${j}`);
    assert.deepEqual(h.bloque, [j * cfg.d_bloque, (j + 1) * cfg.d_bloque], `cabeza ${j}`);
  });
});
