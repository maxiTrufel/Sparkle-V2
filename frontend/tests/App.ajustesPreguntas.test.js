// Tres ajustes puntuales al flujo de preguntas — mismo patrón que
// `App.parpadeoYMensajes.test.js`/`App.historialAlumnoEnVivo.test.js`: se
// monta `App.jsx` REAL (bundleado con esbuild sobre jsdom) porque los tres
// bugs corregidos son de INTERACCIÓN entre estado/eventos y render, no de
// lógica aislada.
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
  waitUntil,
  cleanupTestBundles,
  chooseAttentionMode,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.after(async () => {
  await cleanupTestBundles();
});

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

// ─── Punto 3 — responder con la clase detenida/nunca iniciada ───

test('Punto 3 — un alumno que nunca vio "class_started" (clase nunca iniciada) igual recibe y puede responder una pregunta en vivo', async () => {
  const meetingCode = 'idl-preg-viv';
  const email = 'alumno@test.com';
  const question = {
    id: 601,
    prompt: '¿Cuál es el planeta más grande?',
    options: ['Júpiter', 'Saturno', 'Neptuno', 'Urano'],
    durationSeconds: 30,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    serverTime: Date.now(),
  };

  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email,
    backendRole: 'student',
    handleMessage: (type, payload) => {
      if (type === 'SPARKLE_WS_JOIN_ROOM') {
        // A propósito NUNCA se emite "class_status"/"class_started" — el
        // alumno se queda en el estado idle ("La clase está detenida")
        // salvo por la pregunta, que SÍ debe llegarle igual.
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'question_started', meetingCode: payload.meetingCode, question },
          });
        }, 30);
        return { ok: true };
      }
      if (type === 'SPARKLE_GET_MY_QUESTION_ANSWERS') return { answers: [] };
      return { ok: true };
    },
  });

  try {
    await waitUntil(() => container.textContent.includes('La clase está detenida'), { timeoutMs: 2000 });

    // La pregunta tiene que aparecer IGUAL, encima del estado idle — antes
    // de esta corrección, el modal vivía anidado dentro de `if
    // (classStarted)` y jamás se mostraba en este escenario.
    await waitUntil(() => container.textContent.includes('¿Cuál es el planeta más grande?'), { timeoutMs: 3000 });

    const jupiterButton = [...container.querySelectorAll('.sparkle-option')].find((b) => b.textContent.includes('Júpiter'));
    assert.ok(jupiterButton, `Debería poder elegir una opción con la clase detenida/nunca iniciada. Texto: ${container.textContent}`);
    jupiterButton.click();

    const findSubmitButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Enviar respuesta'));
    await waitUntil(() => Boolean(findSubmitButton() && !findSubmitButton().disabled), { timeoutMs: 2000 });
    assert.ok(
      findSubmitButton() && !findSubmitButton().disabled,
      'El botón "Enviar respuesta" debería estar habilitado tras elegir una opción, con la clase detenida/nunca iniciada.'
    );
  } finally {
    unmount();
  }
});

// ─── Punto 1 — botón "Enviar respuesta": deshabilitado/habilitado/reintento ───

test('Punto 1 — "Enviar respuesta" arranca deshabilitado, se habilita al elegir, y un rechazo del servidor permite reintentar (no queda trabado)', async () => {
  const meetingCode = 'btn-envi-rec';
  const email = 'alumno@test.com';
  const question = {
    id: 602,
    prompt: '¿Cuánto es 9 × 9?',
    options: ['81', '72', '99', '90'],
    durationSeconds: 30,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    serverTime: Date.now(),
  };

  let attempts = 0;

  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email,
    backendRole: 'student',
    handleMessage: (type, payload) => {
      if (type === 'SPARKLE_WS_JOIN_ROOM') {
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'question_started', meetingCode: payload.meetingCode, question },
          });
        }, 30);
        return { ok: true };
      }
      if (type === 'SPARKLE_GET_MY_QUESTION_ANSWERS') return { answers: [] };
      if (type === 'SPARKLE_WS_ANSWER_QUESTION') {
        attempts += 1;
        setTimeout(() => {
          if (attempts === 1) {
            // El PRIMER intento lo rechaza el servidor (ej. carrera con
            // otra pestaña) — nunca debería dejar el botón inutilizable.
            emitFromBackground({
              type: 'SPARKLE_WS_EVENT',
              payload: {
                type: 'answer_rejected',
                meetingCode: payload.meetingCode,
                questionId: payload.questionId,
                reason: 'Ya respondiste esta pregunta.',
              },
            });
          } else {
            emitFromBackground({
              type: 'SPARKLE_WS_EVENT',
              payload: {
                type: 'answer_accepted',
                meetingCode: payload.meetingCode,
                questionId: payload.questionId,
                isCorrect: true,
                skipped: false,
                correctOptionIndex: 1, // "72" — la opción que quedó elegida en el reintento
              },
            });
          }
        }, 30);
        return { ok: true };
      }
      return { ok: true };
    },
  });

  try {
    await waitUntil(() => container.textContent.includes('¿Cuánto es 9 × 9?'), { timeoutMs: 3000 });

    const findSubmitButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Enviar respuesta'));

    // Estado inicial: sin ninguna opción elegida, deshabilitado.
    assert.ok(findSubmitButton().disabled, 'Debería estar deshabilitado sin ninguna opción seleccionada.');

    const option81 = [...container.querySelectorAll('.sparkle-option')].find((b) => b.textContent.includes('81'));
    option81.click();
    await waitUntil(() => Boolean(!findSubmitButton()?.disabled), { timeoutMs: 2000 });
    assert.ok(!findSubmitButton().disabled, 'Debería habilitarse apenas se elige una opción.');

    // Cambia de opción — sigue habilitado.
    const option72 = [...container.querySelectorAll('.sparkle-option')].find((b) => b.textContent.includes('72'));
    option72.click();
    assert.ok(!findSubmitButton().disabled, 'Debería seguir habilitado al cambiar de opción.');

    findSubmitButton().click();

    // Mientras está en vuelo, el propio texto cambia a "Enviando…".
    await waitUntil(() => Boolean(findSubmitButton()?.textContent.includes('Enviando')), { timeoutMs: 1000 });

    // El servidor RECHAZA el primer intento — debe mostrarse el error Y
    // volver a estar disponible para reintentar (no "Respuesta enviada."
    // pegado para siempre).
    await waitUntil(() => container.textContent.includes('Ya respondiste esta pregunta.'), { timeoutMs: 2000 });
    assert.ok(
      !container.textContent.includes('Respuesta enviada.'),
      'No debería mostrar "Respuesta enviada." tras un rechazo del servidor.'
    );
    await waitUntil(() => Boolean(findSubmitButton() && !findSubmitButton().disabled), { timeoutMs: 2000 });
    const retryButton = findSubmitButton();
    assert.ok(retryButton, 'El botón "Enviar respuesta" debería seguir existiendo para reintentar.');
    assert.ok(!retryButton.disabled, 'El botón debería estar habilitado de nuevo tras el rechazo (la opción sigue elegida).');

    // Reintenta — esta vez el servidor lo acepta. La confirmación se ve en
    // "Preguntas respondidas": la tarjeta final (badge "Correcta") aparece
    // sin ningún cartel de espera de por medio (se eliminó).
    retryButton.click();
    await waitUntil(() => container.textContent.includes('Correcta'), { timeoutMs: 2000 });
    assert.equal(attempts, 2, 'Debería haber exactamente dos intentos: el rechazado y el reintento aceptado.');
  } finally {
    unmount();
  }
});

