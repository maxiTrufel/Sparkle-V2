// Pantallas del alumno que dependen de la IA del backend: quiz final,
// resumen de la clase y "Contenido que te perdiste". Se montan las
// pantallas REALES (vía `fixtures/pantallaHarness.jsx`) y el background se
// simula con `installChromeMock`, que responde cada pedido con lo que fije
// el test: así se recorre cada estado visible (cargando, error con
// "Reintentar", no disponible, listo) sin backend ni OpenAI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  bundleAppForTest,
  installDom,
  installChromeMock,
  waitUntil,
  cleanupTestBundles,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);

let bundle;
let responder = () => undefined;
const pedidos = [];

test.before(async () => {
  installDom({ url: 'https://meet.google.com/abc-defg-hij' });
  installChromeMock((type, payload) => {
    pedidos.push({ type, payload });
    return responder(type, payload);
  });
  bundle = require(await bundleAppForTest('tests/fixtures/pantallaHarness.jsx'));
});

test.after(async () => {
  await cleanupTestBundles();
});

function montar(pantalla, props) {
  global.window.__pantalla = pantalla;
  global.window.__props = props;
  pedidos.length = 0;
  const container = global.document.createElement('div');
  global.document.body.appendChild(container);
  bundle.mount(container);
  return {
    container,
    texto: () => container.textContent,
    boton: (etiqueta) => [...container.querySelectorAll('button')].find((b) => b.textContent.includes(etiqueta)),
    desmontar: () => {
      bundle.unmount();
      container.remove();
    },
  };
}

async function esperarTexto(vista, texto) {
  const ok = await waitUntil(() => vista.texto().includes(texto));
  assert.ok(ok, `no apareció "${texto}". Se ve: ${vista.texto()}`);
}

const PREGUNTAS_QUIZ = [
  { type: 'multiple_choice', prompt: '¿Qué absorbe la clorofila?', options: ['Luz', 'Agua', 'Sal', 'Aire'], correctOptionIndex: 0, explanation: 'Absorbe luz.' },
  { type: 'true_false', prompt: 'La fotosíntesis libera oxígeno.', options: ['Verdadero', 'Falso'], correctOptionIndex: 0, explanation: null },
];

// ─── Quiz final ──────────────────────────────────────────────────────────

test('Quiz final: carga, se responde, muestra el resultado con la explicación y permite pedir otro', async () => {
  responder = (type) => (type === 'SPARKLE_GET_FINAL_QUIZ' ? { status: 200, body: { quizAvailable: true, questions: PREGUNTAS_QUIZ } } : undefined);
  let volvio = false;
  const vista = montar('FinalQuiz', { meetingCode: 'abc', email: 'ana@test.com', onBack: () => { volvio = true; } });
  try {
    await esperarTexto(vista, '¿Qué absorbe la clorofila?');
    assert.deepEqual(pedidos.find((p) => p.type === 'SPARKLE_GET_FINAL_QUIZ').payload, { meetingCode: 'abc', email: 'ana@test.com' });
    assert.ok(vista.texto().includes('Verdadero o falso'));
    assert.equal(vista.boton('Ver resultado').disabled, true, 'sin responder todo no se puede corregir');

    // Opción múltiple: elige "Agua" (incorrecta). V/F: elige "Verdadero" (correcta).
    // Un clic por vez, como una persona: React aplica la elección en el
    // render siguiente y el segundo clic tiene que ver la primera.
    vista.boton('Agua').click();
    await waitUntil(() => vista.boton('Agua').className.includes('picked'));
    vista.boton('Verdadero').click();
    assert.ok(await waitUntil(() => !vista.boton('Ver resultado').disabled));
    vista.boton('Ver resultado').click();

    await esperarTexto(vista, 'Acertaste 1 de 2');
    assert.ok(vista.texto().includes('Incorrecta'));
    assert.ok(vista.texto().includes('Correcta'));
    assert.ok(vista.texto().includes('Absorbe luz.'));
    assert.ok(vista.boton('Agua').disabled, 'corregido, ya no se puede cambiar la respuesta');

    vista.boton('Hacer otro quiz').click();
    await waitUntil(() => pedidos.filter((p) => p.type === 'SPARKLE_GET_FINAL_QUIZ').length === 2);
    vista.boton('Volver').click();
    assert.equal(volvio, true);
  } finally {
    vista.desmontar();
  }
});

