// Ciclo de vida del documento offscreen y puente de eventos de atención
// (`background/attentionOffscreen.js`), con un `chrome` simulado que
// registra cada llamada. El módulo guarda estado (pestañas suscriptas,
// permiso pedido), así que los tests de este archivo corren en orden y cada
// uno parte de lo que dejó el anterior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startDetection,
  stopDetection,
  configureDetection,
  registerEventBridge,
  cleanupTab,
} from '../src/background/attentionOffscreen.js';

const llamadas = [];
let offscreenAbierto = false;
let listener = null;
let pestanasPermiso = [];
let pestanasMeet = [];
let siguienteId = 100;

function registrar(nombre, ...args) {
  llamadas.push([nombre, ...args]);
}

globalThis.chrome = {
  runtime: {
    getURL: (ruta) => `chrome-extension://id/${ruta}`,
    getContexts: async (filtro) => {
      registrar('getContexts', filtro.contextTypes[0]);
      return offscreenAbierto ? [{ documentUrl: filtro.documentUrls[0] }] : [];
    },
    sendMessage: async (mensaje) => {
      registrar('sendMessage', mensaje.type, mensaje.payload);
      if (mensaje.type === 'configure_detection') return { configuration: mensaje.payload };
      return undefined;
    },
    onMessage: { addListener: (fn) => { listener = fn; } },
  },
  offscreen: {
    createDocument: async (opciones) => {
      registrar('createDocument', opciones.reasons[0]);
      await new Promise((r) => setTimeout(r, 5));
      offscreenAbierto = true;
    },
    closeDocument: async () => {
      registrar('closeDocument');
      offscreenAbierto = false;
    },
  },
  tabs: {
    query: async ({ url }) => (url.includes('permission.html') ? pestanasPermiso : pestanasMeet),
    get: async (id) => {
      if (id === 999) throw new Error('No tab with id');
      return { id, windowId: 7, index: 2 };
    },
    create: async (opciones) => {
      registrar('tabs.create', opciones);
      siguienteId += 1;
      return { id: siguienteId, windowId: opciones.windowId ?? 1 };
    },
    update: async (id, opciones) => {
      registrar('tabs.update', id, opciones);
      return { id, windowId: 7 };
    },
    sendMessage: async (id, mensaje) => {
      registrar('tabs.sendMessage', id, mensaje.type, mensaje.payload);
    },
  },
  windows: { update: async (id, opciones) => registrar('windows.update', id, opciones) },
};

const tipos = () => llamadas.map((l) => (l[0] === 'sendMessage' ? `send:${l[1]}` : l[0]));
const limpiar = () => { llamadas.length = 0; };
const esperar = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('startDetection crea el offscreen UNA sola vez aunque dos pestañas arranquen a la vez, y lo configura antes de arrancar', async () => {
  const [a, b] = await Promise.all([startDetection(1), startDetection(2)]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: true });
  assert.equal(llamadas.filter((l) => l[0] === 'createDocument').length, 1);
  const orden = tipos().filter((t) => t.startsWith('send:'));
  assert.deepEqual(orden, ['send:configure_detection', 'send:start_detection', 'send:configure_detection', 'send:start_detection']);
  assert.deepEqual(llamadas.find((l) => l[1] === 'configure_detection')[2], { threshold: 0.5, predictionIntervalMs: 2000 });
});

test('configureDetection mezcla la configuración y la aplica en el momento si el offscreen está abierto', async () => {
  limpiar();
  const respuesta = await configureDetection({ threshold: 0.7 });
  assert.equal(respuesta.appliedNow, true);
  assert.deepEqual(respuesta.configuration, { threshold: 0.7, predictionIntervalMs: 2000 });
});

test('stopDetection solo cierra el offscreen cuando se va la ÚLTIMA pestaña suscripta', async () => {
  limpiar();
  await stopDetection(1);
  assert.deepEqual(tipos(), [], 'queda la pestaña 2: no se toca nada');

  await stopDetection(2);
  assert.deepEqual(tipos(), ['getContexts', 'send:stop_detection', 'getContexts', 'closeDocument']);
  assert.equal(offscreenAbierto, false);

  limpiar();
  await stopDetection(3); // ninguna suscripta y sin offscreen: no-op
  assert.deepEqual(tipos(), ['getContexts']);
});

