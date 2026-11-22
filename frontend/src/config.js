// Dirección del backend contra el que corre la extensión.
//
// DOS NIVELES, y el orden importa:
//
//   1. VALOR DE BUILD — `VITE_BACKEND_URL` (ver frontend/.env). Vite lo
//      reemplaza por su literal al compilar, así que queda "horneado" dentro
//      de `dist/background.js`. Es el default con el que arranca cualquier
//      instalación.
//   2. VALOR GUARDADO — `chrome.storage.local.backendUrl`, que si existe pisa
//      al de build. Se edita desde la página de opciones de la extensión
//      (`public/opciones.html`).
//
// POR QUÉ EXISTE EL NIVEL 2
// -------------------------
// Antes esto era una constante de build a secas, y eso ataba cada copia
// compilada a UNA dirección: la extensión que se le pasaba a otra persona
// apuntaba a la IP de quien la había compilado, y no había forma de cambiarlo
// sin instalar Node, clonar el repo y volver a buildear. Con el backend sin
// desplegar —corriendo en Docker en la máquina de alguno del equipo— eso
// significaba que el paquete sólo servía mientras esa máquina estuviera
// prendida.
//
// Un service worker de Manifest V3 sigue sin poder leer un `.env` en runtime
// (a diferencia de un proceso Node, ver backend/src/db.js), pero SÍ puede leer
// `chrome.storage`. Eso es lo que se usa acá.
//
// CONSECUENCIA PARA QUIEN CONSUME ESTE MÓDULO
// -------------------------------------------
// La dirección ya NO se puede leer en el top-level de un módulo, porque
// `chrome.storage` es asíncrono y en ese momento todavía no se resolvió.
// Por eso este archivo NO exporta constantes: exporta `getBackendUrl()` /
// `getWsUrl()`, y una promesa `configuracionLista` que hay que esperar antes
// del primer uso de red. Después de la primera vez ya está resuelta y
// esperarla cuesta un microtask.
//
// `WS_URL` se deriva de la URL base en vez de tener su propia variable: son el
// mismo backend, sólo cambia el protocolo (`http`→`ws`) más el path fijo `/ws`
// del servidor (ver backend/src/ws/index.js). Una sola fuente, sin riesgo de
// que alguien actualice una y se olvide de la otra.

export const CLAVE_STORAGE = 'backendUrl';
// Espejo de solo lectura del valor horneado en el build. Lo escribe
// `hidratar()`; nadie lo lee para decidir, solo la pagina de opciones para
// mostrarlo.
export const CLAVE_URL_DE_BUILD = 'backendUrlDeBuild';

// `?.` (no `import.meta.env.VITE_BACKEND_URL` a secas): `wsClient.test.js`
// carga este módulo con el loader ESM nativo de Node, sin pasar por Vite, y
// ahí `import.meta.env` no existe en absoluto (es una inyección de Vite), así
// que un acceso directo reventaría con "Cannot read properties of undefined".
export const URL_DE_BUILD = import.meta.env?.VITE_BACKEND_URL || 'http://localhost:3000';

// Una barra final de más convierte el WebSocket en `wss://host//ws` y el
// handshake falla. Se normaliza acá y no en la página de opciones para que
// valga también para el valor de build.
function normalizar(url) {
  return String(url).trim().replace(/\/+$/, '');
}

let urlActiva = normalizar(URL_DE_BUILD);

export function getBackendUrl() {
  return urlActiva;
}

// Clave compartida con el backend (§7 del plan de despliegue, opción B).
// Igual que la URL, se hornea en tiempo de build; a diferencia de la URL,
// NO se puede pisar desde la página de opciones: cambiarla no tendría
// sentido (es del backend, no de quien la usa) y dejaría la puerta abierta
// a que alguien la escriba a mano en storage.
//
// Sinceridad sobre qué es esto: viaja en texto plano dentro del bundle, así
// que cualquiera que descomprima la extensión la puede leer. Frena el
// escaneo desde afuera, no a un atacante decidido. El detalle completo del
// trade-off está en backend/src/middleware/apiKey.js.
export const API_KEY = import.meta.env?.VITE_SPARKLE_API_KEY || '';

