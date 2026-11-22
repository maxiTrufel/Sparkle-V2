// Etapa 77 — bug reportado: con Google Meet en español, abrir el panel
// "Personas" desde el ícono de participantes hacía que Sparkle mostrara
// "Llamada finalizada" en pleno medio de una llamada real en curso. Sin
// acceso a Chrome real no se pudo confirmar con certeza absoluta cuál fue
// la mutación puntual del DOM que disparó el falso positivo (misma
// limitación que ya documentan, por ejemplo, las Etapas 39-41 para un
// reporte similar), pero la investigación de `callStage.js` encontró y
// confirmó un mecanismo concreto y reproducible:
//
//   El ítem de menú del organizador "Finalizar la llamada para todos los
//   participantes" — siempre presente en el DOM (oculto o no, capturado
//   igual por `textContent`, ver Etapa 29) mientras la llamada sigue
//   activa — es un INFINITIVO que describe una acción disponible, no un
//   estado ya ocurrido. Antes de esta etapa, el stem `finaliz\w*` del
//   combo B de "salida" no distinguía ese infinitivo de la frase real de
//   la pantalla de salida ("Finalizaste la llamada"), y la única
//   salvaguarda que tenía ese combo contra el ítem de menú (`!botonSalir`,
//   Etapa 27/36) no es una señal perfectamente estable frente a un panel
//   lateral (como "Personas") que se monta de golpe.
//
// Este archivo prueba, en aislamiento (`callStage.js` no depende de React
// ni del backend — no hace falta bundlear `App.jsx` ni levantar un
// servidor para probarlo), las DOS capas de defensa agregadas:
//   1. El stem excluye puntualmente el infinitivo exacto — el ítem de
//      menú deja de matchear el combo B, tenga o no botón de salir
//      presente en ese instante (test 1 y 2).
//   2. `resolverConSticky()` ya no pega una transición 'in-call' → 'ended'
//      en base a una única lectura cruda — exige la misma transición en
//      dos evaluaciones seguidas, como red de contención adicional contra
//      cualquier otra lectura transitoria parecida que no se haya podido
//      identificar con certeza (test 3 y 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, wait } from './helpers/reactHarness.js';

function addExitButton(document, label = 'Salir de la llamada') {
  const btn = document.createElement('button');
  btn.setAttribute('aria-label', label);
  document.body.appendChild(btn);
  return btn;
}

function addFiller(document) {
  const filler = document.createElement('div');
  filler.textContent =
    'Contenido de relleno para simular una página de Meet ya renderizada, con ' +
    'suficiente texto visible como para superar el umbral de texto confiable de callStage.js.';
  document.body.appendChild(filler);
  return filler;
}

// El ítem de menú del organizador que motivó la hipótesis del bug (Etapa
// 36 primero, Etapa 77 después) — infinitivo, describe una acción
// disponible, no un estado ya ocurrido.
function addEndCallForEveryoneMenuItem(document) {
  const item = document.createElement('div');
  item.id = 'sparkle-test-end-for-everyone';
  item.textContent = 'Finalizar la llamada para todos los participantes';
  document.body.appendChild(item);
  return item;
}

// Cada test importa el módulo con un query string único para partir de un
// estado de módulo (sticky state) totalmente limpio — `callStage.js`
// guarda `stickyStage`/`pendingEndedConfirmation` en variables de módulo,
// así que reusar la misma instancia entre tests arrastraría estado de uno
// al siguiente.
async function freshCallStage() {
  return import(`../src/utils/callStage.js?test=${Date.now()}-${Math.random()}`);
}

test('Etapa 77 — el menú "Finalizar la llamada para todos los participantes" no rompe in-call con botón de salir presente (regresión Etapa 36)', async () => {
  const dom = installDom({ url: 'https://meet.google.com/aaa-bbbb-ccc' });
  try {
    const { detectCallStage } = await freshCallStage();
    addExitButton(dom.window.document);
    addFiller(dom.window.document);
    addEndCallForEveryoneMenuItem(dom.window.document);

    assert.equal(detectCallStage(), 'in-call');
  } finally {
    dom.window.close();
  }
});

