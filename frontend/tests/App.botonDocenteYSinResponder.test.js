// Ajustes puntuales al flujo de preguntas (segunda ronda):
//   1) El botón "Generar pregunta" del docente debe quedar TOTALMENTE
//      deshabilitado mientras haya una pregunta activa, con el texto
//      "Esperá X segundos" (mismo contador que la tarjeta en vivo), y
//      volver solo a "Generar pregunta" cuando la pregunta termina.
//   2) El historial del alumno debe mostrar, apenas termina una pregunta,
//      una tarjeta "Sin responder" para quien nunca interactuó con ella —
//      sin que el frontend la construya: viene tal cual del REST
//      (`/questions/my-answers`, `status: 'unanswered'`).
// Mismo patrón que el resto de `App.*.test.js`: se monta `App.jsx` REAL
// porque ambos comportamientos dependen de la interacción entre eventos WS
// y el estado/render de los paneles, no de lógica aislada.
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

test('"Generar pregunta" del docente se deshabilita con "Esperá X segundos" mientras hay una pregunta activa, y vuelve solo al terminar', async () => {
  const meetingCode = 'gen-preg-disab';
  const email = 'docente@test.com';

  const question = {
    id: 701,
    prompt: '¿Cuál es la capital de Italia?',
    options: ['Roma', 'Milán', 'Nápoles', 'Turín'],
    durationSeconds: 30,
    startedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    serverTime: Date.now(),
  };

  const { container, unmount, emitFromBackground } = await mountApp({
    meetingCode,
    email,
    backendRole: 'teacher',
    handleMessage: (type, payload) => {
      if (type === 'SPARKLE_WS_JOIN_ROOM') {
        setTimeout(() => {
          emitFromBackground({ type: 'SPARKLE_WS_CONNECTION', meetingCode: payload.meetingCode, connected: true });
          // Arranca directo con la clase en curso — no hace falta pasar
          // por "Comenzar Clase" para este escenario.
          emitFromBackground({
            type: 'SPARKLE_WS_EVENT',
            payload: { type: 'class_status', meetingCode: payload.meetingCode, active: true },
          });
        }, 30);
        return { ok: true };
      }
      if (type === 'SPARKLE_GET_QUESTIONS_HISTORY') return { questions: [] };
      if (type === 'SPARKLE_GET_STUDENT_STATS') return { students: [] };
      return { ok: true };
    },
  });

  try {
    const findGenerateButton = () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Generar pregunta') || b.textContent.includes('Esperá'));

    await waitUntil(() => Boolean(findGenerateButton()), { timeoutMs: 3000 });
    assert.ok(!findGenerateButton().disabled, 'Sin pregunta activa, "Generar pregunta" debería estar habilitado.');
    assert.equal(findGenerateButton().textContent.trim(), 'Generar pregunta');

    // Simula que ya se envió una pregunta (llega tal cual la manda el
    // servidor al docente tras "Enviar pregunta" — ver
    // `hooks/useLiveQuestions.js`, "question_stats_updated") sin pasar por
    // toda la pantalla de generación: lo único que importa acá es el
    // efecto de `activeQuestion` sobre este botón puntual.
    emitFromBackground({
      type: 'SPARKLE_WS_EVENT',
      payload: {
        type: 'question_stats_updated',
        meetingCode,
        question,
        stats: { answeredCount: 0, skippedCount: 0, correctOptionIndex: 0, optionCounts: { a: 0, b: 0, c: 0, d: 0 } },
      },
    });

    await waitUntil(() => Boolean(findGenerateButton()?.disabled), { timeoutMs: 2000 });
    const disabledButton = findGenerateButton();
    assert.ok(disabledButton.disabled, 'Con una pregunta activa, el botón debería quedar deshabilitado.');
    assert.ok(
      /^Esperá \d+ segundos$/.test(disabledButton.textContent.trim()),
      `El texto debería ser "Esperá X segundos". Texto real: "${disabledButton.textContent.trim()}"`
    );

    // Validación defensiva — clickear el botón deshabilitado no debe abrir
    // la pantalla de generación (ningún texto propio de esa pantalla debe
    // aparecer, y el panel principal sigue mostrando "Clase en curso").
    disabledButton.click();
    await wait(100);
    assert.ok(container.textContent.includes('Clase en curso'), 'El click sobre el botón deshabilitado no debería navegar a otra pantalla.');

    // La pregunta termina — el botón vuelve solo a su estado normal.
    emitFromBackground({
      type: 'SPARKLE_WS_EVENT',
      payload: { type: 'question_finished', meetingCode, questionId: question.id, correctOptionIndex: 0 },
    });

    await waitUntil(() => Boolean(findGenerateButton() && !findGenerateButton().disabled), { timeoutMs: 2000 });
    assert.equal(findGenerateButton().textContent.trim(), 'Generar pregunta');
  } finally {
    unmount();
  }
});

