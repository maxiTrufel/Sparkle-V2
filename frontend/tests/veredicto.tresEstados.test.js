// Veredicto de tres estados (`src/offscreen/veredicto.js`): un test por fila de
// la tabla, más los casos que la rodean — las reglas mandan, la ventana
// incompleta del modelo no opina y el límite exacto cuenta como desatento.
//
// Se importa el módulo real (no una réplica): `veredicto.js` no depende de
// MediaPipe ni de LiteRT, así que carga en Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideState, modelView, STATE } from '../src/offscreen/veredicto.js';

const Y = 0.5;
// pWindow es la probabilidad de DESATENCIÓN; el modelo dice "aburrido" si
// 1 − pWindow <= Y, o sea con pWindow >= 0,5.
const ABURRIDO = 0.7;
const NO_ABURRIDO = 0.3;

const base = {
  ruleFired: false, windowFilled: true, abstains: false, threshold: Y,
};

// ── Las seis filas de la tabla ───────────────────────────────────────────────

test('cara atenta + modelo no aburrido → atento', () => {
  const r = decideState({ ...base, face: 80, pWindow: NO_ABURRIDO });
  assert.equal(r.state, STATE.ATENTO);
  assert.equal(r.modelOpinion, 'no_aburrido');
  assert.equal(r.decidedBy, 'face');
});

test('cara atenta + modelo aburrido → atento_aburrimiento', () => {
  const r = decideState({ ...base, face: 80, pWindow: ABURRIDO });
  assert.equal(r.state, STATE.ATENTO_ABURRIMIENTO);
  assert.equal(r.modelOpinion, 'aburrido');
});

test('cara atenta + modelo que se abstiene → atento, sin opinión', () => {
  const r = decideState({ ...base, face: 80, pWindow: ABURRIDO, abstains: true });
  assert.equal(r.state, STATE.ATENTO);
  assert.equal(r.modelOpinion, 'sin_opinion');
});

test('cara desatenta + modelo aburrido → desatento, el modelo confirma', () => {
  const r = decideState({ ...base, face: 30, pWindow: ABURRIDO });
  assert.equal(r.state, STATE.DESATENTO);
  assert.equal(r.modelOpinion, 'confirma');
  assert.equal(r.decidedBy, 'face');
});

test('cara desatenta + modelo no aburrido → desatento igual: decide la cara', () => {
  const r = decideState({ ...base, face: 30, pWindow: NO_ABURRIDO });
  assert.equal(r.state, STATE.DESATENTO);
  assert.equal(r.modelOpinion, 'no_confirma');
});

test('cara desatenta + modelo que se abstiene → desatento, sin opinión', () => {
  const r = decideState({ ...base, face: 30, pWindow: ABURRIDO, abstains: true });
  assert.equal(r.state, STATE.DESATENTO);
  assert.equal(r.modelOpinion, 'sin_opinion');
});

// ── El modelo nunca cambia el lado atento/desatento ─────────────────────────

test('con la cara fija, ningún valor del modelo cambia atento por desatento ni al revés', () => {
  for (const face of [0, 20, 44, 50, 51, 56, 80, 100]) {
    const lados = new Set();
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const { state } = decideState({ ...base, face, pWindow: p });
      lados.add(state === STATE.DESATENTO ? 'desatento' : 'atento');
    }
    assert.equal(lados.size, 1, `con cara ${face} el modelo movió el veredicto`);
  }
});

test('la franja 44,4–55,6 del promedio viejo ya no depende del modelo', () => {
  // Con 0,9 × cara + 0,1 × modelo, cara 52 y modelo 10 % daban 47,8 → desatento.
  // Ahora decide la cara: 52 > 50 → lado atento.
  const r = decideState({ ...base, face: 52, pWindow: 0.9 });
  assert.notEqual(r.state, STATE.DESATENTO);
});

// ── Límite exacto ────────────────────────────────────────────────────────────

test('cara == Y cuenta como desatento (igualar el umbral no alcanza)', () => {
  const r = decideState({ ...base, face: 50, pWindow: NO_ABURRIDO });
  assert.equal(r.state, STATE.DESATENTO);
});

test('modelo con concentración == Y cuenta como aburrido', () => {
  assert.equal(modelView({ pWindow: 0.5, windowFilled: true, abstains: false, threshold: Y }), 'aburrido');
});

// ── Las reglas mandan ────────────────────────────────────────────────────────

test('R1 o R2 activas → desatento aunque la cara diga atenta', () => {
  const r = decideState({ ...base, face: 95, pWindow: NO_ABURRIDO, ruleFired: true });
  assert.equal(r.state, STATE.DESATENTO);
  assert.equal(r.decidedBy, 'rule');
  assert.equal(r.modelOpinion, 'no_confirma', 'el modelo se consulta igual y su opinión se registra');
});

test('con la regla activa y el modelo aburrido, el modelo confirma', () => {
  const r = decideState({ ...base, face: 95, pWindow: ABURRIDO, ruleFired: true });
  assert.equal(r.modelOpinion, 'confirma');
});

// ── Ventana incompleta del modelo ────────────────────────────────────────────

test('con la ventana de 50 s incompleta el modelo no opina: no hay tercer estado', () => {
  const r = decideState({ ...base, face: 80, pWindow: ABURRIDO, windowFilled: false });
  assert.equal(r.state, STATE.ATENTO);
  assert.equal(r.modelOpinion, 'sin_opinion');
});

test('con la ventana incompleta y la cara desatenta, sigue desatento', () => {
  const r = decideState({ ...base, face: 30, pWindow: ABURRIDO, windowFilled: false });
  assert.equal(r.state, STATE.DESATENTO);
  assert.equal(r.modelOpinion, 'sin_opinion');
});

// ── Sin valor de cara ────────────────────────────────────────────────────────

test('sin puntaje de cara → sin_veredicto', () => {
  const r = decideState({ ...base, face: null, pWindow: ABURRIDO });
  assert.equal(r.state, STATE.SIN_VEREDICTO);
  assert.equal(r.modelOpinion, null);
});

test('sin puntaje de cara pero con una regla activa → desatento (las reglas van primero)', () => {
  const r = decideState({ ...base, face: null, pWindow: ABURRIDO, ruleFired: true });
  assert.equal(r.state, STATE.DESATENTO);
});

test('una probabilidad no finita del modelo cuenta como sin opinión', () => {
  const r = decideState({ ...base, face: 80, pWindow: NaN });
  assert.equal(r.state, STATE.ATENTO);
  assert.equal(r.modelOpinion, 'sin_opinion');
});