test('Etapa 77 — el menú "Finalizar la llamada para todos los participantes" ya NO dispara el combo B de salida ni siquiera sin botón de salir (fix del infinitivo)', async () => {
  const dom = installDom({ url: 'https://meet.google.com/bbb-cccc-ddd' });
  try {
    const { detectCallStage } = await freshCallStage();
    // Sin botón de salir en el DOM -- simula el instante en que un panel
    // lateral (ej. "Personas") se monta y el botón momentáneamente no se
    // encuentra -- pero el ítem de menú del organizador SIGUE presente,
    // como estaría en una llamada real en curso.
    addFiller(dom.window.document);
    addEndCallForEveryoneMenuItem(dom.window.document);

    assert.notEqual(
      detectCallStage(),
      'ended',
      'El infinitivo "Finalizar la llamada..." no debería, por sí solo, clasificarse como salida real.'
    );
  } finally {
    dom.window.close();
  }
});

test('Etapa 77 — una salida real ("Finalizaste la llamada") sigue detectándose como salida (no se rompió el combo B)', async () => {
  const dom = installDom({ url: 'https://meet.google.com/ccc-dddd-eee' });
  try {
    const { detectCallStage } = await freshCallStage();
    addFiller(dom.window.document);
    const notice = dom.window.document.createElement('div');
    notice.textContent = 'Finalizaste la llamada para todos los participantes.';
    dom.window.document.body.appendChild(notice);

    assert.equal(detectCallStage(), 'ended');
  } finally {
    dom.window.close();
  }
});

test('Etapa 77 — un falso positivo TRANSITORIO (botón de salir ausente un instante) nunca llega a mostrarse como "ended"', async () => {
  const dom = installDom({ url: 'https://meet.google.com/ddd-eeee-fff' });
  try {
    const { watchCallStage } = await freshCallStage();
    const document = dom.window.document;
    const exitButton = addExitButton(document);
    addFiller(document);
    addEndCallForEveryoneMenuItem(document);

    const seen = [];
    const meetingCode = 'ddd-eeee-fff';
    const unsubscribe = watchCallStage((stage) => seen.push(stage), meetingCode);
    try {
      assert.equal(seen.at(-1), 'in-call', 'Estado inicial esperado: in-call.');

      // Simula el "blip" transitorio: el botón de salir desaparece un
      // instante (reflow del panel lateral) -- con el fix del infinitivo
      // ya aplicado, esto ni siquiera debería producir un `raw` de
      // 'ended' (ver el test anterior), pero esta prueba confirma además
      // que, aunque lo produjera, la capa de confirmación de dos lecturas
      // lo hubiera absorbido igual: se revierte ANTES de la segunda
      // reevaluación.
      exitButton.remove();
      await wait(450); // > debounce de 300ms del MutationObserver

      dom.window.document.body.appendChild(exitButton); // se repone antes de la 2da lectura
      await wait(450);

      assert.ok(!seen.includes('ended'), `El callback nunca debería haber recibido 'ended'. Recibidos: ${seen}`);
      assert.equal(seen.at(-1), 'in-call', 'Debería seguir (o volver a) in-call.');
    } finally {
      unsubscribe();
    }
  } finally {
    dom.window.close();
  }
});

test('Etapa 77 — una transición real a "ended" que persiste en dos lecturas seguidas SÍ se confirma (no quedó roto por la capa de confirmación)', async () => {
  const dom = installDom({ url: 'https://meet.google.com/eee-ffff-ggg' });
  try {
    const { watchCallStage } = await freshCallStage();
    const document = dom.window.document;
    const exitButton = addExitButton(document);
    addFiller(document);

    const seen = [];
    const meetingCode = 'eee-ffff-ggg';
    const unsubscribe = watchCallStage((stage) => seen.push(stage), meetingCode);
    try {
      assert.equal(seen.at(-1), 'in-call');

      // Salida real y persistente: se saca el botón de salir y se agrega
      // el texto real de la pantalla de salida -- y esta vez NO se
      // revierte, como correspondería a una salida genuina de Meet
      // (reemplaza la pantalla entera de forma estable).
      exitButton.remove();
      const notice = document.createElement('div');
      notice.textContent = 'Finalizaste la llamada para todos los participantes.';
      document.body.appendChild(notice);

      await wait(450); // 1ra lectura: 'ended' detectado, pero pendiente de confirmar -- sigue en 'in-call'
      assert.equal(seen.at(-1), 'in-call', 'La primera lectura no debería pegar todavía la transición.');

      // 2da reevaluación -- forzada con una mutación real (equivalente a
      // cualquier cambio de DOM que dispare al MutationObserver), no hace
      // falta esperar el poll de respaldo de 1.5s.
      notice.setAttribute('data-ping', '1');
      await wait(450);

      assert.equal(seen.at(-1), 'ended', 'La segunda lectura consecutiva debería confirmar la transición a ended.');
    } finally {
      unsubscribe();
    }
  } finally {
    dom.window.close();
  }
});
