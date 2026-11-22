// Pantallas y paneles del docente montados aislados (vía
// `fixtures/pantallaHarness.jsx`): generar una pregunta con IA (vista
// previa → enviar), las estadísticas de atención de la clase, los paneles
// de configuración de la detección y los registros de depuración.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  bundleAppForTest,
  installDom,
  installChromeMock,
  waitUntil,
  wait,
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

// Un <input type="range"> controlado por React solo se entera del cambio si
// el valor se asigna con el setter nativo y después se dispara "input".
function moverSlider(input, valor) {
  const setter = Object.getOwnPropertyDescriptor(global.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, String(valor));
  input.dispatchEvent(new global.window.Event('input', { bubbles: true }));
}

// ─── Generar pregunta ────────────────────────────────────────────────────

function vistaPrevia(n, sugerido = 45) {
  return {
    prompt: `¿Pregunta generada ${n}?`,
    options: [`Correcta ${n}`, `Otra ${n}a`, `Otra ${n}b`, `Otra ${n}c`],
    correctOptionIndex: 0,
    suggestedDurationSeconds: sugerido,
  };
}

test('Generar pregunta: muestra la vista previa con la correcta marcada, el tiempo sugerido, y descarta temas al pedir otra', async () => {
  let n = 0;
  responder = (type) => {
    if (type === 'SPARKLE_GENERATE_QUESTION') {
      n += 1;
      return vistaPrevia(n, n === 1 ? 45 : 999);
    }
    return { ok: true };
  };
  const vista = montar('GenerateQuestion', {
    meetingCode: 'abc', email: 'docente@test.com', activeQuestion: null, questionSendError: null,
    clearQuestionSendError() {}, onBack() {}, onQuestionSent() {},
  });
  try {
    await esperarTexto(vista, '¿Pregunta generada 1?');
    assert.ok(vista.texto().includes('Correcta'), 'la opción correcta se marca para el docente');
    assert.ok(vista.texto().includes('45s'), 'toma la duración sugerida si es uno de los presets');

    vista.boton('15s').click();
    await waitUntil(() => vista.boton('15s').className.includes('active'));

    vista.boton('Generar otra pregunta').click();
    await esperarTexto(vista, '¿Pregunta generada 2?');
    const segundo = pedidos.filter((p) => p.type === 'SPARKLE_GENERATE_QUESTION')[1];
    assert.deepEqual(segundo.payload.discardedPrompts, ['¿Pregunta generada 1?']);
    assert.ok(vista.boton('15s').className.includes('active'), 'una sugerencia fuera de los presets no pisa la elección');
  } finally {
    vista.desmontar();
  }
});

test('Generar pregunta: "Enviar" manda la pregunta con la duración elegida y vuelve cuando la pregunta queda activa', async () => {
  responder = (type) => (type === 'SPARKLE_GENERATE_QUESTION' ? vistaPrevia(1, 30) : { ok: true });
  let enviada = null;
  let volvio = 0;
  let limpiezas = 0;
  const vista = montar('GenerateQuestion', {
    meetingCode: 'abc', email: 'docente@test.com', activeQuestion: { id: 3 }, questionSendError: null,
    clearQuestionSendError: () => { limpiezas += 1; }, onBack: () => { volvio += 1; }, onQuestionSent: (id) => { enviada = id; },
  });
  try {
    await esperarTexto(vista, '¿Pregunta generada 1?');
    vista.boton('60s').click();
    await waitUntil(() => vista.boton('60s').className.includes('active'));
    vista.boton('Enviar pregunta').click();
    await esperarTexto(vista, 'Enviando…');
    assert.equal(limpiezas, 1);
    const envio = pedidos.find((p) => p.type === 'SPARKLE_WS_SEND_QUESTION');
    assert.deepEqual(envio.payload.question, {
      prompt: '¿Pregunta generada 1?', options: vistaPrevia(1).options, correctOptionIndex: 0, durationSeconds: 60,
    });

    // Llega por WS la pregunta nueva (id distinto a la que había).
    global.window.__harness.setProps({ activeQuestion: { id: 4 } });
    assert.ok(await waitUntil(() => enviada === 4));
    assert.equal(volvio, 1);
  } finally {
    vista.desmontar();
  }
});

