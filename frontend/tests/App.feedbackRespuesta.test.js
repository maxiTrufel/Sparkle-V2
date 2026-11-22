// Feedback grande y centrado ("¡Respuesta correcta!"/"Respuesta
// incorrecta", `ui/AnswerResultPopup.jsx`) apenas el backend confirma el
// resultado de una respuesta — mismo patrón que
// `App.historialAlumnoEnVivo.test.js`: `App.jsx` REAL sobre jsdom, con
// `chrome.runtime` mockeado a mano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleAppForTest, installDom, installChromeMock, addActiveCallSignals, wait, waitUntil, cleanupTestBundles } from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.after(async () => {
  await cleanupTestBundles();
});

async function mountApp({ meetingCode, email, handleMessage }) {
  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);

  const chromeMock = installChromeMock(async (type, payload) => {
    if (type === 'SPARKLE_GET_ROLE') return { role: 'student' };
    if (type === 'SPARKLE_GET_MY_QUESTION_ANSWERS') return { answers: [] };
    return handleMessage ? handleMessage(type, payload) : { ok: true };
  });

  const bundlePath = await bundleAppForTest('src/App.jsx');
  const { mount, unmount } = require(bundlePath);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  mount(container);

  return { dom, container, unmount, ...chromeMock };
}

function startQuestion(question) {
  return (type, payload, emitFromBackground) => {
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
      return true;
    }
    return false;
  };
}

test('respuesta CORRECTA: muestra "¡Respuesta correcta!" grande y centrado dentro del panel, y desaparece solo a los ~2s', async () => {
  const meetingCode = 'pop-correcta-ok';
  const email = 'alumno@test.com';
  const question = {
    id: 801,
    prompt: '¿Cuál es la capital de España?',
    options: ['Madrid', 'Lisboa', 'París', 'Roma'],
    durationSeconds: 30,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    serverTime: Date.now(),
  };

  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email,
    handleMessage: (type, payload) => {
      const handled = startQuestion(question)(type, payload, emitFromBackground);
      if (handled) return { ok: true };
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
    await waitUntil(() => container.textContent.includes('¿Cuál es la capital de España?'), { timeoutMs: 3000 });
    const madridButton = [...container.querySelectorAll('.sparkle-option')].find((b) => b.textContent.includes('Madrid'));
    madridButton.click();
    const findSubmitButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Enviar respuesta'));
    await waitUntil(() => Boolean(findSubmitButton() && !findSubmitButton().disabled), { timeoutMs: 2000 });
    findSubmitButton().click();

    await waitUntil(() => container.textContent.includes('¡Respuesta correcta!'), { timeoutMs: 2000 });
    const popup = container.querySelector('.sparkle-answer-result-card--correct');
    assert.ok(popup, 'Debería existir la tarjeta del popup con la variante "correct".');
    assert.ok(
      !container.textContent.includes('Respuesta incorrecta'),
      'No debería mostrar el texto de incorrecta al responder bien.'
    );

    // Sigue vigente bien antes de los 2s (no se cierra antes de tiempo).
    await wait(1000);
    assert.ok(
      container.textContent.includes('¡Respuesta correcta!'),
      'El popup debería seguir visible antes de los 2 segundos.'
    );

    // Desaparece solo, con transición (no de un tirón): sigue en el DOM un
    // instante más tras dejar de estar "visible", y termina desmontado del
    // todo.
    await waitUntil(() => !container.textContent.includes('¡Respuesta correcta!'), { timeoutMs: 3000 });
    assert.ok(!container.querySelector('.sparkle-answer-result-card'), 'El popup debería desmontarse del todo tras cerrarse.');
  } finally {
    unmount();
  }
});

