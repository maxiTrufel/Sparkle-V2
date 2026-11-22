// Equivalencia de R1 y R2 con la implementación de referencia en Python
// (`Tesis-Vision-Artificial/Fase 4/analisis/reglas_geometricas.py`).
//
// POR QUÉ ESTE TEST IMPORTA MÁS QUE UN TEST DE UNIDAD CORRIENTE
// ------------------------------------------------------------
// Con esa implementación se midió la especificidad que la tesis reporta: 0
// activaciones de R1 sobre 975 ventanas de 79 sujetos (DAiSEE) y 0 sobre 842
// clips de 11 sujetos (EngageNet). Si la versión que corre en la extensión
// decide distinto, esa evidencia deja de aplicar al producto: se estaría
// reportando el desempeño de un detector que no es el que se despacha.
//
// Los casos de borde son los que la referencia define de forma no obvia:
//   - la FRACCIÓN se calcula sobre los cuadros FINITOS (los cuadros sin rostro
//     no cuentan ni a favor ni en contra);
//   - la RACHA se cuenta sobre la ventana completa, así que un tramo sin rostro
//     la corta en lugar de prolongarla;
//   - el disparo es ESTRICTO (`> 0,30`), no `>=`.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  r1MiradaFuera, r2OjosCerrados, evaluar, rachaMax, medianaFinita,
  YAW_GRADOS, FRAC_VENTANA, PERCLOS_UMBRAL, MICROSUENO_SEG, MICROSUENO_VENTANA_SEG, FPS,
} from '../src/offscreen/reglas.js';

/** Ventana de `n` cuadros con `k` desviados al principio. */
function ventanaYaw(n, k, grados = 30) {
  return Float32Array.from({ length: n }, (_, i) => (i < k ? grados : 0));
}

test('los umbrales congelados son los del protocolo', () => {
  assert.equal(YAW_GRADOS, 20.0);
  assert.equal(FRAC_VENTANA, 0.50);   // Enmienda 9 (2026-09-27); antes 0,30
  assert.equal(PERCLOS_UMBRAL, 0.15);
  assert.equal(MICROSUENO_SEG, 2.0);
  assert.equal(FPS, 6.0);
});

test('rachaMax cuenta la corrida contigua más larga', () => {
  assert.equal(rachaMax([0, 1, 1, 0, 1, 1, 1, 0]), 3);
  assert.equal(rachaMax([0, 0, 0]), 0);
  assert.equal(rachaMax([1, 1, 1]), 3);
  assert.equal(rachaMax([]), 0);
});

test('medianaFinita ignora NaN y promedia en longitud par', () => {
  assert.equal(medianaFinita([1, 2, 3]), 2);
  assert.equal(medianaFinita([1, NaN, 3, 5]), 3);
  assert.equal(medianaFinita([2, 4]), 3);
  assert.ok(Number.isNaN(medianaFinita([NaN, NaN])));
});

// ── R1 ──────────────────────────────────────────────────────────────────────

test('R1 no se activa con la cabeza al frente', () => {
  const r = r1MiradaFuera(ventanaYaw(300, 0));
  assert.equal(r.dispara, false);
  assert.equal(r.fracDesviado, 0);
});

test('R1 se activa por encima de 0,50 y no en 0,50 exacto', () => {
  // 150/300 = 0,50 exacto: NO dispara (el criterio es estricto).
  const justo = r1MiradaFuera(ventanaYaw(300, 150));
  assert.equal(justo.fracDesviado, 0.50);
  assert.equal(justo.dispara, false);

  // 151/300 > 0,50: dispara.
  assert.equal(r1MiradaFuera(ventanaYaw(300, 151)).dispara, true);
});

test('R1 ya no se activa con un tercio de la ventana desviada (lo que antes sí)', () => {
  // 100/300 ≈ 0,33: con la fracción original (0,30) disparaba.
  assert.equal(r1MiradaFuera(ventanaYaw(300, 100)).dispara, false);
  assert.equal(r1MiradaFuera(ventanaYaw(300, 100), { frac: 0.30 }).dispara, true);
});

test('R1 usa 20° como umbral por cuadro, sin ambigüedad en el borde', () => {
  const enBorde = Float32Array.from({ length: 300 }, () => 20.0);   // no supera
  assert.equal(r1MiradaFuera(enBorde).fracDesviado, 0);

  const apenasArriba = Float32Array.from({ length: 300 }, () => 20.01);
  assert.equal(r1MiradaFuera(apenasArriba).fracDesviado, 1);
});

test('R1 es simétrica: da igual a qué lado se gire la cabeza', () => {
  const izq = r1MiradaFuera(ventanaYaw(300, 200, -35));
  const der = r1MiradaFuera(ventanaYaw(300, 200, 35));
  assert.equal(izq.dispara, der.dispara);
  assert.equal(izq.fracDesviado, der.fracDesviado);
});

