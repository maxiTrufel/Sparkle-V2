// Ciclo de vida del documento offscreen donde corre la detección de atención.
//
// El service worker no puede correr la detección él mismo (no tiene DOM, ni
// acceso a cámara, ni GPU) y el content script tampoco (hereda la CSP de
// meet.google.com, que no habilita WebAssembly). El documento offscreen es la
// única superficie de Manifest V3 que reúne las tres cosas — ver
// `src/offscreen/main.js` para el detalle.
//
// Este módulo hace de intermediario en las dos direcciones:
//   panel  → service worker → offscreen   (comandos iniciar/detener)
//   offscreen → service worker → panel    (eventos de predicción)
//
// El rebote por el service worker es obligatorio: un documento offscreen no
// puede mandarle mensajes directamente a un content script, solo a la
// extensión, y el service worker es quien sabe a qué pestaña reenviarlos.

const OFFSCREEN_PATH = 'offscreen.html';

// Pestañas que quieren recibir eventos de detección. Es un Set y no un único
// id porque puede haber varias reuniones abiertas a la vez; el documento
// offscreen es uno solo (Chrome permite exactamente uno por extensión), así
// que la detección arranca cuando la primera pestaña la pide y se corta cuando
// la última la suelta.
const subscribedTabs = new Set();

let creatingOffscreen = null;

// Serializa TODAS las operaciones de ciclo de vida del documento offscreen
// (`startDetection`/`stopDetection` completos, no solo la creación) —
// causa raíz real del bug "la detección deja de funcionar tras pausar y
// reanudar la clase, hasta recargar la página": una pausa dispara
// `stopDetection` (última pestaña suscrita se va → `closeOffscreen()`,
// que `await`s `chrome.offscreen.closeDocument()`), y si la clase se
// reanuda rápido después, `startDetection` corre `ensureOffscreen()`
// EN PARALELO con ese cierre todavía en vuelo. `offscreenExists()` puede
// devolver `true` en ese instante (el documento técnicamente sigue
// existiendo hasta que `closeDocument()` termina de resolver), así que
// `ensureOffscreen()` no crea uno nuevo — manda `start_detection` a un
// documento que un instante después el cierre en vuelo destruye igual. El
// resultado: ningún documento offscreen corriendo, sin ningún error visible
// (el `sendMessage` a un documento ya cerrado no rechaza), y sin ningún
// disparador que lo note — hasta que se recarga la página, que es lo único
// que fuerza un `startDetection` fresco sin este historial pendiente.
// Encolando ambas operaciones completas, una pausa SIEMPRE termina de
// cerrar (o de decidir que no hace falta cerrar nada) antes de que la
// reanudación siguiente empiece a evaluar si hace falta crear un documento
// nuevo.
let lifecycleQueue = Promise.resolve();

function enqueueLifecycleTask(task) {
  const result = lifecycleQueue.then(task, task);
  // Nunca deja la cola "rota" por un rechazo — una operación fallida no
  // debe bloquear las siguientes indefinidamente.
  lifecycleQueue = result.then(() => {}, () => {});
  return result;
}

// Última configuración pedida desde el panel de ajuste rápido (N/X/Y no viven
// acá — X e Y sí, ver `configureDetection` más abajo). `detector.js` guarda
// umbral/cadencia en variables de módulo DENTRO del documento offscreen: si
// ese documento se cierra (última pestaña suscrita se va) y se vuelve a crear
// después, arranca con los defaults de `detector.js`, no con lo que el
// docente/QA haya configurado antes. Guardarla acá (el service worker
// persiste mientras la extensión esté activa) permite reaplicarla apenas el
// offscreen nuevo esté listo, sin que el panel tenga que volver a mandarla.
//
// Corrección (auditoría de variables configurables) — bug real: esto
// arrancaba en `null`, así que en una pestaña que NUNCA abrió el panel de
// ajuste rápido (el caso normal), `startDetection` no reaplicaba nada y el
// offscreen corría con los defaults hardcodeados de `detector.js`
// (`DEFAULT_PREDICTION_INTERVAL_MS` = 2000ms) — mientras que `App.jsx`
// mostraba X = 0.5s (500ms) como si ya estuviera aplicado. La UI mentía: el
// alumno veía "X = 0.5s" pero el modelo predecía cada 2s de verdad, hasta
// que alguien abría el panel y apretaba "Aplicar cambios" al menos una vez.
// Semillado con los MISMOS valores que `App.jsx` usa como estado inicial de
// `attentionConfig` (`threshold: 0.5, xSeconds: 2`) — mismo motivo que
// siempre (cubre el primerísimo arranque del documento offscreen, ANTES de
// que nadie le haya mandado nada todavía). Si el default de
// `attentionConfig` en `App.jsx` cambia alguna vez, este valor tiene que
// cambiar junto con él — no hay forma de compartir la constante entre el
// content script y el service worker sin un módulo nuevo, así que quedan
// duplicados a propósito (mismo criterio que el default de `detector.js`,
// ver el comentario de `DEFAULT_THRESHOLD` ahí).
//
// Corrección (auditoría de inicialización) — bug real: esta duplicación
// manual era la ÚNICA vía de aplicar X/Y al arrancar, y en algún momento
// pudo quedar desincronizada del default real de `App.jsx` sin que nada lo
// notara — el detector arrancaba con un valor que la UI ya no mostraba,
// hasta que el alumno tocaba cualquier slider. Ahora `App.jsx` manda
// ACTIVAMENTE su `attentionConfig` vigente cada vez que arranca la
// detección (ver el efecto de `cameraActive` ahí) — este seed ya no es la
// única fuente, es un colchón para la ventana brevísima antes de que ese
// envío activo llegue.
// Y = 0.5 desde el 2026-08-01 (antes 0.6). Es el punto de operación validado
// del modelo, no una preferencia — ver `backend/src/constants/attentionModes.js`.
let lastConfiguration = { threshold: 0.5, predictionIntervalMs: 2000 };

