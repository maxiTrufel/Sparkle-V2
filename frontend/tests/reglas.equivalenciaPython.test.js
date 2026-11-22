// Equivalencia numérica con la implementación de referencia, sobre datos REALES.
//
// QUÉ FIJA ESTE TEST
// ------------------
// `reglas_referencia.json` contiene 400 ventanas de 50 s tomadas del pool de
// desarrollo de DAiSEE —las mismas sobre las que se midió la especificidad que
// la tesis reporta— con el veredicto y las magnitudes que produjo
// `entrenamiento/Fase 4/analisis/reglas_geometricas.py`.
//
// Si la versión que despacha la extensión decide distinto sobre esas ventanas,
// entonces las cifras publicadas (0 activaciones de R1 en 975 ventanas de 79
// sujetos) describen a un detector que no es el que se despacha, y dejan de ser
// evidencia sobre el producto. Este test es lo que impide que esa brecha se
// abra sin que nadie se entere.
//
// EL FIXTURE NO SE DISTRIBUYE
// ---------------------------
// El JSON no tiene imágenes, pero sí la orientación de la cabeza y la apertura
// de los ojos medidas cuadro a cuadro sobre videos de DAiSEE, y la licencia de
// DAiSEE no permite cederlas a terceros. Por eso no está en el repositorio
// (ver `entrenamiento/LEEME.md`, sección 4). Sin él, estos tests se omiten y lo
// dicen; quien tenga DAiSEE puede regenerarlo con `reglas_geometricas.py` y
// dejarlo en `tests/fixtures/` para correrlos.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { r1MiradaFuera, r2OjosCerrados } from '../src/offscreen/reglas.js';

const aqui = dirname(fileURLToPath(import.meta.url));
const rutaFixture = join(aqui, 'fixtures', 'reglas_referencia.json');
const hayFixture = existsSync(rutaFixture);
const casos = hayFixture ? JSON.parse(readFileSync(rutaFixture, 'utf8')) : [];
const conFixture = {
  skip: hayFixture
    ? false
    : 'falta tests/fixtures/reglas_referencia.json (medidas de DAiSEE, no se distribuye por licencia)',
};

/** `null` en el JSON representa un cuadro sin rostro (NaN en Python). */
const aFloat = (arr) => Float32Array.from(arr, (v) => (v === null ? NaN : v));

// Tolerancia de coma flotante entre float64 (numpy) y float32 (los buffers de
// la extensión). Las decisiones se comparan de forma EXACTA; sólo las
// magnitudes continuas admiten esta holgura.
const EPS = 1e-6;

test('el fixture de referencia está presente y es sustantivo', conFixture, () => {
  assert.ok(Array.isArray(casos));
  assert.ok(casos.length >= 400, `se esperaban >= 400 ventanas, hay ${casos.length}`);
  assert.ok(casos.every((c) => c.yaw.length === 300 && c.ear.length === 300),
    'cada ventana son 300 cuadros = 50 s a 6 fps');
});

test('las DECISIONES de R1 coinciden con la referencia en las 400 ventanas', conFixture, () => {
  // La referencia se generó con la fracción original de 0,30. La Enmienda 9
  // (2026-09-27) subió la del producto a 0,50; la equivalencia de la
  // IMPLEMENTACIÓN se verifica con el parámetro de la referencia.
  let distintas = 0;
  for (const c of casos) {
    const r = r1MiradaFuera(aFloat(c.yaw), { frac: 0.30 });
    if (r.dispara !== c.R1) distintas += 1;
  }
  assert.equal(distintas, 0, `${distintas} ventanas donde R1 decide distinto que la referencia`);
});

test('las DECISIONES de R2 coinciden con la referencia en las 400 ventanas', conFixture, () => {
  let distintas = 0;
  for (const c of casos) {
    // La referencia busca el microsueño en la ventana entera; desde la
    // Enmienda 10 el producto lo busca sólo en los últimos 10 s.
    const r = r2OjosCerrados(aFloat(c.ear), c.base, { microVentanaSeg: Infinity });
    if (r.dispara !== c.R2) distintas += 1;
  }
  assert.equal(distintas, 0, `${distintas} ventanas donde R2 decide distinto que la referencia`);
});

test('las MAGNITUDES coinciden dentro de la tolerancia de float32', conFixture, () => {
  let peorFrac = 0;
  let peorPerclos = 0;
  for (const c of casos) {
    const r1 = r1MiradaFuera(aFloat(c.yaw));
    const r2 = r2OjosCerrados(aFloat(c.ear), c.base, { microVentanaSeg: Infinity });

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

test('el control negativo se reproduce: R1 no se activa sobre alumnos atentos', conFixture, () => {
  // Es la predicción que el protocolo declaró ANTES de correr el control:
  // "R1 no debe dispararse prácticamente nunca; si se disparara seguido, la
  // implementación estaría mal".
  const activaciones = casos.filter((c) => r1MiradaFuera(aFloat(c.yaw)).dispara).length;
  assert.equal(activaciones, 0,
    `R1 se activó en ${activaciones} de ${casos.length} ventanas de alumnos atendiendo`);
});

test('R2 del producto (microsueño en 10 s) nunca se activa donde no se activaba la referencia', conFixture, () => {
  // Por qué la especificidad de R2 medida antes sigue valiendo tras la
  // Enmienda 10: buscar el microsueño en menos tiempo sólo puede apagar
  // activaciones.
  for (const c of casos) {
    const nueva = r2OjosCerrados(aFloat(c.ear), c.base).dispara;
    assert.ok(!nueva || c.R2, 'R2 del producto se activó en una ventana donde la referencia no');
  }
});

test('con la fracción del producto (0,50) R1 nunca se activa donde no se activaba con 0,30', conFixture, () => {
  // Por qué la especificidad medida con 0,30 sigue valiendo tras la Enmienda 9:
  // exigir una fracción mayor sólo puede apagar activaciones, nunca crearlas.
  for (const c of casos) {
    const nueva = r1MiradaFuera(aFloat(c.yaw)).dispara;
    const vieja = r1MiradaFuera(aFloat(c.yaw), { frac: 0.30 }).dispara;
    assert.ok(!nueva || vieja, 'R1 al 0,50 se activó en una ventana donde al 0,30 no');
  }
});
