// Equivalencia numérica con la implementación de referencia, sobre datos REALES.
//
// QUÉ FIJA ESTE TEST
// ------------------
// `reglas_referencia.json` contiene 400 ventanas de 50 s tomadas del pool de
// desarrollo de DAiSEE —las mismas sobre las que se midió la especificidad que
// la tesis reporta— con el veredicto y las magnitudes que produjo
// `Tesis-Vision-Artificial/Fase 4/analisis/reglas_geometricas.py`.
//
// Si la versión que despacha la extensión decide distinto sobre esas ventanas,
// entonces las cifras publicadas (0 activaciones de R1 en 975 ventanas de 79
// sujetos) describen a un detector que no es el que se despacha, y dejan de ser
// evidencia sobre el producto. Este test es lo que impide que esa brecha se
// abra sin que nadie se entere.
//
// Regenerar el fixture: ver el bloque de volcado en la bitácora del 2026-08-23.
// El JSON no contiene imágenes ni nada que identifique a un sujeto: sólo dos
// series numéricas por ventana (yaw en grados y `ear_avg` adimensional).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { r1MiradaFuera, r2OjosCerrados } from '../src/offscreen/reglas.js';

const aqui = dirname(fileURLToPath(import.meta.url));
const casos = JSON.parse(readFileSync(join(aqui, 'fixtures', 'reglas_referencia.json'), 'utf8'));

/** `null` en el JSON representa un cuadro sin rostro (NaN en Python). */
const aFloat = (arr) => Float32Array.from(arr, (v) => (v === null ? NaN : v));

// Tolerancia de coma flotante entre float64 (numpy) y float32 (los buffers de
// la extensión). Las decisiones se comparan de forma EXACTA; sólo las
// magnitudes continuas admiten esta holgura.
const EPS = 1e-6;

test('el fixture de referencia está presente y es sustantivo', () => {
  assert.ok(Array.isArray(casos));
  assert.ok(casos.length >= 400, `se esperaban >= 400 ventanas, hay ${casos.length}`);
  assert.ok(casos.every((c) => c.yaw.length === 300 && c.ear.length === 300),
    'cada ventana son 300 cuadros = 50 s a 6 fps');
});

test('las DECISIONES de R1 coinciden con la referencia en las 400 ventanas', () => {
  let distintas = 0;
  for (const c of casos) {
    const r = r1MiradaFuera(aFloat(c.yaw));
    if (r.dispara !== c.R1) distintas += 1;
  }
  assert.equal(distintas, 0, `${distintas} ventanas donde R1 decide distinto que la referencia`);
});

test('las DECISIONES de R2 coinciden con la referencia en las 400 ventanas', () => {
  let distintas = 0;
  for (const c of casos) {
    const r = r2OjosCerrados(aFloat(c.ear), c.base);
    if (r.dispara !== c.R2) distintas += 1;
  }
  assert.equal(distintas, 0, `${distintas} ventanas donde R2 decide distinto que la referencia`);
});

test('las MAGNITUDES coinciden dentro de la tolerancia de float32', () => {
  let peorFrac = 0;
  let peorPerclos = 0;
  for (const c of casos) {
    const r1 = r1MiradaFuera(aFloat(c.yaw));
    const r2 = r2OjosCerrados(aFloat(c.ear), c.base);

    if (c.frac !== null) {
      peorFrac = Math.max(peorFrac, Math.abs(r1.fracDesviado - c.frac));
    } else {
      assert.ok(Number.isNaN(r1.fracDesviado), 'ventana sin rostro: la referencia no define fracción');
    }
    if (c.perclos !== null) {
      peorPerclos = Math.max(peorPerclos, Math.abs(r2.perclos - c.perclos));
    }
    assert.ok(Math.abs(r1.rachaSeg - c.racha) < EPS, 'racha de R1');
    assert.ok(Math.abs(r2.microsuenoSeg - c.micro) < EPS, 'microsueño de R2');
  }
  assert.ok(peorFrac < EPS, `mayor discrepancia en frac_desviado: ${peorFrac}`);
  assert.ok(peorPerclos < EPS, `mayor discrepancia en PERCLOS: ${peorPerclos}`);
});

test('el control negativo se reproduce: R1 no se activa sobre alumnos atentos', () => {
  // Es la predicción que el protocolo declaró ANTES de correr el control:
  // "R1 no debe dispararse prácticamente nunca; si se disparara seguido, la
  // implementación estaría mal".
  const activaciones = casos.filter((c) => r1MiradaFuera(aFloat(c.yaw)).dispara).length;
  assert.equal(activaciones, 0,
    `R1 se activó en ${activaciones} de ${casos.length} ventanas de alumnos atendiendo`);
});
