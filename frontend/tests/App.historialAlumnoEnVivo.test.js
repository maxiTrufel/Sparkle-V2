// Ajuste "flujo de preguntas" — el historial del alumno ("Preguntas
// respondidas") tiene que reflejar la respuesta apenas el backend la
// confirma ("answer_accepted"), SIN esperar a que la pregunta termine
// ("question_finished"), sin duplicarla una vez que sí termina, y —
// Corrección posterior — con el diseño FINAL desde el primer momento (sin
// ningún estado "pendiente"/"Respuesta registrada" intermedio): el propio
// "answer_accepted" ya trae `correctOptionIndex`, revelado recién DESPUÉS
// de que la respuesta de este alumno quedó grabada sin vuelta atrás. Se
// monta `App.jsx` REAL (mismo patrón que `App.parpadeoYMensajes.test.js`)
// porque el comportamiento en cuestión es justamente la interacción entre
// el evento WS, el estado optimista local y el refetch REST.
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

test('El historial del alumno muestra la tarjeta FINAL (correcta + respuesta correcta) apenas llega "answer_accepted", sin esperar "question_finished" ni duplicarla al finalizar', async () => {
  const meetingCode = 'liv-preg-alu';
  const email = 'alumno@test.com';

  const question = {
    id: 501,
    prompt: '¿Cuál es la capital de Francia?',
    options: ['París', 'Madrid', 'Roma', 'Berlín'],
    durationSeconds: 30,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    serverTime: Date.now(),
  };

  let myAnswersCallCount = 0;

  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email,
    backendRole: 'student',
    handleMessage: (type, payload) => {
      if (type === 'SPARKLE_WS_JOIN_ROOM') {
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'class_status', meetingCode: payload.meetingCode, active: true },
          });
          setTimeout(() => {
            emitFromBackground({
              type: 'SPARKLE_WS_EVENT',
              payload: { type: 'question_started', meetingCode: payload.meetingCode, question },
            });
          }, 30);
        }, 30);
        return { ok: true };
      }

      if (type === 'SPARKLE_GET_MY_QUESTION_ANSWERS') {
        myAnswersCallCount += 1;
        // El endpoint REST real SOLO devuelve preguntas ya FINALIZADAS —
        // así que el primer pedido (al montar el panel) siempre viene
        // vacío; recién después de "question_finished" el refetch trae la
        // fila real (que reconcilia contra la tarjeta optimista, ya
        // idéntica visualmente).
        if (myAnswersCallCount <= 1) return { answers: [] };
        return {
          answers: [
            {
              id: question.id,
              prompt: question.prompt,
              options: question.options,
              correctOptionIndex: 0,
              selectedOptionIndex: 0,
              isCorrect: true,
              skipped: false,
              answeredAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          ],
        };
      }

      if (type === 'SPARKLE_WS_ANSWER_QUESTION') {
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: {
              type: 'answer_accepted',
              meetingCode: payload.meetingCode,
              questionId: payload.questionId,
              isCorrect: true,
              skipped: false,
              // Revelado de una — el alumno ya no puede cambiar su
              // respuesta (índice único en `question_answers`).
              correctOptionIndex: 0,
            },
          });
        }, 30);
        return { ok: true };
      }

      return { ok: true };
    },
  });

  try {
    await waitUntil(() => container.textContent.includes('¿Cuál es la capital de Francia?'), { timeoutMs: 3000 });

    const parisButton = [...container.querySelectorAll('.sparkle-option')].find((b) => b.textContent.includes('París'));
    assert.ok(parisButton, `Debería existir un botón de opción con "París". Texto: ${container.textContent}`);
    parisButton.click();

    // Espera a que React re-renderice y habilite el botón antes de
    // clickearlo — clickear un botón todavía `disabled` en jsdom es un
    // no-op silencioso (mismo criterio que `App.ajustesPreguntas.test.js`).
    const findSubmitButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Enviar respuesta'));
    await waitUntil(() => Boolean(findSubmitButton() && !findSubmitButton().disabled), { timeoutMs: 2000 });
    const submitButton = findSubmitButton();
    assert.ok(submitButton && !submitButton.disabled, 'El botón "Enviar respuesta" debería estar habilitado tras elegir una opción');
    submitButton.click();

    // Apenas llega "answer_accepted" (sin esperar "question_finished"), el
    // historial ya tiene que mostrar la tarjeta FINAL — badge "Correcta"
    // Y la respuesta correcta, sin ningún estado intermedio.
    await waitUntil(() => container.textContent.includes('Correcta'), { timeoutMs: 3000 });
    assert.ok(
      !container.textContent.includes('Respuesta registrada'),
      'Ya no debería existir ningún estado "pendiente" — la tarjeta final aparece de una.'
    );

    // "question_finished" llega después — no debería cambiar nada
    // visualmente (ya estaba completa), solo disparar el refetch.
    const textBeforeFinish = container.textContent;
    emitFromBackground({
      type: 'SPARKLE_WS_EVENT',
      payload: { type: 'question_finished', meetingCode, questionId: question.id, correctOptionIndex: 0 },
    });

    // Le da tiempo al refetch real (el mock ya devuelve la fila "real" a
    // partir de la segunda consulta) a completarse y reconciliar.
    await wait(400);
    assert.ok(myAnswersCallCount >= 2, 'Debería haberse vuelto a consultar /questions/my-answers tras "question_finished".');
    assert.equal(
      container.textContent,
      textBeforeFinish,
      'La tarjeta no debería cambiar visualmente al llegar "question_finished" — ya estaba completa.'
    );

    const promptOccurrences = container.textContent.split('¿Cuál es la capital de Francia?').length - 1;
    assert.equal(promptOccurrences, 1, `La pregunta no debería aparecer duplicada en el historial. Texto: ${container.textContent}`);
  } finally {
    unmount();
  }
});

