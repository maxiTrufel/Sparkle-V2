// Todo tipo de mensaje que emite el detector tiene que tener una rama que lo
// atienda en el hook que sostiene el estado del alumno.
//
// EL BUG QUE ESTE TEST EXISTE PARA IMPEDIR
// ---------------------------------------
// `detector.js` puede devolver `type: 'no_judgement'` cuando el modelo se
// abstiene. `useAttentionDetection.js` tenía ramas para `no_face`, `rule` y
// `prediction`, pero NO para `no_judgement`: el mensaje llegaba, ninguna
// condición lo tomaba, y el estado **conservaba el último valor**.
//
// Como el modelo se abstiene en rachas largas —se midieron 30 seguidas en una
// sesión real—, una sola predicción `desatento` quedaba clavada en pantalla
// durante minutos. La única forma de destrabarlo era tapar la cámara, porque
// `no_face` era la otra única rama que escribía estado.
//
// Fallaba en silencio por partida doble: no había error, y además anulaba en la
// práctica el mecanismo de abstención que el trabajo reporta y defiende — se
// decidía en el detector y se descartaba en la interfaz.
//
// POR QUÉ ES ESTRUCTURAL Y NO UN CASO DE PRUEBA
// --------------------------------------------
// Un test del caso puntual habría atrapado este bug. Este atrapa **el
// siguiente**: cualquier tipo nuevo que se agregue al detector sin su rama
// correspondiente rompe acá, sin que nadie tenga que acordarse de escribir la
// prueba. Corre en milisegundos y no necesita jsdom.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const src = join(aqui, '..', 'src');

const detector = readFileSync(join(src, 'offscreen', 'detector.js'), 'utf8');
const hook = readFileSync(join(src, 'hooks', 'useAttentionDetection.js'), 'utf8');
const main = readFileSync(join(src, 'offscreen', 'main.js'), 'utf8');

/** Tipos que `predict()` puede devolver: `type: 'algo'` en un objeto retornado. */
function tiposQueEmiteElDetector(fuente) {
  return new Set([...fuente.matchAll(/^\s*type:\s*'([a-z_]+)'/gm)].map((m) => m[1]));
}

/** Tipos que una fuente atiende: `X.type === 'algo'`. */
function tiposQueAtiende(fuente) {
  return new Set([...fuente.matchAll(/\.type\s*===\s*'([a-z_]+)'/g)].map((m) => m[1]));
}

const emitidos = tiposQueEmiteElDetector(detector);

test('el detector emite los cuatro tipos conocidos', () => {
  // Si esto falla es porque se agregó o renombró un tipo. No es un error en sí,
  // pero obliga a revisar los dos tests de abajo antes de seguir.
  assert.deepEqual(
    [...emitidos].sort(),
    ['no_face', 'no_judgement', 'prediction', 'rule'],
    'cambió el conjunto de tipos que emite el detector',
  );
});

test('el hook del alumno atiende TODOS los tipos que emite el detector', () => {
  const atendidos = tiposQueAtiende(hook);
  const huerfanos = [...emitidos].filter((t) => !atendidos.has(t));
  assert.deepEqual(
    huerfanos, [],
    `tipos sin rama en useAttentionDetection.js: ${huerfanos.join(', ')}. `
    + 'Un tipo sin rama NO da error: deja el estado anterior pegado en pantalla.',
  );
});

test('el despachador de offscreen loguea TODOS los tipos', () => {
  // Menos grave que lo anterior —solo afecta a la auditabilidad— pero es
  // justamente el log con el que se depura una sesión de grabación.
  const logueados = tiposQueAtiende(main);
  const huerfanos = [...emitidos].filter((t) => !logueados.has(t));
  assert.deepEqual(
    huerfanos, [],
    `tipos que no se loguean en offscreen/main.js: ${huerfanos.join(', ')}`,
  );
});

test('la abstención no deja el veredicto anterior pegado', () => {
  // La rama tiene que fijar `inattentive` explícitamente, no heredarlo del
  // spread `...prev`. Es el mismo defecto que ya se había corregido para
  // `no_face` y que volvió a aparecer acá.
  const rama = hook.slice(hook.indexOf("p.type === 'no_judgement'"), hook.indexOf("p.type === 'prediction'"));
  assert.ok(rama.length > 0, 'no se encontró la rama de no_judgement');
  assert.match(rama, /inattentive:/, 'la rama debe fijar `inattentive` explícitamente');
  // Sin opinión del modelo, `concentration` es el puntaje de cara que manda el
  // detector, o `null` si no lo hay: el hook no inventa ningún número.
  assert.match(rama, /const faceOnly = p\.concentration \?\? null;/, '`concentration` no se inventa cuando el modelo se abstiene');
  assert.match(rama, /concentration:\s*faceOnly/, '`concentration` no se inventa cuando el modelo se abstiene');
  assert.match(rama, /lastUpdated:/, 'sin actualizar `lastUpdated` el docente nunca se entera');
});

test('nunca viaja `inattentive: null` al docente', () => {
  // El contrato declarado en useAttentionBroadcast.js es que ese campo jamás es
  // null de ahí en adelante, y el panel del docente lo asume. La abstención
  // previa a que las reglas se evalúen es el único caso que podría violarlo.
  const broadcast = readFileSync(join(src, 'hooks', 'useAttentionBroadcast.js'), 'utf8');
  assert.match(
    broadcast,
    /attention\.inattentive\s*==\s*null[\s\S]{0,40}return/,
    'falta el guard que impide emitir un snapshot sin veredicto',
  );
});
