// Etapa 82 — el email de la cuenta cuando se entra DIRECTO a la llamada.
//
// Reproducido en Chrome real: con una reunión instantánea (sin sala de
// espera), el único lugar con el email es el cartel "Your meeting's ready /
// Joined as …". Si Meet lo mostraba después de los ~2,5 s de reintentos del
// boot, el email quedaba en `null` para siempre, y cuando el cartel se iba
// ni "Reintentar" lo encontraba. Estos tests fijan el arreglo:
//   - la vigilancia sigue mirando la página y, cuando aparece el email,
//     consulta el rol sola, sin ningún click;
//   - si la página nunca lo muestra, se usa el que la pestaña ya había visto
//     (página de inicio de Meet, sala de espera);
//   - adentro de la llamada no se toma un email suelto del texto (chat).
//
// No necesitan backend ni base de datos: el rol se responde con un mock.
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
import { detectGoogleAccountEmail } from '../src/utils/detectEmail.js';
import { getTabEmail, watchEmailOutsideCall } from '../src/utils/emailMemory.js';

const require = createRequire(import.meta.url);
const CLAVE_MEMORIA = 'sparkle_email_de_esta_pestana';

test.after(async () => {
  await cleanupTestBundles();
});

// jsdom no implementa `innerText`, que usan las estrategias 2 y 3 de
// `detectEmail.js`. Para estos tests alcanza con el texto del nodo.
function installInnerText(dom) {
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent;
    },
  });
}

function addText(dom, text) {
  const div = dom.window.document.createElement('div');
  div.textContent = text;
  dom.window.document.body.appendChild(div);
  return div;
}

function addAccountButton(dom, email) {
  const account = dom.window.document.createElement('div');
  account.setAttribute('aria-label', `Cuenta de Google: Test (${email})`);
  dom.window.document.body.appendChild(account);
}

// Llamada ya unida SIN ningún rastro del email: solo lo mínimo para que
// `callStage.js` resuelva 'in-call' (mismo DOM que el test de "carga fría"
// de `App.confirmarDocenteYVolver.test.js`).
function installInCallDom(meetingCode) {
  const dom = installDom({ url: `https://meet.google.com/${meetingCode}` });
  installInnerText(dom);
  const exitButton = dom.window.document.createElement('button');
  exitButton.setAttribute('aria-label', 'Leave call');
  dom.window.document.body.appendChild(exitButton);
  addText(
    dom,
    'Contenido de relleno para simular una página de Meet ya renderizada, con ' +
      'suficiente texto visible como para no disparar la ventana de gracia de ' +
      'callStage.js pensada para un DOM recién montado y todavía casi vacío.'
  );
  return dom;
}

async function mountApp(dom) {
  const roleQueries = [];
  installChromeMock(async (type, payload) => {
    if (type === 'SPARKLE_GET_ROLE') {
      roleQueries.push(payload.email);
      return { role: null };
    }
    if (type === 'SPARKLE_GET_HAS_TEACHER') return { hasTeacher: false };
    return { ok: true };
  });

  const bundlePath = await bundleAppForTest('src/App.jsx');
  const { mount, unmount } = require(bundlePath);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  mount(container);
  return { container, roleQueries, unmount };
}

test('detectGoogleAccountEmail: sin permiso para el texto plano ignora un email suelto, pero sí lee el cartel "Joined as"', () => {
  const dom = installDom({ url: 'https://meet.google.com/jjj-kkkk-lll' });
  installInnerText(dom);
  addText(dom, 'Chat: escribime a otra.persona@test.com');

  assert.equal(detectGoogleAccountEmail({ allowPlainText: false }), null);
  assert.equal(detectGoogleAccountEmail(), 'otra.persona@test.com');

  addText(dom, 'Joined as cuenta@test.com');
  assert.equal(detectGoogleAccountEmail({ allowPlainText: false }), 'cuenta@test.com');
});

test('página de inicio de Meet: se anota el email del botón de cuenta, y no un email suelto de la página', async () => {
  const dom = installDom({ url: 'https://meet.google.com/landing' });
  installInnerText(dom);
  addText(dom, 'Próxima reunión con organizador@test.com');

  const stop = watchEmailOutsideCall();
  try {
    await wait(1200);
    assert.equal(getTabEmail(), null, 'Un email suelto de la página de inicio no se anota');

    addAccountButton(dom, 'cuenta@test.com');
    const saved = await waitUntil(() => getTabEmail() === 'cuenta@test.com', { timeoutMs: 2500 });
    assert.ok(saved, `Debería anotar el email del botón de cuenta. Anotado: ${getTabEmail()}`);
  } finally {
    stop();
  }
});

test('entra directo a la llamada y el cartel "Joined as" aparece TARDE: la vigilancia lo toma y consulta el rol sola', async () => {
  const email = 'docente-cartel-tarde@test.com';
  const dom = installInCallDom('aaa-bbbb-ccc');
  const { container, roleQueries, unmount } = await mountApp(dom);

  try {
    // El boot agota sus reintentos sin email y muestra Welcome igual.
    const reachedWelcome = await waitUntil(() => container.textContent.includes('Soy Docente'), {
      timeoutMs: 6000,
    });
    assert.ok(reachedWelcome, `Debería llegar a Welcome sin email. Texto: ${container.textContent}`);
    assert.deepEqual(roleQueries, [], 'Sin email todavía no se puede consultar ningún rol');

    // Recién ahora Meet muestra el cartel — como en la carga lenta real.
    addText(dom, `Your meeting's ready. Joined as ${email}`);

    const queried = await waitUntil(() => roleQueries.includes(email), { timeoutMs: 3000 });
    assert.ok(queried, `La vigilancia debería consultar el rol con el email del cartel. Consultas: ${roleQueries}`);
    const shown = await waitUntil(() => container.textContent.includes(email), { timeoutMs: 2000 });
    assert.ok(shown, 'El encabezado del panel debería mostrar el email');
    assert.equal(dom.window.sessionStorage.getItem(CLAVE_MEMORIA), email, 'Y quedar anotado en la pestaña');
  } finally {
    unmount();
  }
});

test('la página nunca muestra el email, pero la pestaña ya lo había visto: se usa el anotado', async () => {
  const email = 'docente-memoria@test.com';
  const dom = installInCallDom('ddd-eeee-fff');
  dom.window.sessionStorage.setItem(CLAVE_MEMORIA, email);
  const { container, roleQueries, unmount } = await mountApp(dom);

  try {
    const queried = await waitUntil(() => roleQueries.includes(email), { timeoutMs: 6000 });
    assert.ok(queried, `Debería consultar el rol con el email anotado. Consultas: ${roleQueries}`);
    const shown = await waitUntil(() => container.textContent.includes(email), { timeoutMs: 2000 });
    assert.ok(shown, 'El encabezado del panel debería mostrar el email anotado');
  } finally {
    unmount();
  }
});

test('adentro de la llamada, un email escrito en el chat NO se toma como el de la cuenta', async () => {
  const dom = installInCallDom('ggg-hhhh-iii');
  addText(dom, 'Chat: escribime a otra.persona@test.com');
  const { container, roleQueries, unmount } = await mountApp(dom);

  try {
    await waitUntil(() => container.textContent.includes('Soy Docente'), { timeoutMs: 6000 });
    await wait(1500); // al menos una pasada de la vigilancia
    assert.deepEqual(roleQueries, [], `No debería consultar ningún rol. Consultas: ${roleQueries}`);
    assert.ok(!container.textContent.includes('otra.persona@test.com'), 'El panel no debería mostrar el email del chat');
  } finally {
    unmount();
  }
});