test('"Prefiero no responder" también muestra de inmediato la tarjeta final, con la respuesta correcta ya visible', async () => {
  const meetingCode = 'liv-preg-omi';
  const email = 'alumno@test.com';

  const question = {
    id: 502,
    prompt: '¿Cuánto es 7 × 8?',
    options: ['56', '54', '63', '48'],
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
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'class_status', meetingCode: payload.meetingCode, active: true },
          });
          setTimeout(() => {
            emitFromBackground({
              type: 'SPARKLE_WS_EVENT',
              payload: { type: 'question_started', meetingCode: payload.meetingCode, question },
            });
          }, 30);
        }, 30);
        return { ok: true };
      }

      if (type === 'SPARKLE_GET_MY_QUESTION_ANSWERS') return { answers: [] };

      if (type === 'SPARKLE_WS_SKIP_QUESTION') {
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: {
              type: 'answer_accepted',
              meetingCode: payload.meetingCode,
              questionId: payload.questionId,
              isCorrect: null,
              skipped: true,
              correctOptionIndex: 0,
            },
          });
        }, 30);
        return { ok: true };
      }

      return { ok: true };
    },
  });

  try {
    await waitUntil(() => container.textContent.includes('¿Cuánto es 7 × 8?'), { timeoutMs: 3000 });

    const skipButton = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Prefiero no responder'));
    assert.ok(skipButton);
    skipButton.click();

    const findConfirmButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'No responder');
    await waitUntil(() => Boolean(findConfirmButton()), { timeoutMs: 2000 });
    findConfirmButton().click();

    await waitUntil(() => container.textContent.includes('Elegiste no responder'), { timeoutMs: 3000 });
    // A diferencia del comportamiento anterior, ahora SÍ se revela de una
    // la respuesta correcta (el alumno ya no puede volver a elegir).
    await waitUntil(() => container.textContent.includes('Respuesta correcta:'), { timeoutMs: 2000 });
    assert.ok(container.textContent.includes('56'), 'Debería mostrar el texto de la opción correcta ("56").');
  } finally {
    unmount();
  }
});

test('Se eliminó el cartel "Ya respondiste esta pregunta" — no debe aparecer en ningún momento tras responder', async () => {
  const meetingCode = 'sin-cartel-ya';
  const email = 'alumno@test.com';

  const question = {
    id: 503,
    prompt: '¿Cuál es el resultado de 2 + 2?',
    options: ['4', '3', '5', '6'],
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
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'class_status', meetingCode: payload.meetingCode, active: true },
          });
          setTimeout(() => {
            emitFromBackground({
              type: 'SPARKLE_WS_EVENT',
              payload: { type: 'question_started', meetingCode: payload.meetingCode, question },
            });
          }, 30);
        }, 30);
        return { ok: true };
      }
      if (type === 'SPARKLE_GET_MY_QUESTION_ANSWERS') return { answers: [] };
      if (type === 'SPARKLE_WS_ANSWER_QUESTION') {
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: {
              type: 'answer_accepted',
              meetingCode: payload.meetingCode,
              questionId: payload.questionId,
              isCorrect: true,
              skipped: false,
              correctOptionIndex: 0,
            },
          });
        }, 30);
        return { ok: true };
      }
      return { ok: true };
    },
  });

  try {
    await waitUntil(() => container.textContent.includes('¿Cuál es el resultado de 2 + 2?'), { timeoutMs: 3000 });
    const option4 = [...container.querySelectorAll('.sparkle-option')].find((b) => b.textContent.includes('4'));
    option4.click();
    const findSubmitButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Enviar respuesta'));
    await waitUntil(() => Boolean(findSubmitButton() && !findSubmitButton().disabled), { timeoutMs: 2000 });
    findSubmitButton().click();

    await waitUntil(() => container.textContent.includes('Correcta'), { timeoutMs: 3000 });
    assert.ok(
      !container.textContent.includes('Esperá a que el docente'),
      `El cartel "Ya respondiste..."/"Esperá a que el docente..." ya no debería existir. Texto: ${container.textContent}`
    );
  } finally {
    unmount();
  }
});
