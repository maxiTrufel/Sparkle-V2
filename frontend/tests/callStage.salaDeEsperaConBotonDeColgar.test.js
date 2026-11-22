// Etapa 83 — bug reportado con captura de Chrome real: esperando que el
// anfitrión admita a la persona ("Still trying to get in…" / "Please wait
// until a meeting host brings you into the call"), el panel mostraba
// Welcome y dejaba elegir rol. Meet ahora pone en esa pantalla la barra de
// botones de la llamada, con el botón rojo de colgar: con botón de salir y
// texto de lobby a la vez, `detectCallStage()` daba 'undetermined', y esa
// lectura quedaba pegada. La Etapa 38 se había probado sin ese botón.
//
// Mismo esquema que `callStage.personasPanel.test.js`: `callStage.js` se
// prueba solo, sin React ni backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, wait } from './helpers/reactHarness.js';

function addExitButton(document, label = 'Leave call') {
  const btn = document.createElement('button');
  btn.setAttribute('aria-label', label);
  document.body.appendChild(btn);
  return btn;
}

function addText(document, text) {
  const div = document.createElement('div');
  div.textContent = text;
  document.body.appendChild(div);
  return div;
}

function addFiller(document) {
  return addText(
    document,
    'Contenido de relleno para simular una página de Meet ya renderizada, con ' +
      'suficiente texto visible como para superar el umbral de texto confiable de callStage.js.'
  );
}

// Estado de módulo (sticky) limpio en cada test — ver el mismo helper en
// `callStage.personasPanel.test.js`.
async function freshCallStage() {
  return import(`../src/utils/callStage.js?test=${Date.now()}-${Math.random()}`);
}

test('Etapa 83 — la pantalla real de la captura (EN), con botón de colgar, da lobby', async () => {
  installDom({ url: 'https://meet.google.com/aaa-bbbb-ccc' });
  const { detectCallStage } = await freshCallStage();
  addExitButton(document);
  addFiller(document);
  addText(document, 'Still trying to get in...');
  addText(document, 'Please wait until a meeting host brings you into the call');

  assert.equal(detectCallStage(), 'lobby');
});

test('Etapa 83 — la misma pantalla en español, con botón de colgar, da lobby', async () => {
  installDom({ url: 'https://meet.google.com/ddd-eeee-fff' });
  const { detectCallStage } = await freshCallStage();
  addExitButton(document, 'Abandonar la llamada');
  addFiller(document);
  addText(document, 'Espera a que un anfitrión de la reunión te agregue a la llamada');

  assert.equal(detectCallStage(), 'lobby');
});

test('Etapa 83 — "Still trying to get in" solo (sin el subtítulo) también da lobby', async () => {
  installDom({ url: 'https://meet.google.com/ggg-hhhh-iii' });
  const { detectCallStage } = await freshCallStage();
  addExitButton(document);
  addFiller(document);
  addText(document, 'Still trying to get in...');

  assert.equal(detectCallStage(), 'lobby');
});

test('Etapa 83 — adentro de la llamada, un "Join now" genérico (sala para grupos) NO manda a lobby', async () => {
  installDom({ url: 'https://meet.google.com/jjj-kkkk-lll' });
  const { detectCallStage } = await freshCallStage();
  addExitButton(document);
  addFiller(document);
  addText(document, 'You have been invited to a breakout room. Join now');

  assert.notEqual(detectCallStage(), 'lobby');
});

test('Etapa 83 — con el panel ya en in-call, al pasar a esperar al anfitrión cambia a lobby, y al ser admitido vuelve a in-call', async () => {
  installDom({ url: 'https://meet.google.com/mmm-nnnn-ooo' });
  const { watchCallStage } = await freshCallStage();
  addExitButton(document);
  addFiller(document);

  const stages = [];
  const unsubscribe = watchCallStage((stage) => stages.push(stage), 'mmm-nnnn-ooo');
  try {
    assert.equal(stages.at(-1), 'in-call');

    // Por ejemplo, un instante de "Asking to join…" leído como in-call antes
    // de que Meet pinte el texto de espera.
    const waiting = addText(document, 'Please wait until a meeting host brings you into the call');
    await wait(500);
    assert.equal(stages.at(-1), 'lobby', `Estados recibidos: ${stages.join(' → ')}`);

    // El anfitrión la admite: el texto de espera desaparece. Viniendo de
    // 'lobby', el paso a 'in-call' se confirma recién si se mantiene 2,5 s
    // (ver el test siguiente), y el poll de respaldo reevalúa cada 1,5 s.
    waiting.remove();
    await wait(500);
    assert.equal(stages.at(-1), 'lobby', 'Todavía sin confirmar la entrada');
    await wait(4000);
    assert.equal(stages.at(-1), 'in-call', `Estados recibidos: ${stages.join(' → ')}`);
  } finally {
    unsubscribe();
  }
});

test('Etapa 83 — al tocar "Ask to join", la pantalla de transición (botón de colgar, todavía sin texto de espera) NO muestra un instante de in-call', async () => {
  installDom({ url: 'https://meet.google.com/ppp-qqqq-rrr' });
  const { watchCallStage } = await freshCallStage();
  addFiller(document);
  const lobbyButton = addText(document, 'Ask to join');

  const stages = [];
  const unsubscribe = watchCallStage((stage) => stages.push(stage), 'ppp-qqqq-rrr');
  try {
    assert.equal(stages.at(-1), 'lobby');

    // Toca "Ask to join": Meet cambia a "Connecting…" con la barra de la
    // llamada (botón de colgar) y, 1-2 s después, pinta el texto de espera.
    lobbyButton.remove();
    addText(document, 'Connecting...');
    addExitButton(document);
    await wait(1500);
    addText(document, 'Please wait until a meeting host brings you into the call');
    await wait(2500);

    assert.ok(!stages.includes('in-call'), `Nunca debería pasar por in-call. Estados recibidos: ${stages.join(' → ')}`);
    assert.equal(stages.at(-1), 'lobby');
  } finally {
    unsubscribe();
  }
});
