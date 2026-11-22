// Ningún consumidor del estado de atención puede asumir que un campo opcional
// venga siempre poblado.
//
// EL BUG QUE ESTE TEST EXISTE PARA IMPEDIR
// ---------------------------------------
// `CameraPreviewBox` decidía renderizar con
//
//     const measuring = attention.phase === 'active' && attention.concentration !== null;
//
// y dentro hacía `attention.pInattention.toFixed(3)`. Es decir: asumía que si
// hay `concentration`, hay `pInattention`.
//
// Ese supuesto se rompió al implementar las reglas geométricas. Cuando R1 o R2
// se activan, el modelo NO SE CONSULTA —la regla tiene prioridad y `predict()`
// devuelve antes de la inferencia—, de modo que el estado queda con
// `concentration: 0` (un número) y `pInattention: null`.
//
// LA CADENA COMPLETA, porque el síntoma no se parecía en nada a la causa:
//
//   regla se activa
//     -> `null.toFixed(3)` durante el render
//     -> excepción no atrapada, y NO hay Error Boundary en el árbol
//     -> React desmonta TODO `App`
//     -> el cleanup de `useLiveClass` llama `leaveRoom()` -> `.close()` sin args
//     -> el WebSocket cierra con `code=1005`
//     -> el backend finaliza la clase por "desconexión del docente"
//
// Se manifestaba como cortes de clase que parecían de red o de suspensión de la
// máquina. Cuatro en dos horas de prueba. Mismo encadenamiento que documenta
// `App.regresionCrashModoAtencion.test.js` para otra causa raíz.
//
// POR QUÉ SE TESTEA ASÍ
// ---------------------
// Montar el árbol de React con jsdom para esto es caro y flaky. Lo que hay que
// fijar es más simple y más general: **ningún acceso directo a un campo
// anulable del estado de atención**. Un `.toFixed()` sin guarda es la firma
// exacta del defecto, y detectarla es barato.

// CONVENCIÓN QUE ESTE TEST IMPONE: para usar un campo anulable, ligarlo primero
// a un local y recién después usarlo. `const p = attention.pInattention;` tras
// la guarda es seguro por construcción; `attention.pInattention.toFixed()` con
// un `if` diez líneas más arriba depende de que el próximo que edite el archivo
// recuerde que ese `if` existe.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const src = join(aqui, '..', 'src');

// Campos del estado de atención que PUEDEN venir en `null`, y por qué.
const ANULABLES = {
  pInattention: 'null cuando decide una regla (el modelo no se consulta) y en no_face',
  concentration: 'null cuando el modelo se abstiene y en no_face',
  inattentive: 'null cuando ninguna capa tiene todavía una afirmación',
  threshold: 'null antes de la primera configuración',
  noFaceFraction: 'null fuera de una ventana evaluada',
  dinamica: 'null cuando decide una regla y en no_face',
  windowFilled: 'null cuando no aplica la ventana del modelo',
  faceConcentration: 'null mientras no hay cuadros suficientes',
  modelConcentration: 'null cuando el modelo se abstiene y en no_face',
};

function archivosDe(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...archivosDe(p));
    else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const fuentes = archivosDe(src)
  // El documento offscreen construye el estado; no lo consume.
  .filter((p) => !p.includes(`${join('src', 'offscreen')}`))
  .map((p) => [p.slice(src.length + 1), readFileSync(p, 'utf8')]);

test('ningún campo anulable se usa con `.toFixed()` sin guarda', () => {
  const fallas = [];
  for (const [nombre, txt] of fuentes) {
    for (const campo of Object.keys(ANULABLES)) {
      // `algo.campo.toFixed(` — acceso directo, sin `?.` y sin `??`.
      const re = new RegExp(`\\.${campo}\\.toFixed\\(`, 'g');
      for (const m of txt.matchAll(re)) {
        const linea = txt.slice(0, m.index).split('\n').length;
        fallas.push(`${nombre}:${linea} — ${campo}.toFixed() sin guarda (${ANULABLES[campo]})`);
      }
    }
  }
  assert.deepEqual(fallas, [],
    'Un `.toFixed()` sobre un campo anulable tira una excepción durante el render, '
    + 'y sin Error Boundary eso desmonta App y cierra el WebSocket con code=1005.\n'
    + fallas.join('\n'));
});

test('el estado inicial declara en `null` los campos anulables', () => {
  // Si un campo anulable no figura en INITIAL_STATE, el primer render lo lee
  // como `undefined` en vez de `null`, y las guardas que comparan contra `null`
  // no lo atrapan.
  const hook = readFileSync(join(src, 'hooks', 'useAttentionDetection.js'), 'utf8');
  const ini = hook.slice(hook.indexOf('const INITIAL_STATE'), hook.indexOf('export function'));
  for (const campo of ['pInattention', 'concentration', 'inattentive', 'threshold', 'noFaceFraction']) {
    assert.match(ini, new RegExp(`${campo}:\\s*null`), `INITIAL_STATE debe declarar ${campo}: null`);
  }
});

test('la insignia de la vista previa distingue el veredicto de una regla', () => {
  // No alcanza con no romper: cuando decide una regla, el tooltip NO debe
  // hablar de una probabilidad que no existe.
  const box = readFileSync(join(src, 'ui', 'CameraPreviewBox.jsx'), 'utf8');
  assert.match(box, /ruleSource/,
    'la insignia debe contemplar el caso de veredicto por regla');
  assert.doesNotMatch(box, /attention\.pInattention\.toFixed/,
    'acceso directo sin guarda a pInattention');
});
