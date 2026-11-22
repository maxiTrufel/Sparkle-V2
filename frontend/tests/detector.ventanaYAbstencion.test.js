// Fija la semántica de la ventana de decisión, la abstención y el umbral Y.
//
// Los tres cambian el número que el sistema reporta, así que si alguien los
// mueve sin querer, el producto deja de coincidir con lo validado en
// `Fase3_Registro_de_Resultados.md` §16 — y el fallo sería SILENCIOSO: la
// extensión seguiría mostrando porcentajes plausibles.
//
// Se replica la lógica de `predict()` en lugar de importar `detector.js`,
// porque ese módulo importa @mediapipe/tasks-vision y LiteRT.js, que no cargan
// fuera del navegador. La réplica es deliberadamente literal; si diverge del
// original, estos tests dejan de proteger nada.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const WINDOW_SIZE = 5;

/** Réplica de la parte decisoria de `predict()` en src/offscreen/detector.js. */
function crearDecisor({ threshold = 0.5, confidenceMargin = null } = {}) {
  const recent = [];
  return {
    reset() { recent.length = 0; },
    decidir(p) {
      recent.push(p);
      if (recent.length > WINDOW_SIZE) recent.shift();
      const pWindow = recent.reduce((a, b) => a + b, 0) / recent.length;
      const windowFilled = recent.length >= WINDOW_SIZE;
      const boundary = 1 - threshold;
      const confidence = Math.abs(pWindow - boundary);
      if (confidenceMargin !== null && windowFilled && confidence < confidenceMargin) {
        return { type: 'no_judgement', pInattention: pWindow, confidence, windowFilled };
      }
      const concentrationFraction = 1 - pWindow;
      return {
        type: 'prediction',
        pInattention: pWindow,
        windowFilled,
        confidence,
        inattentive: concentrationFraction <= threshold,
        concentration: Math.round(concentrationFraction * 100),
      };
    },
  };
}

// ── Umbral ───────────────────────────────────────────────────────────────────

test('Y = 0,5 sitúa la frontera de decisión en p = 0,5', () => {
  const d = crearDecisor();
  // Cinco lecturas iguales ⇒ el promedio es esa lectura.
  let r;
  for (let i = 0; i < WINDOW_SIZE; i += 1) r = d.decidir(0.49);
  assert.equal(r.inattentive, false, 'p = 0,49 debería dar atento con Y = 0,5');
  d.reset();
  for (let i = 0; i < WINDOW_SIZE; i += 1) r = d.decidir(0.51);
  assert.equal(r.inattentive, true, 'p = 0,51 debería dar desatento con Y = 0,5');
});

test('el Y anterior (0,6) marcaba desatención con el modelo inclinado a atención', () => {
  // Documenta por qué se cambió: con Y = 0,6 la frontera queda en p = 0,4, de
  // modo que p = 0,457 —donde el modelo cree MÁS probable la atención— se
  // reportaba como desatento. Caso real observado en los logs del 2026-08-01.
  const viejo = crearDecisor({ threshold: 0.6 });
  const nuevo = crearDecisor({ threshold: 0.5 });
  let rv; let rn;
  for (let i = 0; i < WINDOW_SIZE; i += 1) { rv = viejo.decidir(0.457); rn = nuevo.decidir(0.457); }
  assert.equal(rv.inattentive, true, 'con Y = 0,6 se marcaba desatento');
  assert.equal(rn.inattentive, false, 'con Y = 0,5 se marca atento');
});

test('el límite exacto cuenta como desatento (concentración == Y no alcanza)', () => {
  const d = crearDecisor({ threshold: 0.5 });
  let r;
  for (let i = 0; i < WINDOW_SIZE; i += 1) r = d.decidir(0.5);
  assert.equal(r.inattentive, true, 'concentración == Y debe ser desatento');
});

// ── Ventana ──────────────────────────────────────────────────────────────────

test('la decisión usa el PROMEDIO de la ventana, no la última lectura', () => {
  const d = crearDecisor();
  // Cuatro lecturas muy atentas y una muy desatenta: el promedio sigue siendo
  // atento aunque la última, aislada, diría desatento.
  [0.1, 0.1, 0.1, 0.1].forEach((p) => d.decidir(p));
  const r = d.decidir(0.9);
  assert.equal(r.windowFilled, true);
  assert.ok(Math.abs(r.pInattention - 0.26) < 1e-9, `promedio esperado 0,26, dio ${r.pInattention}`);
  assert.equal(r.inattentive, false, 'el promedio debería sostener "atento"');
});