test('R1: la fracción se calcula sobre cuadros FINITOS', () => {
  // 120 desviados, 80 al frente, 100 sin rostro.
  // La referencia divide por 200 (los finitos), no por 300 → 0,60 y dispara
  // (sobre 300 daría 0,40 y no dispararía).
  const yaw = Float32Array.from({ length: 300 }, (_, i) => {
    if (i < 120) return 35;
    if (i < 200) return 0;
    return NaN;
  });
  const r = r1MiradaFuera(yaw);
  assert.equal(r.cuadros, 200);
  assert.equal(r.fracDesviado, 0.6);
  assert.equal(r.dispara, true);
});

test('R1 sin ningún cuadro con rostro no se activa y no inventa un número', () => {
  const r = r1MiradaFuera(new Float32Array(300).fill(NaN));
  assert.equal(r.dispara, false);
  assert.ok(Number.isNaN(r.fracDesviado));
  assert.equal(r.cuadros, 0);
});

test('R1: la racha se corta con los cuadros sin rostro, no se prolonga', () => {
  // 12 desviados, 1 sin rostro, 12 desviados → dos rachas de 12, no una de 25.
  const yaw = Float32Array.from({ length: 300 }, (_, i) => {
    if (i < 12) return 35;
    if (i === 12) return NaN;
    if (i < 25) return 35;
    return 0;
  });
  assert.equal(r1MiradaFuera(yaw).rachaSeg, 12 / FPS);
});

test('R1 reporta la racha en segundos a 6 fps', () => {
  // 90 cuadros seguidos desviados = 15 s, la duración mínima que la curva
  // operativa establece como detectable para giros de 30° o más.
  assert.equal(r1MiradaFuera(ventanaYaw(300, 90)).rachaSeg, 15);
});

// ── R2 ──────────────────────────────────────────────────────────────────────

const EAR_ABIERTO = 0.30;

test('R2 no se activa con los ojos abiertos', () => {
  const ear = new Float32Array(300).fill(EAR_ABIERTO);
  const r = r2OjosCerrados(ear, EAR_ABIERTO);
  assert.equal(r.dispara, false);
  assert.equal(r.perclos, 0);
});

test('R2 usa la línea base del sujeto, no un umbral absoluto de EAR', () => {
  // El mismo EAR es "abierto" para un sujeto y "cerrado" para otro: la razón
  // entre la apertura mediana del más abierto y el más cerrado es 2,07.
  const ear = new Float32Array(300).fill(0.10);
  // Sujeto de ojo chico (base 0,165): 0,10 > 0,30*0,165 = 0,0495 → abierto.
  assert.equal(r2OjosCerrados(ear, 0.165).perclos, 0);
  // Sujeto de ojo grande (base 0,341): 0,10 < 0,30*0,341 = 0,1023 → cerrado.
  assert.equal(r2OjosCerrados(ear, 0.341).perclos, 1);
});

test('R2 se activa por PERCLOS por encima de 0,15, no en 0,15 exacto', () => {
  const cerrado = 0.30 * EAR_ABIERTO * 0.5;
  const conCerrados = (k) => {
    const ear = new Float32Array(300).fill(EAR_ABIERTO);
    // Alterna para que ninguna racha llegue a los 2 s y aísle el criterio de
    // PERCLOS del de microsueño.
    for (let i = 0, puestos = 0; i < 300 && puestos < k; i += 2, puestos += 1) {
      ear[i] = cerrado;
    }
    return r2OjosCerrados(ear, EAR_ABIERTO);
  };

  const justo = conCerrados(45);          // 45/300 = 0,15 exacto
  assert.equal(justo.perclos, 0.15);
  assert.equal(justo.dispara, false);

  assert.equal(conCerrados(46).dispara, true);
});

test('R2 se activa por microsueño de 2 s aunque el PERCLOS sea bajo', () => {
  const ear = new Float32Array(300).fill(EAR_ABIERTO);
  // 12 cuadros seguidos = 2,0 s exactos, dentro de los últimos 10 s. El
  // criterio es `>=`, así que dispara.
  for (let i = 288; i < 300; i += 1) ear[i] = 0.30 * EAR_ABIERTO * 0.5;
  const r = r2OjosCerrados(ear, EAR_ABIERTO);
  assert.equal(r.microsuenoSeg, 2);
  assert.ok(r.perclos < PERCLOS_UMBRAL, 'el PERCLOS solo no alcanzaría');
  assert.equal(r.dispara, true);
});