export function getApiKey() {
  return API_KEY;
}

// Los headers que hay que sumarle a cualquier fetch contra el backend.
// Devuelve un objeto vacío si no hay clave configurada (desarrollo local
// contra un backend sin `SPARKLE_API_KEY`), así que se puede desparramar
// siempre sin condicionales en el llamador.
export function cabecerasDeApi() {
  return API_KEY ? { 'X-Sparkle-Key': API_KEY } : {};
}

// La clave va como query string y no como header porque la API `WebSocket`
// del navegador no permite headers propios en el handshake — es la misma
// asimetría que documenta `verifyClient` en backend/src/ws/index.js.
export function getWsUrl() {
  const url = `${urlActiva.replace(/^http/, 'ws')}/ws`;
  return API_KEY ? `${url}?key=${encodeURIComponent(API_KEY)}` : url;
}

// Se pone en `true` apenas termina `hidratar()`. Existe para que quien NO
// pueda esperar --`connectRoom()` de wsClient.js crea el socket de forma
// sincronica y sus llamadores inspeccionan `room.socket` en la linea
// siguiente-- pueda preguntar si ya hay un valor definitivo en vez de
// bloquearse.
//
// Fuera de un contexto de extension (los tests con el loader de Node) queda en
// `true` de forma SINCRONICA: `chrome.storage.local` revienta al evaluarse,
// antes del primer `await`, asi que todo el cuerpo de `hidratar()` corre en la
// misma vuelta. Adentro de la extension queda en `false` durante los pocos
// milisegundos que tarda `chrome.storage` al arrancar el service worker.
let hidratada = false;

export function configuracionHidratada() {
  return hidratada;
}

async function hidratar() {
  try {
    // Se deja el valor de build a la vista en storage para que la pagina de
    // opciones pueda mostrarlo y ofrecer "volver al default". Esa pagina no
    // pasa por Vite (es un archivo suelto de `public/`), asi que no tiene otra
    // forma de conocerlo.
    await chrome.storage.local.set({ [CLAVE_URL_DE_BUILD]: normalizar(URL_DE_BUILD) });
  } catch {
    // Ver el catch de abajo.
  }
  try {
    const guardado = (await chrome.storage.local.get(CLAVE_STORAGE))[CLAVE_STORAGE];
    if (typeof guardado === 'string' && guardado.trim()) {
      urlActiva = normalizar(guardado);
    }
  } catch {
    // Sin `chrome.storage` disponible —los tests que cargan este módulo con
    // Node, o un contexto de extensión sin el permiso— se sigue con el valor
    // de build. Es degradación, no error: la extensión funciona igual contra
    // la dirección con la que se compiló.
  }
  hidratada = true;
  return urlActiva;
}

// Se dispara al importar el módulo, una sola vez por contexto (service
// worker, content script, offscreen). Memoizada: todos los `await` posteriores
// resuelven contra la misma promesa.
export const configuracionLista = hidratar();

// Reacciona a un cambio hecho desde la página de opciones sin necesidad de
// recargar la extensión. El socket viejo sigue apuntando a la dirección
// anterior hasta que se reconecte — la página de opciones lo dice.
try {
  chrome.storage.onChanged.addListener((cambios, area) => {
    if (area !== 'local' || !cambios[CLAVE_STORAGE]) return;
    const nuevo = cambios[CLAVE_STORAGE].newValue;
    urlActiva = normalizar(
      typeof nuevo === 'string' && nuevo.trim() ? nuevo : URL_DE_BUILD
    );
  });
} catch {
  // Mismo caso que arriba: fuera de un contexto de extensión no hay a qué
  // suscribirse.
}
