// Tests de Etapa 53 — dos parpadeos de vista reportados tras la Etapa 52:
//
//   Problema 1 (docente): al finalizar/reconectar dentro de la ventana de
//   "reanudar", se veía brevemente la vista normal ("Comenzar Clase") antes
//   de asentarse en "Reanudar clase" — el componente se montaba en su
//   estado por defecto mientras esperaba la respuesta del servidor.
//
//   Problema 2 (alumno): al apagarse el aviso temporal de "clase
//   detenida", el panel volvía SIEMPRE al mismo texto que ve un alumno que
//   nunca vio nada. Antes (Etapa 53) eso se resolvía distinguiendo dos
//   textos distintos; un ajuste posterior los unificó en un solo mensaje
//   estable para ambos casos. Etapa 60: se sacó el apagado automático por
//   completo (reportado como bug — el mensaje "cambiaba solo" a los pocos
//   segundos sin que pasara nada nuevo) — el aviso ahora queda FIJO hasta
//   un evento real (el docente inicia o reanuda), así que el primer test
//   de acá abajo ya no prueba un apagado automático: prueba que YA NO lo
//   hay. El segundo test (un alumno que nunca vio nada) sigue confirmando
//   el mismo mensaje estable de siempre para ese caso. Ajuste UI posterior
//   — ambos casos ahora comparten literalmente el mismo título/tarjeta
//   ("La clase está detenida", `ui/ClassPausedCard.jsx`); lo único que los
//   distingue es el botón "Obtener resumen de la clase", que solo existe
//   cuando de verdad hubo una clase que se detuvo.
//
// A diferencia de `wsClient.test.js` (lógica pura, con `WebSocket`/`chrome`
// mockeados a mano), acá se monta el `App.jsx` REAL — bundleado al vuelo
// con `esbuild` (Node no interpreta JSX nativamente) y renderizado con
// `react-dom/client` sobre un DOM real de `jsdom` — porque el bug es
// justamente de TIMING DE RENDER entre efectos y eventos WS entrelazados,
// algo que un test de lógica aislada no puede reproducir. Ver
// `tests/helpers/reactHarness.js` (mismo patrón ya usado, sin dejar
// artefacto persistente, en las Etapas 47/48/50/51 — ver DOCUMENTACION.md).
//
// `unmount()` al final de CADA test (en `finally`, corra bien o mal el
// resto) no es solo prolijidad: `App.jsx` arma un `setInterval` de
// re-unión cada 15s mientras el docente está montado (Etapa 52) — sin
// desmontar, ese timer queda vivo para siempre y el proceso de
// `node --test` nunca termina solo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleAppForTest,
  installDom,
  installChromeMock,
  addActiveCallSignals,
  wait,
  waitUntil,
  cleanupTestBundles,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Limpieza de los bundles temporales que arma `bundleAppForTest` en el
// `.tmp-<pid>/` de este archivo (uno por cada `mountApp()` de acá abajo) —
// no aportan nada una vez que terminó el test.
test.after(async () => {
  await cleanupTestBundles();
});

// Monta una instancia fresca de `App.jsx` real dentro de un DOM/chrome
// mockeados, ya con las señales necesarias para que `role` resuelva al
// tipo pedido y `callStage` resuelva 'in-call' de entrada. Cada test llama
// a esto con su propio `meetingCode` — evita que el "sticky state" de
// `callStage.js` (module-level, ver DOCUMENTACION.md Etapa 26) de un test
// se filtre al siguiente dentro del mismo proceso.
async function mountApp({ meetingCode, email, backendRole, handleMessage }) {
  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);

  const chromeMock = installChromeMock(async (type, payload) => {
    if (type === 'SPARKLE_GET_ROLE') return { role: backendRole };
    return handleMessage ? handleMessage(type, payload) : { ok: true };
  });

  const bundlePath = await bundleAppForTest('src/App.jsx');
  const { mount, unmount } = require(bundlePath);

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  mount(container);

  return { dom, container, unmount, ...chromeMock };
}

test('Problema 1 — el docente que se reconecta a una clase reanudable NUNCA ve "Comenzar Clase" de por medio', async () => {
  const meetingCode = 'aaa-bbbb-ccc';
  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email: 'docente1@test.com',
    backendRole: 'teacher',
    handleMessage: (type, payload) => {
      if (type === 'SPARKLE_WS_JOIN_ROOM') {
        // Reproduce la carrera real: "class_status" (active:false) seguido
        // CASI de inmediato por "class_resumable" -- mismo "join" del
        // lado del servidor, ver `handleJoin` en backend/src/ws/index.js.
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'class_status', meetingCode: payload.meetingCode, active: false },
          });
          setTimeout(() => {
            emitFromBackground({
              type: 'SPARKLE_WS_EVENT',
              payload: { type: 'class_resumable', meetingCode: payload.meetingCode },
            });
          }, 30);
        }, 30);
        return { ok: true };
      }
      return { ok: true };
    },
  });

  try {
    // Se registra CADA mutación del DOM (no solo se hace polling) para no
    // perderse un parpadeo aunque sea de un solo tick.
    const observedTexts = [];
    const observer = new global.MutationObserver(() => observedTexts.push(container.textContent));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    observedTexts.push(container.textContent);

    await waitUntil(() => container.textContent.includes('Reanudar clase'), { timeoutMs: 3000 });
    observedTexts.push(container.textContent);
    observer.disconnect();

    assert.ok(
      !observedTexts.some((t) => t.includes('Comenzar Clase')),
      `"Comenzar Clase" no debería aparecer nunca de por medio. Snapshots: ${JSON.stringify(observedTexts)}`
    );
    assert.ok(container.textContent.includes('Reanudar clase'));
  } finally {
    unmount();
  }
});