// ─── Punto 2 — "Generar pregunta" no aparece antes de "Comenzar Clase" ───

test('Punto 2 — "Generar pregunta" NO aparece en la pantalla previa a "Comenzar Clase", pero sí en el panel principal (clase en curso)', async () => {
  const meetingCode = 'sin-gen-idle';
  const email = 'docente@test.com';

  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email,
    backendRole: 'teacher',
    handleMessage: (type, payload) => {
      if (type === 'SPARKLE_WS_JOIN_ROOM') {
        setTimeout(() => {
          // `SPARKLE_WS_CONNECTION` (Etapa 52, ver `services/wsClient.js`
          // en producción) es lo que habilita los botones de
          // `TeacherPanel.jsx` que dependen de `wsConnected`
          // ("Comenzar Clase" entre ellos) — sin emitirlo acá, el mock
          // deja ese botón deshabilitado para siempre y el `.click()` de
          // más abajo sería un no-op silencioso.
          emitFromBackground({ type: 'SPARKLE_WS_CONNECTION', meetingCode: payload.meetingCode, connected: true });
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'class_status', meetingCode: payload.meetingCode, active: false },
          });
        }, 30);
        return { ok: true };
      }
      if (type === 'SPARKLE_WS_START_CLASS') {
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'class_started', meetingCode: payload.meetingCode },
          });
        }, 30);
        return { ok: true };
      }
      // Requisito de producto — "Comenzar Clase" queda deshabilitado sin un
      // documento cargado (ver `hooks/useDocumentUpload.js`); este test
      // ejercita "Generar pregunta" antes/después de arrancar la clase, no
      // el flujo de carga de material, así que alcanza con simular que ya
      // hay uno cargado de antemano.
      if (type === 'SPARKLE_GET_DOCUMENT') {
        return {
          document: {
            id: 1,
            fileName: 'material.pdf',
            sizeBytes: 12345,
            mimeType: 'application/pdf',
            uploadedAt: new Date().toISOString(),
            // Requisito de producto — "Comenzar Clase" exige, además de un
            // documento cargado, que su análisis con IA haya terminado OK
            // (ver `hooks/useDocumentUpload.js`). Sin este campo el mock
            // simula "análisis en curso" para siempre y el botón queda
            // deshabilitado.
            analysisStatus: 'processed',
            analysis: null,
            analysisError: null,
          },
        };
      }
      return { ok: true };
    },
  });

  try {
    const findStartButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Comenzar Clase'));
    await chooseAttentionMode(container);
    await waitUntil(() => Boolean(findStartButton() && !findStartButton().disabled), { timeoutMs: 3000 });
    assert.ok(
      !container.textContent.includes('Generar pregunta'),
      `"Generar pregunta" no debería aparecer antes de "Comenzar Clase". Texto: ${container.textContent}`
    );

    findStartButton().click();

    await waitUntil(() => container.textContent.includes('Clase en curso'), { timeoutMs: 3000 });
    assert.ok(
      container.textContent.includes('Generar pregunta'),
      `"Generar pregunta" sí debería estar disponible con la clase en curso. Texto: ${container.textContent}`
    );
  } finally {
    unmount();
  }
});