test('Quiz final: "no disponible" según el motivo, y error con "Reintentar"', async () => {
  responder = () => ({ status: 200, body: { quizAvailable: false, unavailableReason: 'insufficient_content' } });
  let vista = montar('FinalQuiz', { meetingCode: 'abc', email: 'ana@test.com', onBack() {} });
  try {
    await esperarTexto(vista, 'no tuvo suficiente contenido');
  } finally {
    vista.desmontar();
  }

  responder = () => ({ status: 200, body: { quizAvailable: false, unavailableReason: 'motivo_nuevo' } });
  vista = montar('FinalQuiz', { meetingCode: 'abc', email: 'ana@test.com', onBack() {} });
  try {
    await esperarTexto(vista, 'no está disponible por ahora');
  } finally {
    vista.desmontar();
  }

  let intentos = 0;
  responder = () => {
    intentos += 1;
    if (intentos === 1) return { status: 403, body: { error: 'Solo para alumnos.' } };
    if (intentos === 2) return { status: 500, body: {} };
    return { status: 200, body: { quizAvailable: true, questions: PREGUNTAS_QUIZ } };
  };
  vista = montar('FinalQuiz', { meetingCode: 'abc', email: 'ana@test.com', onBack() {} });
  try {
    await esperarTexto(vista, 'Solo para alumnos.');
    vista.boton('Reintentar').click();
    await esperarTexto(vista, 'No se pudo armar el quiz.');
    vista.boton('Reintentar').click();
    await esperarTexto(vista, '¿Qué absorbe la clorofila?');
  } finally {
    vista.desmontar();
  }
});

test('Quiz final: con un quiz ya guardado no vuelve a pedirlo, y sin email no pide nada', async () => {
  responder = () => { throw new Error('no debería pedirse'); };
  let vista = montar('FinalQuiz', {
    meetingCode: 'abc', email: 'ana@test.com', onBack() {},
    quizState: { status: 'ready', questions: PREGUNTAS_QUIZ, selected: [0, 1], submitted: true },
  });
  try {
    await esperarTexto(vista, 'Acertaste 1 de 2');
    assert.equal(pedidos.length, 0);
  } finally {
    vista.desmontar();
  }

  vista = montar('FinalQuiz', { meetingCode: 'abc', email: null, onBack() {} });
  try {
    await esperarTexto(vista, 'Armando tu quiz');
    assert.equal(pedidos.length, 0);
  } finally {
    vista.desmontar();
  }
});

// ─── Resumen de la clase ─────────────────────────────────────────────────

test('Resumen de la clase: bullets de lo explicado y repaso de cada pregunta según cómo respondió', async () => {
  responder = () => ({
    status: 200,
    body: {
      aiSummaryAvailable: true,
      summarySource: 'transcript',
      bullets: ['Se explicó la fotosíntesis.', 'Se vio la respiración celular.'],
      review: {
        congratulations: false,
        items: [
          { id: 1, prompt: '¿P1?', status: 'correct', yourAnswer: 'Luz', correctAnswer: 'Luz', relatedConcept: 'Clorofila' },
          { id: 2, prompt: '¿P2?', status: 'incorrect', yourAnswer: 'Sal', correctAnswer: 'Agua', relatedConcept: null },
          { id: 3, prompt: '¿P3?', status: 'skipped', yourAnswer: null, correctAnswer: 'CO2' },
          { id: 4, prompt: '¿P4?', status: 'unanswered', yourAnswer: null, correctAnswer: 'O2' },
        ],
      },
    },
  });
  const vista = montar('ClassSummary', { meetingCode: 'abc', email: 'ana@test.com', onBack() {} });
  try {
    await esperarTexto(vista, 'Se explicó la fotosíntesis.');
    const texto = vista.texto();
    for (const esperado of ['Lo que se explicó', 'Para repasar', 'Acertada', 'Errada', 'No respondió', 'Sin responder',
      'Tu respuesta: Luz', 'Elegiste Sal — correcta: Agua', 'Correcta: CO2', 'Concepto relacionado: Clorofila']) {
      assert.ok(texto.includes(esperado), `falta "${esperado}"`);
    }
  } finally {
    vista.desmontar();
  }
});