async function offscreenExists() {
  // `getContexts` es la vía soportada desde Chrome 116; el fallback por
  // `clients.matchAll` cubre versiones anteriores.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }
  const clients = await self.clients.matchAll();
  return clients.some((c) => c.url.endsWith(OFFSCREEN_PATH));
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;

  // `createDocument` falla si ya hay una creación en vuelo, cosa que pasa si
  // dos pestañas piden detección casi al mismo tiempo. Se serializa con una
  // promesa compartida.
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // USER_MEDIA porque el documento abre su propio stream de cámara (ver el
    // comentario largo en src/offscreen/main.js sobre por qué no se le pasan
    // los cuadros desde el content script).
    reasons: ['USER_MEDIA'],
    justification:
      'Ejecuta la detección de atención sobre el video de la cámara: MediaPipe y '
      + 'LiteRT.js requieren WebAssembly, que solo puede correr en una página de '
      + 'extensión con CSP propia.',
  });
  try {
    await creatingOffscreen;
    console.log('[Sparkle][SW] documento offscreen creado');
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreen() {
  if (!(await offscreenExists())) return;
  await chrome.offscreen.closeDocument();
  console.log('[Sparkle][SW] documento offscreen cerrado');
}

/**
 * El panel pide arrancar la detección para su pestaña. Encolada (ver
 * `enqueueLifecycleTask` arriba) — nunca corre en paralelo con un
 * `stopDetection` en vuelo, sea de esta misma pestaña (pausa seguida de
 * reanudación rápida) o de otra.
 */
export function startDetection(tabId) {
  return enqueueLifecycleTask(async () => {
    subscribedTabs.add(tabId);
    await ensureOffscreen();
    // Reaplica la última configuración ANTES de arrancar — cubre tanto el
    // documento offscreen recién creado (defaults de `detector.js`) como uno
    // que ya existía de una suscripción anterior sin haber recibido este
    // ajuste todavía. Sin `lastConfiguration` (nadie tocó el panel todavía)
    // no manda nada, y `detector.js` sigue con sus propios defaults.
    if (lastConfiguration) {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'configure_detection', payload: lastConfiguration });
    }
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start_detection' });
    return { ok: true };
  });
}

/**
 * El panel de ajuste rápido pide cambiar umbral (Y) y/o cadencia de
 * predicción (X) en caliente. Se guarda SIEMPRE (incluso sin documento
 * offscreen todavía: el docente/QA puede tocar el panel antes de prender la
 * cámara) y se reenvía al offscreen solo si ya existe — si no existe, queda
 * para cuando `startDetection` lo cree y la reaplique.
 */
export async function configureDetection(config) {
  lastConfiguration = { ...(lastConfiguration || {}), ...config };
  if (!(await offscreenExists())) {
    return { ok: true, appliedNow: false };
  }
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'configure_detection', payload: lastConfiguration });
  return { ok: true, appliedNow: true, configuration: response?.configuration };
}

/**
 * El panel suelta la detección. El documento offscreen solo se cierra cuando
 * ya no queda ninguna pestaña interesada: mantenerlo vivo entre reuniones
 * evitaría recargar los modelos, pero también dejaría la cámara tomada, que es
 * exactamente lo que el switch del panel promete cortar. Encolada (ver
 * `enqueueLifecycleTask` arriba) por el mismo motivo que `startDetection`.
 */
export function stopDetection(tabId) {
  return enqueueLifecycleTask(async () => {
    subscribedTabs.delete(tabId);
    if (subscribedTabs.size > 0) return { ok: true };
    if (await offscreenExists()) {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop_detection' });
      await closeOffscreen();
    }
    return { ok: true };
  });
}

const PERMISSION_PATH = 'permission.html';

// Si Chrome vuelve a negar la cámara enseguida después de que el usuario la
// concedió, la pestaña de permiso NO se reabre: se entraría en un bucle
// abrir/cerrar (la página ve el permiso concedido y se cierra sola). En ese
// caso el panel muestra un aviso para apagar y prender el interruptor.
const PERMISSION_RETRY_GUARD_MS = 15000;