test('Problema 1 (regresión) — el docente sin nada para reanudar sigue llegando a "Comenzar Clase" (no se cuelga en el spinner)', async () => {
  const meetingCode = 'ddd-eeee-fff';
  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email: 'docente2@test.com',
    backendRole: 'teacher',
    handleMessage: (type, payload) => {
      if (type === 'SPARKLE_WS_JOIN_ROOM') {
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'class_status', meetingCode: payload.meetingCode, active: false },
          });
          // A propósito nunca llega "class_resumable" -- caso común.
        }, 30);
        return { ok: true };
      }
      return { ok: true };
    },
  });

  try {
    const ok = await waitUntil(() => container.textContent.includes('Comenzar Clase'), { timeoutMs: 3000 });
    assert.ok(ok, `Debería asentarse en "Comenzar Clase". Texto final: ${container.textContent}`);
  } finally {
    unmount();
  }
});

test('Problema 1 (tope de seguridad) — si el join nunca responde nada, el spinner igual se resuelve solo (no cuelga para siempre)', async () => {
  const meetingCode = 'ggg-hhhh-iii';
  const { container, unmount } = await mountApp({
    meetingCode,
    email: 'docente3@test.com',
    backendRole: 'teacher',
    // Sin `handleMessage` para "SPARKLE_WS_JOIN_ROOM": nunca se emite
    // ningún evento WS de vuelta -- simula un backend caído/red cortada.
  });

  try {
    const ok = await waitUntil(() => container.textContent.includes('Comenzar Clase'), { timeoutMs: 8000 });
    assert.ok(ok, 'El tope de seguridad (RESOLVING_VIEW_MAX_MS) debería asentar la vista igual, sin colgarse.');
  } finally {
    unmount();
  }
});

test('Problema 2 — el aviso de "clase detenida" queda fijo, ya no se apaga solo con el tiempo', async () => {
  const meetingCode = 'jjj-kkkk-lll';
  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email: 'alumno1@test.com',
    backendRole: 'student',
    handleMessage: (type, payload) => {
      if (type === 'SPARKLE_WS_JOIN_ROOM') {
        setTimeout(() => {
          // La clase ya estaba en curso cuando este alumno se unió.
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'class_status', meetingCode: payload.meetingCode, active: true },
          });
          setTimeout(() => {
            // El docente detiene la clase EN VIVO, con el alumno mirando.
            emitFromBackground({
              type: 'SPARKLE_WS_EVENT',
              payload: { type: 'class_ended', meetingCode: payload.meetingCode },
            });
          }, 30);
        }, 30);
        return { ok: true };
      }
      return { ok: true };
    },
  });

  try {
    // El botón "Obtener resumen de la clase" es lo único que distingue este
    // caso (clase real que se detuvo) del alumno que nunca vio nada — ambos
    // comparten el mismo título unificado, así que ESE es el que hay que
    // esperar acá (esperar el título a secas resolvería de una con el
    // render inicial idle, antes de que lleguen los eventos WS de arriba).
    const sawSummaryButton = () =>
      [...container.querySelectorAll('button')].some((b) => b.textContent.includes('Obtener resumen de la clase'));
    await waitUntil(sawSummaryButton, { timeoutMs: 2000 });
    assert.ok(sawSummaryButton(), `Debería mostrar el botón "Obtener resumen de la clase". Texto: ${container.textContent}`);
    assert.ok(container.textContent.includes('La clase está detenida'), 'Debería mostrar el título unificado.');

    // Antes (hasta la Etapa 59) un timer de apagado automático apagaba el
    // aviso solo -- se espera bastante más que eso, con tiempo REAL (no
    // timers simulados), para confirmar que el mensaje NO cambia por el
    // simple paso del tiempo (Etapa 60).
    await wait(4300);

    const finalText = container.textContent;
    assert.ok(
      finalText.includes('La clase está detenida'),
      `El aviso debería seguir fijo, no apagarse solo. Texto final: ${finalText}`
    );
    assert.ok(
      [...container.querySelectorAll('button')].some((b) => b.textContent.includes('Obtener resumen de la clase')),
      `NO debería haber vuelto solo al caso "nunca vi una clase" (perdería el botón de resumen). Texto final: ${finalText}`
    );
  } finally {
    unmount();
  }
});

test('Problema 2 (regresión) — un alumno que nunca vio una clase también ve el mensaje estable unificado', async () => {
  const meetingCode = 'mmm-nnnn-ooo';
  const { container, unmount } = await mountApp({
    meetingCode,
    email: 'alumno2@test.com',
    backendRole: 'student',
    // Sin eventos WS: la clase nunca estuvo activa para este alumno.
  });

  try {
    const ok = await waitUntil(() => container.textContent.includes('La clase está detenida'), {
      timeoutMs: 2000,
    });
    assert.ok(ok, `Debería mostrar el mensaje estable unificado. Texto final: ${container.textContent}`);
    assert.ok(
      ![...container.querySelectorAll('button')].some((b) => b.textContent.includes('Obtener resumen de la clase')),
      'Sin una clase real que se haya detenido, no debería ofrecer "Obtener resumen de la clase".'
    );
  } finally {
    unmount();
  }
});