test('configureDetection con el offscreen cerrado guarda la configuración para el próximo arranque', async () => {
  const respuesta = await configureDetection({ predictionIntervalMs: 1000 });
  assert.deepEqual(respuesta, { ok: true, appliedNow: false });
  limpiar();
  await startDetection(5);
  assert.deepEqual(llamadas.find((l) => l[1] === 'configure_detection')[2], { threshold: 0.7, predictionIntervalMs: 1000 });
});

test('Puente de eventos: reenvía los eventos de atención a las pestañas suscriptas e ignora lo que no es suyo', async () => {
  registerEventBridge();
  limpiar();
  assert.equal(listener({ type: 'attention_event', payload: { phase: 'active', concentration: 0.8 } }), false);
  assert.equal(listener({ type: 'otro_mensaje' }), false);
  assert.equal(listener(null), false);
  await esperar();
  assert.deepEqual(llamadas, [['tabs.sendMessage', 5, 'SPARKLE_ATTENTION_EVENT', { phase: 'active', concentration: 0.8 }]]);
});

test('Sin permiso de cámara se abre permission.html al lado de la pestaña de Meet (una sola vez)', async () => {
  limpiar();
  listener({ type: 'attention_event', payload: { phase: 'no_permission' } });
  listener({ type: 'attention_event', payload: { phase: 'no_permission' } });
  await esperar();
  const creadas = llamadas.filter((l) => l[0] === 'tabs.create');
  assert.equal(creadas.length, 1, 'el segundo aviso no abre otra pestaña');
  assert.deepEqual(creadas[0][1], {
    url: 'chrome-extension://id/permission.html', active: true, openerTabId: 5, windowId: 7, index: 3,
  });
});

test('Con el permiso concedido vuelve a Meet, avisa a las pestañas y no reabre el pedido si Chrome lo niega enseguida', async () => {
  pestanasMeet = [{ id: 5 }, { id: 6 }];
  limpiar();
  listener({ type: 'SPARKLE_CAMERA_PERMISSION_OK' });
  await esperar();
  assert.ok(llamadas.some((l) => l[0] === 'tabs.update' && l[1] === 5 && l[2].active === true));
  assert.ok(llamadas.some((l) => l[0] === 'windows.update' && l[1] === 7));
  const avisos = llamadas.filter((l) => l[0] === 'tabs.sendMessage' && l[2] === 'SPARKLE_CAMERA_PERMISSION_GRANTED');
  assert.deepEqual(avisos.map((l) => l[1]), [5, 6]);

  limpiar();
  listener({ type: 'attention_event', payload: { phase: 'no_permission' } });
  await esperar();
  assert.equal(llamadas.filter((l) => l[0] === 'tabs.create').length, 0);
  const reenviado = llamadas.find((l) => l[0] === 'tabs.sendMessage');
  assert.equal(reenviado[3].phase, 'error', 'se convierte en un error explicable en vez de reabrir el pedido');
});

test('cleanupTab: cerrar la pestaña del permiso permite volver a pedirlo; cerrar la de Meet detiene la detección', async () => {
  // Pestaña de permiso ya abierta de antes: se reactiva en vez de crear otra.
  cleanupTab(101);
  pestanasPermiso = [{ id: 55 }];
  // Fuera del margen de 15 s desde el último permiso concedido.
  const ahora = Date.now;
  Date.now = () => ahora() + 60_000;
  try {
    limpiar();
    listener({ type: 'attention_event', payload: { phase: 'no_permission' } });
    await esperar();
    assert.ok(llamadas.some((l) => l[0] === 'tabs.update' && l[1] === 55));
    assert.equal(llamadas.filter((l) => l[0] === 'tabs.create').length, 0);
  } finally {
    Date.now = ahora;
  }

  cleanupTab(55); // la de permiso: libera el pedido
  cleanupTab(12345); // una pestaña cualquiera: no hace nada
  limpiar();
  cleanupTab(5); // la última suscripta: cierra el offscreen
  await esperar();
  assert.ok(tipos().includes('closeDocument'));
});

test('Si la pestaña de Meet ya no existe, permission.html se abre igual (sin ubicarla al lado)', async () => {
  pestanasPermiso = [];
  await startDetection(999);
  const ahora = Date.now;
  Date.now = () => ahora() + 120_000;
  try {
    limpiar();
    listener({ type: 'attention_event', payload: { phase: 'no_permission' } });
    await esperar();
    const [creada] = llamadas.filter((l) => l[0] === 'tabs.create');
    assert.deepEqual(creada[1], { url: 'chrome-extension://id/permission.html', active: true });
  } finally {
    Date.now = ahora;
    await stopDetection(999);
  }
});