test('respuesta INCORRECTA: muestra "Respuesta incorrecta"', async () => {
  const meetingCode = 'pop-incorrecta-ok';
  const email = 'alumno@test.com';
  const question = {
    id: 802,
    prompt: '¿Cuánto es 6 × 7?',
    options: ['42', '36', '48', '40'],
    durationSeconds: 30,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    serverTime: Date.now(),
  };

  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email,
    handleMessage: (type, payload) => {
      const handled = startQuestion(question)(type, payload, emitFromBackground);
      if (handled) return { ok: true };
      if (type === 'SPARKLE_WS_ANSWER_QUESTION') {
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: {
              type: 'answer_accepted',
              meetingCode: payload.meetingCode,
              questionId: payload.questionId,
              isCorrect: false,
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
    await waitUntil(() => container.textContent.includes('¿Cuánto es 6 × 7?'), { timeoutMs: 3000 });
    const wrongButton = [...container.querySelectorAll('.sparkle-option')].find((b) => b.textContent.includes('36'));
    wrongButton.click();
    const findSubmitButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Enviar respuesta'));
    await waitUntil(() => Boolean(findSubmitButton() && !findSubmitButton().disabled), { timeoutMs: 2000 });
    findSubmitButton().click();

    await waitUntil(() => container.textContent.includes('Respuesta incorrecta'), { timeoutMs: 2000 });
    assert.ok(
      container.querySelector('.sparkle-answer-result-card--incorrect'),
      'Debería existir la tarjeta del popup con la variante "incorrect".'
    );
    assert.ok(
      !container.textContent.includes('¡Respuesta correcta!'),
      'No debería mostrar el texto de correcta al responder mal.'
    );
  } finally {
    unmount();
  }
});

test('"Prefiero no responder" NO dispara el popup — no hay nada correcto/incorrecto que anunciar', async () => {
  const meetingCode = 'pop-omitida-ok';
  const email = 'alumno@test.com';
  const question = {
    id: 803,
    prompt: '¿Cuál es el planeta más grande?',
    options: ['Júpiter', 'Saturno', 'Tierra', 'Marte'],
    durationSeconds: 30,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    serverTime: Date.now(),
  };

  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email,
    handleMessage: (type, payload) => {
      const handled = startQuestion(question)(type, payload, emitFromBackground);
      if (handled) return { ok: true };
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
    await waitUntil(() => container.textContent.includes('¿Cuál es el planeta más grande?'), { timeoutMs: 3000 });
    const skipButton = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Prefiero no responder'));
    skipButton.click();
    const findConfirmButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'No responder');
    await waitUntil(() => Boolean(findConfirmButton()), { timeoutMs: 2000 });
    findConfirmButton().click();

    await waitUntil(() => container.textContent.includes('Elegiste no responder'), { timeoutMs: 3000 });
    await wait(300);
    assert.ok(!container.querySelector('.sparkle-answer-result-card'), 'No debería aparecer ningún popup al saltear la pregunta.');
    assert.ok(!container.textContent.includes('¡Respuesta correcta!'));
    assert.ok(!container.textContent.includes('Respuesta incorrecta'));
  } finally {
    unmount();
  }
});

test('un error al enviar la respuesta NO muestra el popup — sigue el manejo de error existente', async () => {
  const meetingCode = 'pop-error-envio';
  const email = 'alumno@test.com';
  const question = {
    id: 804,
    prompt: '¿Cuál es el metal más liviano?',
    options: ['Litio', 'Hierro', 'Plomo', 'Oro'],
    durationSeconds: 30,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    serverTime: Date.now(),
  };

  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email,
    handleMessage: (type, payload) => {
      const handled = startQuestion(question)(type, payload, emitFromBackground);
      if (handled) return { ok: true };
      if (type === 'SPARKLE_WS_ANSWER_QUESTION') {
        setTimeout(() => {
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: {
              type: 'answer_rejected',
              meetingCode: payload.meetingCode,
              questionId: payload.questionId,
              reason: 'Ya respondiste esta pregunta.',
            },
          });
        }, 30);
        return { ok: true };
      }
      return { ok: true };
    },
  });

  try {
    await waitUntil(() => container.textContent.includes('¿Cuál es el metal más liviano?'), { timeoutMs: 3000 });
    const litioButton = [...container.querySelectorAll('.sparkle-option')].find((b) => b.textContent.includes('Litio'));
    litioButton.click();
    const findSubmitButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Enviar respuesta'));
    await waitUntil(() => Boolean(findSubmitButton() && !findSubmitButton().disabled), { timeoutMs: 2000 });
    findSubmitButton().click();

    await waitUntil(() => container.textContent.includes('Ya respondiste esta pregunta.'), { timeoutMs: 2000 });
    assert.ok(!container.querySelector('.sparkle-answer-result-card'), 'No debería mostrarse el popup ante un rechazo del servidor.');
    assert.ok(!container.textContent.includes('¡Respuesta correcta!'));
    assert.ok(!container.textContent.includes('Respuesta incorrecta'));
  } finally {
    unmount();
  }
});