test('El historial del alumno muestra "Sin responder" para una pregunta que finalizó sin que el alumno interactuara, con la respuesta correcta igual visible', async () => {
  const meetingCode = 'sin-responder-hist';
  const email = 'alumno@test.com';

  const question = {
    id: 702,
    prompt: '¿Cuál es el río más largo del mundo?',
    options: ['Amazonas', 'Nilo', 'Yangtsé', 'Misisipi'],
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
        // El alumno NUNCA respondió ni saltó — antes de que termine la
        // pregunta el REST real no la trae en absoluto; recién tras
        // "question_finished" el refetch la trae marcada 'unanswered'
        // (fuente de verdad: la base de datos, ver
        // `questionService.toStudentHistoryEntry`).
        if (myAnswersCallCount <= 1) return { answers: [] };
        return {
          answers: [
            {
              id: question.id,
              prompt: question.prompt,
              options: question.options,
              correctOptionIndex: 1,
              selectedOptionIndex: null,
              status: 'unanswered',
              finishedAt: new Date().toISOString(),
            },
          ],
        };
      }

      return { ok: true };
    },
  });

  try {
    await waitUntil(() => container.textContent.includes('¿Cuál es el río más largo del mundo?'), { timeoutMs: 3000 });

    // El alumno deja pasar la pregunta sin elegir nada ni salteatrla —
    // directo llega "question_finished" (broadcast a TODOS, respondieron o
    // no, ver `ws/handlers.js`).
    emitFromBackground({
      type: 'SPARKLE_WS_EVENT',
      payload: { type: 'question_finished', meetingCode, questionId: question.id, correctOptionIndex: 1 },
    });

    await waitUntil(() => container.textContent.includes('Sin responder'), { timeoutMs: 3000 });
    assert.ok(
      container.textContent.includes('No respondiste esta pregunta'),
      `Debería mostrar el texto "No respondiste esta pregunta". Texto: ${container.textContent}`
    );
    assert.ok(
      container.textContent.includes('Nilo'),
      `Debería mostrar igual la respuesta correcta ("Nilo"). Texto: ${container.textContent}`
    );
    assert.ok(myAnswersCallCount >= 2, 'Debería haber vuelto a consultar /questions/my-answers tras "question_finished".');
  } finally {
    unmount();
  }
});

// Etapa 84 — la carrera real detrás de la inestabilidad del test anterior
// (fallaba a veces en el CI): `activeQuestionRef` (hooks/useLiveQuestions.js)
// se ponía al día en un `useEffect`, DESPUÉS del render, y "question_finished"
// lo consulta. Un "question_finished" que llegaba en ese hueco se ignoraba y
// la pregunta quedaba abierta. Acá los dos avisos llegan en el mismo tick,
// así que el hueco está garantizado en cada corrida, no solo con la máquina
// cargada.
test('un "question_finished" que llega pegado a "question_started" igual cierra la pregunta', async () => {
  const meetingCode = 'sin-responder-pegado';
  const email = 'alumno@test.com';

  const question = {
    id: 703,
    prompt: '¿Cuál es el planeta más grande del sistema solar?',
    options: ['Marte', 'Júpiter', 'Venus', 'Tierra'],
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
            emitFromBackground({
              type: 'SPARKLE_WS_EVENT',
              payload: { type: 'question_finished', meetingCode: payload.meetingCode, questionId: question.id, correctOptionIndex: 1 },
            });
          }, 30);
        }, 30);
        return { ok: true };
      }

      if (type === 'SPARKLE_GET_MY_QUESTION_ANSWERS') {
        myAnswersCallCount += 1;
        if (myAnswersCallCount <= 1) return { answers: [] };
        return {
          answers: [
            {
              id: question.id,
              prompt: question.prompt,
              options: question.options,
              correctOptionIndex: 1,
              selectedOptionIndex: null,
              status: 'unanswered',
              finishedAt: new Date().toISOString(),
            },
          ],
        };
      }

      return { ok: true };
    },
  });

  try {
    const shown = await waitUntil(() => container.textContent.includes('No respondiste esta pregunta'), { timeoutMs: 4000 });
    assert.ok(shown, `La pregunta debería cerrarse y aparecer en el historial. Texto: ${container.textContent}`);
    assert.ok(
      !container.textContent.includes('Enviar respuesta'),
      `La pregunta no debería seguir abierta. Texto: ${container.textContent}`
    );
  } finally {
    unmount();
  }
});
