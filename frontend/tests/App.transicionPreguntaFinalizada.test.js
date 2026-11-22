// Corrección — salto visual al finalizar una pregunta: entre que
// "question_finished" llega por WS (instantáneo, `activeQuestion` pasa a
// `null`) y que el historial REST se recarga con esa misma pregunta ya
// incluida (round-trip a la base, asincrónico), la tarjeta no debe
// desaparecer ni dejar un hueco vacío — ver `TeacherPanel.jsx`
// (`optimisticFinished`/`topQuestionEntry`) y `ui/QuestionCard.jsx`
// (`showTimerSlot`, colapso animado en vez de un salto de altura).
//
// Mismo patrón que `App.botonDocenteYSinResponder.test.js`: `App.jsx` REAL
// sobre jsdom, con `chrome.runtime` mockeado a mano — acá controlamos a
// propósito CUÁNDO responde `SPARKLE_GET_QUESTIONS_HISTORY` para poder
// observar el estado exacto mientras ese pedido todavía está en vuelo.
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

test('la tarjeta de la pregunta no desaparece entre "question_finished" y que el historial REST termine de recargar', async () => {
  const meetingCode = 'abc-transicion-final';
  const email = 'docente@test.com';

  const question = {
    id: 901,
    prompt: '¿Cuál es el océano más grande?',
    options: ['Pacífico', 'Atlántico', 'Índico', 'Ártico'],
    durationSeconds: 30,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    serverTime: Date.now(),
  };

  // Se destraba a mano, DESPUÉS de que el test ya haya podido comprobar el
  // estado intermedio (pregunta finalizada, historial todavía "en vuelo").
  let releaseHistoryFetch;
  const historyFetchGate = new Promise((resolve) => {
    releaseHistoryFetch = resolve;
  });
  let questionsHistoryRequestCount = 0;

  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  addActiveCallSignals(dom.window.document, email);

  const chromeMock = installChromeMock(async (type, payload) => {
    if (type === 'SPARKLE_GET_ROLE') return { role: 'teacher' };
    if (type === 'SPARKLE_GET_STUDENT_STATS') return { students: [] };
    if (type === 'SPARKLE_GET_HISTORY') return { students: [] };

    if (type === 'SPARKLE_WS_JOIN_ROOM') {
      setTimeout(() => {
        chromeMock.emitFromBackground({ type: 'SPARKLE_WS_CONNECTION', meetingCode: payload.meetingCode, connected: true });
        chromeMock.emitFromBackground({
          type: 'SPARKLE_WS_EVENT',
          payload: { type: 'class_status', meetingCode: payload.meetingCode, active: true },
        });
      }, 20);
      return { ok: true };
    }

    if (type === 'SPARKLE_GET_QUESTIONS_HISTORY') {
      questionsHistoryRequestCount += 1;
      if (questionsHistoryRequestCount === 1) return { questions: [] };
      // Segundo pedido en adelante (el que dispara "question_finished"):
      // no resuelve hasta que el test lo libere a mano — simula el
      // round-trip real a la base todavía en vuelo.
      await historyFetchGate;
      return {
        questions: [
          {
            id: question.id,
            prompt: question.prompt,
            options: question.options,
            correctOptionIndex: 0,
            responseCount: 2,
            skippedCount: 0,
            finishedAt: new Date().toISOString(),
            optionDistribution: question.options.map((label, i) => ({
              label,
              count: i === 0 ? 2 : 0,
              percent: i === 0 ? 100 : 0,
              correct: i === 0,
            })),
          },
        ],
      };
    }

    return { ok: true };
  });

  const bundlePath = await bundleAppForTest('src/App.jsx');
  const { mount, unmount } = require(bundlePath);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  mount(container);

  try {
    const findGenerateButton = () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Generar pregunta') || b.textContent.includes('Esperá'));
    await waitUntil(() => Boolean(findGenerateButton()), { timeoutMs: 3000 });

    chromeMock.emitFromBackground({
      type: 'SPARKLE_WS_EVENT',
      payload: {
        type: 'question_stats_updated',
        meetingCode,
        question,
        stats: { answeredCount: 2, skippedCount: 0, correctOptionIndex: 0, optionCounts: { a: 2, b: 0, c: 0, d: 0 } },
      },
    });

    await waitUntil(() => container.textContent.includes(question.prompt), { timeoutMs: 3000 });
    assert.ok(container.textContent.includes('Pregunta en vivo'), 'Debería mostrarse como pregunta en vivo primero.');

    chromeMock.emitFromBackground({
      type: 'SPARKLE_WS_EVENT',
      payload: { type: 'question_finished', meetingCode, questionId: question.id, correctOptionIndex: 0 },
    });

    // El punto central: en el instante posterior a "question_finished" —
    // mientras el segundo pedido de historial sigue "en vuelo" a
    // propósito — la pregunta sigue VISIBLE (snapshot optimista), nunca
    // desaparece ni deja el estado vacío de "Todavía no se realizó ninguna
    // pregunta en esta clase.".
    await waitUntil(() => container.textContent.includes('Finalizada'), { timeoutMs: 2000 });
    assert.ok(
      container.textContent.includes(question.prompt),
      `La pregunta debería seguir visible durante la transición. Texto: ${container.textContent}`
    );
    assert.ok(
      !container.textContent.includes('Todavía no se realizó ninguna pregunta en esta clase.'),
      'No debería mostrarse el estado vacío mientras la pregunta recién finalizada sigue siendo la única.'
    );
    assert.ok(
      !container.textContent.includes('Pregunta en vivo'),
      'Ya no debería mostrarse como "en vivo" una vez finalizada.'
    );

    // Ahora se libera el pedido de historial — el snapshot optimista se
    // reemplaza por la fila real, sin duplicarse.
    releaseHistoryFetch();
    await wait(150);

    const promptOccurrences = container.textContent.split(question.prompt).length - 1;
    assert.equal(promptOccurrences, 1, 'La pregunta finalizada no debería aparecer duplicada tras la reconciliación.');
  } finally {
    unmount();
  }
});
