// Fija la convención de lectura de la matriz de transformación facial.
//
// `yaw` y `pitch` son 2 de las 22 features geométricas. Si el port a JavaScript
// lee la matriz con una convención distinta a la del pipeline de Python que
// generó el dataset de entrenamiento, esas dos features quedan mal EN
// PRODUCCIÓN sin emitir ningún error: el modelo devuelve números plausibles y
// pierde exactitud en silencio. Es la misma clase de fallo que ya apareció tres
// veces en este proyecto (orden de salidas en TFLite, copia de pesos por
// nombre, arquitectura del modelo de export).
//
// El criterio NO es la corrección geométrica sino la CONSISTENCIA con Python:
// el modelo se entrenó con los valores que produjo aquel pipeline.
//
// Verificado empíricamente el 2026-08-01 sobre una imagen real
// (ver VERIFICAR_yaw_pitch.md). MediaPipe Python devuelve
// `facial_transformation_matrixes[0]` como la matriz ESTÁNDAR: traslación en la
// última columna y última fila [0,0,0,1]. El notebook de extracción lee
// rot[2,0], rot[2,1], rot[2,2] con indexación [fila][columna].
//
// MediaPipe Web entrega `data` en orden COLUMN-MAJOR, de modo que el elemento
// (fila i, columna j) es data[j*4 + i]. Con ese acceso ambos lenguajes leen los
// mismos elementos, que es lo que este test fija.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Matriz REAL obtenida de MediaPipe Python sobre una imagen con rostro.
// Los valores de referencia de yaw/pitch salen del mismo run.
const M_PYTHON = [
  [0.9985, -0.0263, -0.0483, -0.3826],
  [0.0356, 0.9782, 0.2048, -6.0262],
  [0.0419, -0.2062, 0.9776, -34.3898],
  [0, 0, 0, 1],
];
const YAW_PYTHON = -2.4006;
const PITCH_PYTHON = -11.9104;

function serializar(M, orden) {
  const data = new Array(16);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      data[orden === 'column-major' ? c * 4 + r : r * 4 + c] = M[r][c];
    }
  }
  return data;
}

// Réplica exacta de `eulerFromMatrix` de src/offscreen/features.js.
// Se duplica en lugar de importarse porque el módulo real importa
// @mediapipe/tasks-vision, que no carga fuera del navegador.
function eulerFromMatrix(matrixData) {
  const at = (row, col) => matrixData[col * 4 + row];
  const r00 = at(0, 0);
  const r10 = at(1, 0);
  const r20 = at(2, 0);
  const r21 = at(2, 1);
  const r22 = at(2, 2);
  const r11 = at(1, 1);
  const r12 = at(1, 2);
  const sy = Math.hypot(r00, r10);
  const singular = sy < 1e-6;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const pitch = singular ? toDeg(Math.atan2(-r12, r11)) : toDeg(Math.atan2(r21, r22));
  const yaw = toDeg(Math.atan2(-r20, sy));
  return { yaw, pitch };
}

// Réplica de `verificarLayoutMatriz`: devuelve el layout detectado.
function detectarLayout(matrixData) {
  const mag = (...idx) => Math.max(...idx.map((i) => Math.abs(matrixData[i])));
  return mag(12, 13, 14) >= mag(3, 7, 11) ? 'column-major' : 'row-major';
}

test('con data column-major, el acceso reproduce los elementos de Python', () => {
  const data = serializar(M_PYTHON, 'column-major');
  const at = (row, col) => data[col * 4 + row];
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      assert.equal(at(r, c), M_PYTHON[r][c], `elemento (${r},${c}) no coincide con Python`);
    }
  }
});

test('con data column-major, yaw y pitch coinciden con los de Python', () => {
  const { yaw, pitch } = eulerFromMatrix(serializar(M_PYTHON, 'column-major'));
  assert.ok(Math.abs(yaw - YAW_PYTHON) < 0.01, `yaw ${yaw} != ${YAW_PYTHON}`);
  assert.ok(Math.abs(pitch - PITCH_PYTHON) < 0.01, `pitch ${pitch} != ${PITCH_PYTHON}`);
});

test('leer la transpuesta produce ángulos DISTINTOS — el error no es inocuo', () => {
  // Si `data` viniera row-major y se leyera con el acceso column-major, se
  // estaría leyendo la transpuesta. Este test documenta que el error importa:
  // si los ángulos coincidieran igual, la verificación no tendría sentido.
  const { yaw, pitch } = eulerFromMatrix(serializar(M_PYTHON, 'row-major'));
  assert.ok(
    Math.abs(yaw - YAW_PYTHON) > 0.5 || Math.abs(pitch - PITCH_PYTHON) > 0.5,
    'la transpuesta debería dar ángulos distintos; si no, revisar el test',
  );
});

test('detectarLayout distingue ambos órdenes por dónde cae la traslación', () => {
  assert.equal(detectarLayout(serializar(M_PYTHON, 'column-major')), 'column-major');
  assert.equal(detectarLayout(serializar(M_PYTHON, 'row-major')), 'row-major');
});

test('la matriz de referencia de Python es la estándar (traslación en la última columna)', () => {
  // Documenta la evidencia sobre la que se apoya toda la convención.
  const ultimaColumna = [M_PYTHON[0][3], M_PYTHON[1][3], M_PYTHON[2][3]];
  const ultimaFila = [M_PYTHON[3][0], M_PYTHON[3][1], M_PYTHON[3][2]];
  const maxAbs = (a) => Math.max(...a.map(Math.abs));
  assert.ok(maxAbs(ultimaColumna) > 1, 'la traslación debería estar en la última columna');
  assert.equal(maxAbs(ultimaFila), 0, 'la última fila debería ser [0,0,0,1]');
});