test('la ventana no crece más allá de WINDOW_SIZE', () => {
  const d = crearDecisor();
  for (let i = 0; i < 20; i += 1) d.decidir(0.9);
  // Tras 20 lecturas de 0,9, cinco lecturas de 0,1 tienen que vaciar el efecto
  // de las anteriores por completo.
  let r;
  for (let i = 0; i < WINDOW_SIZE; i += 1) r = d.decidir(0.1);
  assert.ok(Math.abs(r.pInattention - 0.1) < 1e-9,
    `la ventana debería contener solo las últimas ${WINDOW_SIZE}; dio ${r.pInattention}`);
});

test('promediar probabilidades NO equivale al voto por mayoría', () => {
  // Justifica la elección del agregador: sobre validación cruzada el promedio
  // de probabilidades rindió 0,6370 contra 0,6282 del voto duro (§9.5). Este
  // caso muestra que son mecanismos distintos y no una diferencia cosmética.
  const d = crearDecisor();
  const lecturas = [0.51, 0.51, 0.51, 0.05, 0.05];   // 3 de 5 "desatento" por voto
  let r;
  lecturas.forEach((p) => { r = d.decidir(p); });
  const votoDuro = lecturas.filter((p) => p > 0.5).length > lecturas.length / 2;
  assert.equal(votoDuro, true, 'por voto por mayoría daría desatento');
  assert.equal(r.inattentive, false, 'por promedio de probabilidades da atento');
});

test('reset() vacía la ventana', () => {
  const d = crearDecisor();
  for (let i = 0; i < WINDOW_SIZE; i += 1) d.decidir(0.9);
  d.reset();
  const r = d.decidir(0.1);
  assert.equal(r.windowFilled, false);
  assert.ok(Math.abs(r.pInattention - 0.1) < 1e-9, 'tras reset no debe quedar historia');
});

// ── Abstención ───────────────────────────────────────────────────────────────

test('sin margen configurado el sistema NUNCA se abstiene', () => {
  // Comportamiento por defecto: opera a cobertura total. Es el fallo seguro —
  // peor exactitud, pero ningún juicio silenciado sin respaldo medido.
  const d = crearDecisor({ confidenceMargin: null });
  let r;
  for (let i = 0; i < WINDOW_SIZE; i += 1) r = d.decidir(0.5);
  assert.equal(r.type, 'prediction');
});

test('con margen configurado se abstiene cerca de la frontera y opina lejos', () => {
  const d = crearDecisor({ threshold: 0.5, confidenceMargin: 0.08 });
  let r;
  for (let i = 0; i < WINDOW_SIZE; i += 1) r = d.decidir(0.52);   // conf 0,02 < 0,08
  assert.equal(r.type, 'no_judgement');
  d.reset();
  for (let i = 0; i < WINDOW_SIZE; i += 1) r = d.decidir(0.80);   // conf 0,30 > 0,08
  assert.equal(r.type, 'prediction');
  assert.equal(r.inattentive, true);
});

test('la banda de abstención SIGUE a la frontera del modo activo, no a 0,5', () => {
  // Es el detalle que hace que la abstención sea correcta para cualquier Y.
  // Con Y = 0,45 la frontera está en p = 0,55: una lectura de 0,55 es la MENOS
  // confiable posible y debe abstenerse, mientras que con Y = 0,5 esa misma
  // lectura está a 0,05 de la frontera.
  const yBajo = crearDecisor({ threshold: 0.45, confidenceMargin: 0.03 });
  const yMedio = crearDecisor({ threshold: 0.5, confidenceMargin: 0.03 });
  let rb; let rm;
  for (let i = 0; i < WINDOW_SIZE; i += 1) { rb = yBajo.decidir(0.55); rm = yMedio.decidir(0.55); }
  assert.equal(rb.type, 'no_judgement', 'con Y = 0,45 la frontera es 0,55: debe abstenerse');
  assert.equal(rm.type, 'prediction', 'con Y = 0,5 la frontera es 0,5: hay confianza suficiente');
});

test('no se abstiene con la ventana incompleta', () => {
  // Abstenerse exige haber acumulado la ventana entera: antes de eso la
  // confianza se calcula sobre menos muestras y no es comparable con la
  // cobertura calibrada.
  const d = crearDecisor({ threshold: 0.5, confidenceMargin: 0.4 });
  const r = d.decidir(0.5);   // confianza 0, pero ventana incompleta
  assert.equal(r.type, 'prediction');
  assert.equal(r.windowFilled, false);
});