test('un microsueño de hace más de 10 s ya no mantiene activa a R2 (Enmienda 10)', () => {
  const ear = new Float32Array(300).fill(EAR_ABIERTO);
  // El mismo cierre de 2 s, pero al principio de la ventana: hace ~48 s.
  for (let i = 0; i < 12; i += 1) ear[i] = 0.30 * EAR_ABIERTO * 0.5;
  const r = r2OjosCerrados(ear, EAR_ABIERTO);
  assert.equal(r.microsuenoSeg, 0);
  assert.equal(r.dispara, false);
  // Buscado en la ventana entera (el criterio anterior) sí disparaba.
  assert.equal(r2OjosCerrados(ear, EAR_ABIERTO, { microVentanaSeg: Infinity }).dispara, true);
});

test('el microsueño se busca en los últimos 60 cuadros (10 s a 6 fps)', () => {
  assert.equal(MICROSUENO_VENTANA_SEG, 10);
  const ear = new Float32Array(300).fill(EAR_ABIERTO);
  // Cierre que termina justo antes de los últimos 60 cuadros: no cuenta.
  for (let i = 228; i < 240; i += 1) ear[i] = 0.30 * EAR_ABIERTO * 0.5;
  assert.equal(r2OjosCerrados(ear, EAR_ABIERTO).dispara, false);
  // El mismo cierre, empezando en el primero de los últimos 60 cuadros: cuenta entero.
  ear.fill(EAR_ABIERTO);
  for (let i = 240; i < 252; i += 1) ear[i] = 0.30 * EAR_ABIERTO * 0.5;
  assert.equal(r2OjosCerrados(ear, EAR_ABIERTO).dispara, true);
});

test('R2 con línea base inválida no se activa', () => {
  const ear = new Float32Array(300).fill(0.01);
  assert.equal(r2OjosCerrados(ear, 0).dispara, false);
  assert.equal(r2OjosCerrados(ear, -1).dispara, false);
  assert.equal(r2OjosCerrados(ear, NaN).dispara, false);
});

test('R2 sin línea base cae a la mediana de la ventana', () => {
  const ear = new Float32Array(300).fill(EAR_ABIERTO);
  const r = r2OjosCerrados(ear, null);
  assert.equal(r.perclos, 0);
});

// ── Fusión ──────────────────────────────────────────────────────────────────

test('evaluar declara la fuente de la activación', () => {
  const abierto = new Float32Array(300).fill(EAR_ABIERTO);

  const soloR1 = evaluar(ventanaYaw(300, 200), abierto, EAR_ABIERTO);
  assert.equal(soloR1.dispara, true);
  assert.equal(soloR1.fuente, 'R1');

  const cerrado = new Float32Array(300).fill(0.30 * EAR_ABIERTO * 0.5);
  const soloR2 = evaluar(ventanaYaw(300, 0), cerrado, EAR_ABIERTO);
  assert.equal(soloR2.dispara, true);
  assert.equal(soloR2.fuente, 'R2');

  const ninguna = evaluar(ventanaYaw(300, 0), abierto, EAR_ABIERTO);
  assert.equal(ninguna.dispara, false);
  assert.equal(ninguna.fuente, null);
});

test('con ambas activas se etiqueta R1 pero se conservan las dos', () => {
  const cerrado = new Float32Array(300).fill(0.30 * EAR_ABIERTO * 0.5);
  const r = evaluar(ventanaYaw(300, 200), cerrado, EAR_ABIERTO);
  assert.equal(r.fuente, 'R1');
  assert.equal(r.R1.dispara, true);
  assert.equal(r.R2.dispara, true);
});

// ── Especificidad: el control negativo, en miniatura ────────────────────────

test('un alumno atento no activa ninguna regla pese al movimiento natural', () => {
  // `frac_desviado` medio medido sobre sujetos atentos: 0,0011 en EngageNet y
  // 0,0022 en DAiSEE, contra un umbral de 0,50 (0,30 antes de la Enmienda 9) — dos órdenes de magnitud.
  // Acá se simula movimiento natural de cabeza con desvío de 8°, el caso más
  // agitado que la curva operativa contempla.
  let semilla = 42;
  const rnd = () => {
    semilla = (semilla * 1103515245 + 12345) & 0x7fffffff;
    return semilla / 0x7fffffff;
  };
  const yaw = Float32Array.from({ length: 300 }, () => {
    // Box-Muller sencillo, desvío 8°.
    const u = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()) * 8;
  });
  const ear = Float32Array.from({ length: 300 }, () => EAR_ABIERTO * (0.95 + 0.1 * rnd()));

  const r = evaluar(yaw, ear, EAR_ABIERTO);
  assert.equal(r.dispara, false, 'una regla que se activa con un alumno atento destruye la confianza del docente');
});
