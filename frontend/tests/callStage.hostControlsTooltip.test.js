// Etapa 79 — causa real confirmada con logs de Chrome real (el usuario
// reprodujo el bug y pegó la consola completa, cerrando la investigación
// abierta desde las Etapas 77/78): al abrir el panel "Controles del
// anfitrión", Google Meet muestra el texto explicativo de un toggle
// ("Podrán volver a unirse cuando se vuelva a activar la opción") que
// matcheaba el check de Nivel A `volver a unirse` — una señal de tan alta
// confianza que, por diseño (Etapa 27), ignora `hasExitButton` por
// completo. El log confirmó que, en el momento del falso positivo,
// `hasExitButton` daba `true` (con el aria-label real "Abandonar la
// llamada" reconocido) y aun así el resultado final era `'ended'`: exactamente
// la misma familia de bug que el tooltip de hardware con "rejoin" de la
// Etapa 41, solo que esta vez del lado español, con una frase de varias
// palabras que se había asumido (incorrectamente) como suficientemente
// específica para Nivel A.
//
// El fix (`callStage.js`): `volver a unirte`/`volver a unirse` se sacan de
// `EXIT_ACTION_CHECKS_BY_LANG` (Nivel A) y pasan a
// `DOWNGRADED_EXIT_CHECKS_BY_LANG` (mismo tratamiento que `rejoin` desde
// la Etapa 41) — heredan la condición `!hasExitButton` del combo B, así
// que con el botón de salir presente ya no pueden producir `'ended'` por
// sí solas, sin importar qué texto ajeno al fin de la llamada las
// contenga.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/reactHarness.js';

function addExitButton(document, label = 'Abandonar la llamada') {
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
}

async function freshCallStage() {
  return import(`../src/utils/callStage.js?test=${Date.now()}-${Math.random()}`);
}

test('Etapa 79 — el texto exacto reportado ("Podrán volver a unirse cuando se vuelva a activar la opción") con hasExitButton=true da in-call, no ended', async () => {
  const dom = installDom({ url: 'https://meet.google.com/host-controls-1' });
  try {
    const { detectCallStage } = await freshCallStage();
    const document = dom.window.document;
    addExitButton(document, 'Abandonar la llamada');
    addFiller(document);

    // El texto explicativo real del toggle de "Controles del anfitrión",
    // tal cual lo reportó el usuario, sin ninguna otra señal de salida
    // (ni combo B, ni las frases de Nivel A que quedaron sin tocar).
    const tooltip = document.createElement('div');
    tooltip.textContent = 'Podrán volver a unirse cuando se vuelva a activar la opción.';
    document.body.appendChild(tooltip);

    assert.equal(
      detectCallStage(),
      'in-call',
      'Con el botón de salir presente, el tooltip de "Controles del anfitrión" no debería producir "ended".'
    );
  } finally {
    dom.window.close();
  }
});

test('Etapa 79 — variante "volver a unirte" con hasExitButton=true también da in-call (mismo check, otra conjugación)', async () => {
  const dom = installDom({ url: 'https://meet.google.com/host-controls-2' });
  try {
    const { detectCallStage } = await freshCallStage();
    const document = dom.window.document;
    addExitButton(document, 'Salir de la llamada');
    addFiller(document);

    const tooltip = document.createElement('div');
    tooltip.textContent = 'Vas a perder el acceso, pero vas a poder volver a unirte más tarde si querés.';
    document.body.appendChild(tooltip);

    assert.equal(detectCallStage(), 'in-call');
  } finally {
    dom.window.close();
  }
});

test('Etapa 79 — una salida real ("volver a unirse" en la pantalla de salida genuina, SIN botón de salir) sigue detectándose como ended', async () => {
  const dom = installDom({ url: 'https://meet.google.com/host-controls-3' });
  try {
    const { detectCallStage } = await freshCallStage();
    const document = dom.window.document;
    // Sin botón de salir -- la pantalla real posterior a abandonar la
    // llamada, donde `volver a unirse` SÍ debe seguir contando como señal
    // de salida (ahora vía el combo B degradado, que exige `!hasExitButton`
    // -- condición que acá se cumple).
    addFiller(document);
    const notice = document.createElement('div');
    notice.textContent = 'Dejaste la llamada. Podés volver a unirse en cualquier momento.';
    document.body.appendChild(notice);

    assert.equal(
      detectCallStage(),
      'ended',
      'Sin botón de salir, "volver a unirse" debería seguir contando como señal de salida (vía Nivel B degradado).'
    );
  } finally {
    dom.window.close();
  }
});

test('Etapa 79 — las frases de Nivel A que NO se tocaron ("volver a la pantalla de inicio") siguen pisando un botón de salir "colgado" (regresión de la Etapa 27, sin romper)', async () => {
  const dom = installDom({ url: 'https://meet.google.com/host-controls-4' });
  try {
    const { detectCallStage } = await freshCallStage();
    const document = dom.window.document;
    // Botón de salir todavía "colgado" en el DOM durante la transición real
    // hacia la pantalla de salida (Etapa 27) -- Nivel A debe seguir
    // pudiendo pisarlo para las frases que quedaron sin cambios.
    addExitButton(document, 'Salir de la llamada');
    addFiller(document);
    const notice = document.createElement('div');
    notice.textContent = 'Volver a la pantalla de inicio';
    document.body.appendChild(notice);

    assert.equal(detectCallStage(), 'ended');
  } finally {
    dom.window.close();
  }
});