test('Generar pregunta: errores al generar y al enviar se muestran sin perder la vista previa', async () => {
  let n = 0;
  responder = (type) => {
    if (type === 'SPARKLE_GENERATE_QUESTION') {
      n += 1;
      if (n === 1) return { error: 'Solo el docente de esta clase puede generar preguntas.' };
      if (n === 2) throw new Error('Sin conexión con el servidor.');
      return vistaPrevia(n);
    }
    if (type === 'SPARKLE_WS_SEND_QUESTION') throw new Error('WebSocket no conectado a esa sala todavía.');
    return undefined;
  };
  const vista = montar('GenerateQuestion', {
    meetingCode: 'abc', email: 'docente@test.com', activeQuestion: null, questionSendError: null,
    clearQuestionSendError() {}, onBack() {}, onQuestionSent() {},
  });
  try {
    await esperarTexto(vista, 'No se pudo generar una pregunta: Solo el docente');
    assert.ok(vista.boton('Enviar pregunta').disabled, 'sin vista previa no se puede enviar');
    vista.boton('Generar otra pregunta').click();
    await esperarTexto(vista, 'Sin conexión con el servidor.');
    vista.boton('Generar otra pregunta').click();
    await esperarTexto(vista, '¿Pregunta generada 3?');

    vista.boton('Enviar pregunta').click();
    await esperarTexto(vista, 'WebSocket no conectado');
    assert.ok(vista.texto().includes('¿Pregunta generada 3?'));
  } finally {
    vista.desmontar();
  }
});

test('Generar pregunta: un rechazo del servidor (por WS) durante el envío corta el "Enviando…"', async () => {
  responder = (type) => (type === 'SPARKLE_GENERATE_QUESTION' ? vistaPrevia(1) : new Promise(() => {}));
  const vista = montar('GenerateQuestion', {
    meetingCode: 'abc', email: 'docente@test.com', activeQuestion: null, questionSendError: null,
    clearQuestionSendError() {}, onBack() {}, onQuestionSent() {},
  });
  try {
    await esperarTexto(vista, '¿Pregunta generada 1?');
    vista.boton('Enviar pregunta').click();
    await esperarTexto(vista, 'Enviando…');
    global.window.__harness.setProps({ questionSendError: 'Ya hay una pregunta activa en esta clase.' });
    await esperarTexto(vista, 'Ya hay una pregunta activa');
    assert.ok(await waitUntil(() => vista.texto().includes('Enviar pregunta')));
  } finally {
    vista.desmontar();
  }
});

// ─── Estadísticas de atención ────────────────────────────────────────────

function historial(minutos, { desde = Date.now() - minutos * 60_000 } = {}) {
  // Una foto cada 30 s; cada 4 fotos una con el grupo desatento.
  return Array.from({ length: minutos * 2 }, (_, i) => ({
    ts: desde + i * 30_000,
    pctAttentive: i % 4 === 0 ? 20 : 80,
    groupInattentive: i % 4 === 0,
    source: i < minutos ? 'historical' : 'live',
  }));
}

test('Estadísticas de atención: cantidad de alumnos, mapa de calor por tramos de 5 minutos y curva grupal', async () => {
  const vista = montar('ConcentrationStats', {
    onBack() {}, roster: [{ anonId: 'a' }, { anonId: 'b' }, { anonId: 'c' }], pThreshold: 0.45,
    classStarted: true, history: historial(12), historyLoading: false, windowStartedAt: new Date(Date.now() - 95_000).toISOString(),
  });
  try {
    await esperarTexto(vista, 'Atención de la clase');
    assert.ok(vista.texto().includes('Alumnos monitoreados por IA3'));
    assert.ok(vista.texto().includes('en tiempo real'));
    assert.ok(!vista.texto().includes('Clase detenida'));
    for (const tramo of ['+0min', '+5min', '+10min']) {
      assert.ok(vista.texto().includes(tramo), `falta el tramo ${tramo} del mapa de calor`);
    }
    assert.ok(await waitUntil(() => vista.container.querySelector('canvas')), `la curva se dibuja en un canvas. Se ve: ${vista.texto()}`);
  } finally {
    vista.desmontar();
  }
});

test('Estadísticas de atención: con la clase detenida lo aclara; sin datos muestra los estados vacíos', async () => {
  let vista = montar('ConcentrationStats', {
    onBack() {}, roster: [], pThreshold: null, classStarted: false, history: historial(3), historyLoading: false,
  });
  try {
    await esperarTexto(vista, 'Clase detenida');
    assert.ok(vista.texto().includes('datos registrados hasta ahora'));
  } finally {
    vista.desmontar();
  }

  let volvio = false;
  vista = montar('ConcentrationStats', { onBack: () => { volvio = true; }, history: [], historyLoading: true });
  try {
    await esperarTexto(vista, 'La curva aparecerá en cuanto haya datos');
    global.window.__harness.setProps({ historyLoading: false });
    await wait(30);
    vista.boton('Volver').click();
    assert.equal(volvio, true);
  } finally {
    vista.desmontar();
  }
});
