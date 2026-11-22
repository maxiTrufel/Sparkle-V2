// Fija la semántica de la ventana de decisión: 5 muestras SEPARADAS 10 s.
//
// EL ERROR QUE ESTE TEST PREVIENE
// -------------------------------
// El detector emite una predicción cada 2 s, pero cada una se calcula sobre un
// buffer de features de 10 s. Promediar las últimas 5 predicciones consecutivas
// parece correcto y no lo es: cubre 18 s de video con 80 % de cuadros
// compartidos entre pares consecutivos, mientras que el modelo se validó sobre
// 5 clips de 10 s NO SOLAPADOS (50 s de video distinto). El promedio de
// muestras correlacionadas reduce mucho menos la varianza, así que el 76,1 %
// reportado no aplicaría.
//
// Ese error estuvo efectivamente en el código el 2026-08-02 y se detectó
// mirando los timestamps de los logs, no los tests. De ahí este archivo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSpacedSamples, pruneBuffer, aggregateWindow } from '../src/offscreen/aggregation.js';

const SPAN = 10000;   // CLIP_SPAN_MS
const SIZE = 5;       // WINDOW_SIZE

/** Buffer con predicciones cada `everyMs`, terminando en `endTs`. */
function buffer(n, everyMs, endTs = 100000, pFn = () => 0.5) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push({ ts: endTs - i * everyMs, p: pFn(i) });
  return out;
}

test('con predicciones cada 2 s, la ventana toma muestras separadas 10 s', () => {
  const buf = buffer(30, 2000);            // 60 s de historia
  const sel = selectSpacedSamples(buf, SIZE, SPAN);
  assert.equal(sel.length, SIZE);
  for (let i = 0; i < sel.length - 1; i += 1) {
    const gap = sel[i].ts - sel[i + 1].ts;
    assert.ok(gap >= SPAN, `muestras ${i} y ${i + 1} separadas ${gap} ms, se exigen ${SPAN}`);
  }
});

test('la ventana cubre 50 s, no 18 s', () => {
  const buf = buffer(30, 2000);
  const { spanMs, filled } = aggregateWindow(buf, SIZE, SPAN);
  assert.equal(filled, true);
  assert.equal(spanMs, SIZE * SPAN, `la ventana debería cubrir ${SIZE * SPAN} ms y cubre ${spanMs}`);
});

test('tomar las últimas 5 consecutivas daría 18 s — el error que se previene', () => {
  // Control explícito: documenta la diferencia entre ambos criterios.
  const buf = buffer(30, 2000);
  const ultimas5 = buf.slice(-SIZE);
  const spanIngenuo = ultimas5[SIZE - 1].ts - ultimas5[0].ts + SPAN;
  assert.equal(spanIngenuo, 18000);
  const { spanMs } = aggregateWindow(buf, SIZE, SPAN);
  assert.ok(spanMs > spanIngenuo * 2, 'la ventana correcta cubre bastante más que la ingenua');
});

test('el promedio usa las muestras espaciadas, no las consecutivas', () => {
  // Las más recientes valen 1 y las viejas 0. Con muestras espaciadas cada 10 s
  // se toman índices muy distintos que con las últimas 5 consecutivas.
  const buf = [];
  for (let i = 0; i < 26; i += 1) buf.push({ ts: 1000 + i * 2000, p: i >= 21 ? 1 : 0 });
  const { p } = aggregateWindow(buf, SIZE, SPAN);
  const pIngenuo = buf.slice(-SIZE).reduce((s, it) => s + it.p, 0) / SIZE;
  assert.equal(pIngenuo, 1, 'las últimas 5 consecutivas son todas 1');
  assert.ok(p < 1, `el promedio espaciado debería incluir muestras viejas; dio ${p}`);
  assert.ok(Math.abs(p - 0.2) < 1e-9, `se esperaba 0,2 (1 de 5 muestras vale 1); dio ${p}`);
});

test('sin historia suficiente la ventana queda incompleta', () => {
  const buf = buffer(6, 2000, 12000);      // solo 12 s de historia
  const { samples, filled } = aggregateWindow(buf, SIZE, SPAN);
  assert.ok(samples < SIZE, `con 12 s no se pueden juntar ${SIZE} muestras de 10 s`);
  assert.equal(filled, false);
});

test('con una sola predicción el promedio es esa predicción', () => {
  const { p, samples, filled, spanMs } = aggregateWindow([{ ts: 1000, p: 0.73 }], SIZE, SPAN);
  assert.equal(p, 0.73);
  assert.equal(samples, 1);
  assert.equal(filled, false);
  assert.equal(spanMs, SPAN);
});

test('buffer vacío no rompe', () => {
  const r = aggregateWindow([], SIZE, SPAN);
  assert.equal(r.samples, 0);
  assert.equal(r.filled, false);
  assert.ok(Number.isNaN(r.p));
});

test('pruneBuffer conserva lo necesario para una ventana completa', () => {
  const buf = buffer(60, 2000, 120000);    // 120 s de historia
  pruneBuffer(buf, 120000, SIZE, SPAN);
  const { filled, samples } = aggregateWindow(buf, SIZE, SPAN);
  assert.equal(filled, true, `tras podar quedaron ${samples} muestras y hacen falta ${SIZE}`);
  assert.ok(buf.length < 60, 'debería haber descartado historia inútil');
});

test('pruneBuffer no vacía el buffer cuando hay poca historia', () => {
  const buf = buffer(3, 2000, 6000);
  pruneBuffer(buf, 6000, SIZE, SPAN);
  assert.equal(buf.length, 3);
});

test('un intervalo de predicción mayor al span no rompe el espaciado', () => {
  // Si alguien configura X = 15 s, cada predicción ya es no solapada y la
  // ventana debe tomarlas todas.
  const buf = buffer(10, 15000, 150000);
  const sel = selectSpacedSamples(buf, SIZE, SPAN);
  assert.equal(sel.length, SIZE);
  for (let i = 0; i < sel.length - 1; i += 1) {
    assert.equal(sel[i].ts - sel[i + 1].ts, 15000);
  }
});