// Evita abrir la pestaña de permiso más de una vez mientras siga abierta: si
// el usuario la cierra sin conceder, se vuelve a permitir (ver `cleanupTab`),
// así el próximo intento del panel la abre de nuevo en vez de quedar mudo.
let permissionAlreadyRequested = false;
let permissionTabId = null;
// Pestaña de Meet desde la que se pidió el permiso, para volver a ella.
let permissionOpenerTabId = null;
let lastPermissionGrantedAt = 0;

/**
 * Abre la página visible que solicita el permiso de cámara.
 *
 * Hace falta porque el documento offscreen no puede recibir foco y por lo tanto
 * no puede mostrar el diálogo de permisos: Chrome lo descarta solo. Como los
 * permisos se otorgan por origen y ambas superficies comparten
 * `chrome-extension://<id>`, alcanza con concederlo una vez desde acá.
 */
async function openPermissionPage() {
  if (permissionAlreadyRequested) return;
  permissionAlreadyRequested = true;
  const url = chrome.runtime.getURL(PERMISSION_PATH);

  // Si ya está abierta, se enfoca en vez de duplicarla
  const opened = await chrome.tabs.query({ url });
  if (opened.length > 0) {
    permissionTabId = opened[0].id;
    await chrome.tabs.update(opened[0].id, { active: true });
    return;
  }

  // Al lado de la pestaña de Meet y como "hija" de ella: antes se abría al
  // final de la ventana, y al cerrarse Chrome podía mostrar cualquier otra
  // pestaña en vez de volver a la llamada.
  const [meetTabId] = subscribedTabs;
  permissionOpenerTabId = meetTabId ?? null;
  const createOptions = { url, active: true };
  if (meetTabId != null) {
    try {
      const meetTab = await chrome.tabs.get(meetTabId);
      Object.assign(createOptions, { openerTabId: meetTabId, windowId: meetTab.windowId, index: meetTab.index + 1 });
    } catch {
      // La pestaña de Meet ya no existe: se abre donde Chrome decida.
    }
  }
  const tab = await chrome.tabs.create(createOptions);
  permissionTabId = tab.id;
  console.log('[Sparkle][SW] falta permiso de cámara para la extensión: abriendo permission.html');
}

// Vuelve a la llamada apenas se concede el permiso (la página de permiso se
// cierra sola un rato después, ya en segundo plano).
async function returnToMeet() {
  if (permissionOpenerTabId == null) return;
  const tab = await chrome.tabs.update(permissionOpenerTabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// Avisa a TODAS las pestañas de Meet, no solo a `subscribedTabs`: si el
// service worker se reinició mientras el usuario estaba en la página de
// permiso, esa lista quedó vacía y antes nadie volvía a arrancar la detección
// (el panel quedaba trabado hasta apagar y prender el interruptor). Cada panel
// decide si le corresponde reintentar (ver `hooks/useAttentionDetection.js`).
async function notifyPermissionGranted() {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'SPARKLE_CAMERA_PERMISSION_GRANTED' }).catch(() => {});
  }
}

/** Reenvía los eventos del offscreen a las pestañas suscritas. */
export function registerEventBridge() {
  chrome.runtime.onMessage.addListener((message) => {
    // La página de permiso avisa cuando el usuario lo concedió, para reintentar
    // sin que tenga que apagar y volver a encender el interruptor del panel.
    if (message?.type === 'SPARKLE_CAMERA_PERMISSION_OK') {
      permissionAlreadyRequested = false;
      lastPermissionGrantedAt = Date.now();
      returnToMeet().catch(() => {});
      notifyPermissionGranted().catch((err) => {
        console.log(`[Sparkle][SW] no se pudo avisar el permiso concedido: ${err.message}`);
      });
      return false;
    }

    if (message?.type !== 'attention_event') return false;

    let payload = message.payload;
    if (payload?.phase === 'no_permission') {
      if (Date.now() - lastPermissionGrantedAt < PERMISSION_RETRY_GUARD_MS) {
        console.log('[Sparkle][SW] la cámara se volvió a negar justo después de concederla: no se reabre permission.html');
        payload = { phase: 'error', message: 'Chrome no dejó usar la cámara. Apagá y volvé a prender el interruptor.' };
      } else {
        openPermissionPage().catch((err) => {
          console.log(`[Sparkle][SW] no se pudo abrir permission.html: ${err.message}`);
        });
      }
    }

    for (const tabId of subscribedTabs) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SPARKLE_ATTENTION_EVENT',
        payload,
      }).catch(() => {
        // La pestaña puede haberse cerrado o navegado fuera de la reunión
        // entre dos predicciones; se limpia en `cleanupTab`.
      });
    }
    return false;
  });
}

/** Se llama desde `chrome.tabs.onRemoved`, junto con la limpieza de salas WS. */
export function cleanupTab(tabId) {
  // El usuario cerró la página de permiso (con o sin conceder): el próximo
  // intento del panel puede volver a abrirla.
  if (tabId === permissionTabId) {
    permissionTabId = null;
    permissionAlreadyRequested = false;
  }
  if (!subscribedTabs.has(tabId)) return;
  stopDetection(tabId).catch(() => {});
}