test('Resumen de la clase: armado con el material se titula distinto; sin IA explica por qué; felicita si acertó todo', async () => {
  responder = () => ({
    status: 200,
    body: {
      aiSummaryAvailable: true, summarySource: 'document', bullets: ['Tema del material'],
      review: { congratulations: true, items: [{ id: 1, prompt: '¿P1?', status: 'correct', yourAnswer: 'A', correctAnswer: 'A' }] },
    },
  });
  let vista = montar('ClassSummary', { meetingCode: 'abc', email: 'ana@test.com', onBack() {} });
  try {
    await esperarTexto(vista, 'Temas del material');
    assert.ok(vista.texto().includes('Respondiste bien todas las preguntas'));
  } finally {
    vista.desmontar();
  }

  for (const [motivo, mensaje] of [['insufficient_transcript', 'muy poca transcripción'], [null, 'no está disponible por ahora']]) {
    responder = () => ({ status: 200, body: { aiSummaryAvailable: false, summaryUnavailableReason: motivo, review: null } });
    vista = montar('ClassSummary', { meetingCode: 'abc', email: 'ana@test.com', onBack() {} });
    try {
      await esperarTexto(vista, mensaje);
      assert.ok(!vista.texto().includes('Para repasar'));
    } finally {
      vista.desmontar();
    }
  }
});

test('Resumen de la clase: un error se muestra con "Reintentar", que vuelve a pedirlo', async () => {
  let intentos = 0;
  responder = () => {
    intentos += 1;
    if (intentos === 1) return { status: 409, body: { error: 'La clase todavía no terminó.' } };
    if (intentos === 2) return { status: 500, body: {} };
    return { status: 200, body: { aiSummaryAvailable: true, bullets: ['Listo.'] } };
  };
  let volvio = false;
  const vista = montar('ClassSummary', { meetingCode: 'abc', email: 'ana@test.com', onBack: () => { volvio = true; } });
  try {
    await esperarTexto(vista, 'La clase todavía no terminó.');
    vista.boton('Reintentar').click();
    await esperarTexto(vista, 'No se pudo generar el resumen de la clase.');
    vista.boton('Reintentar').click();
    await esperarTexto(vista, 'Listo.');
    vista.boton('Volver').click();
    assert.equal(volvio, true);
  } finally {
    vista.desmontar();
  }
});

// ─── Contenido que te perdiste ───────────────────────────────────────────

test('Recuperar contenido: muestra los temas del tramo, o el motivo si no hay', async () => {
  const casos = [
    [{ aiSummaryAvailable: true, bullets: ['La membrana regula el paso de sustancias.'], windowMinutes: 3 }, 'La membrana regula'],
    [{ aiSummaryAvailable: false, unavailableReason: 'ai_disabled', bullets: null }, 'no está disponible por ahora'],
    [{ aiSummaryAvailable: false, unavailableReason: 'insufficient_content', bullets: null }, 'No hubo actividad reciente'],
  ];
  for (const [body, esperado] of casos) {
    responder = () => ({ status: 200, body });
    const vista = montar('RecoverySummary', { meetingCode: 'abc', email: 'ana@test.com', onBack() {} });
    try {
      await esperarTexto(vista, esperado);
      assert.ok(vista.texto().includes('Contenido que te perdiste'));
    } finally {
      vista.desmontar();
    }
  }
});

test('Recuperar contenido: error con "Reintentar"; sin email no pide nada', async () => {
  let intentos = 0;
  responder = () => {
    intentos += 1;
    if (intentos === 1) return { status: 502, body: { error: 'No se pudo generar el resumen con IA.' } };
    if (intentos === 2) return { status: 500, body: {} };
    return { status: 200, body: { aiSummaryAvailable: true, bullets: ['Recuperado.'] } };
  };
  let vista = montar('RecoverySummary', { meetingCode: 'abc', email: 'ana@test.com', onBack() {} });
  try {
    await esperarTexto(vista, 'No se pudo generar el resumen con IA.');
    vista.boton('Reintentar').click();
    await esperarTexto(vista, 'No se pudo generar el resumen de contenido.');
    vista.boton('Reintentar').click();
    await esperarTexto(vista, 'Recuperado.');
  } finally {
    vista.desmontar();
  }

  vista = montar('RecoverySummary', { meetingCode: 'abc', email: '', onBack() {} });
  try {
    await esperarTexto(vista, 'Generando el resumen');
    assert.equal(pedidos.length, 0);
  } finally {
    vista.desmontar();
  }
});

test('Sala de espera: avisa que se está esperando para entrar a la reunión', async () => {
  const vista = montar('LobbyScreen', {});
  try {
    await esperarTexto(vista, 'Esperando para ingresar a la reunión...');
  } finally {
    vista.desmontar();
  }
});
