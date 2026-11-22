// Un código de reunión de Meet es un path de 3 grupos de letras separados
// por guiones (ej. "abc-defg-hij"). "/landing", "/" (raíz) y cualquier otra
// ruta sin ese patrón exacto se consideran "fuera de llamada" — ver
// DOCUMENTACION.md, Etapa 13.
//
// Nota (Etapa 22): esta es deliberadamente la versión SIMPLE, solo por
// URL — no distingue lobby / en-llamada / pantalla de salida (esos tres
// estados comparten la misma URL). Se probó una detección más fina basada
// en señales del DOM (Etapa 18) pero introdujo una regresión más grave
// (Etapa 19-20) y se revirtió; ver el historial completo en
// DOCUMENTACION.md. El panel puede volver a aparecer en el lobby y en la
// pantalla de "dejaste la reunión" — es un comportamiento más permisivo
// que se acepta por ahora, a resolver en un paso aislado más adelante.
//
// Noviembre de 2026: Meet también sirve las reuniones bajo "/meet/abc-defg-hij".
// Con esa ruta el código no se reconocía y el panel directamente no se montaba.
const MEETING_CODE_REGEX = /^(?:meet\/)?([a-z]+-[a-z]+-[a-z]+)$/i;

// Devuelve el código de la reunión actual (en minúsculas, para que
// coincida sea cual sea el casing con el que Meet lo haya puesto en la
// URL) o null si el path actual no es una reunión — ver DOCUMENTACION.md,
// Etapa 17. El rol se guarda por este código + el email, no de forma
// global por cuenta.
export function getMeetingCode(pathname = window.location.pathname) {
  const code = pathname.replace(/^\/+|\/+$/g, '');
  if (!code) return null; // raíz "/"
  const match = code.match(MEETING_CODE_REGEX);
  return match ? match[1].toLowerCase() : null;
}

export function isInsideMeetingCall(pathname = window.location.pathname) {
  return getMeetingCode(pathname) !== null;
}

const LOCATION_CHANGE_EVENT = 'sparkle:locationchange';

// Meet es una SPA: navega entre "/landing" y "/xxx-yyyy-zzz" con la History
// API (pushState/replaceState) sin recargar la página, lo cual NO dispara
// "popstate" (ese evento solo salta con atrás/adelante del navegador). Para
// enterarse de esos cambios de ruta hay que interceptar pushState/
// replaceState a mano y avisar con un evento propio. Se parchea una sola
// vez (flag en window) por si el content script se vuelve a inyectar.
function ensurePatchedHistory() {
  if (window.__sparkleHistoryPatched) return;
  window.__sparkleHistoryPatched = true;

  const notify = () => window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args) => {
    originalPushState(...args);
    notify();
  };

  history.replaceState = (...args) => {
    originalReplaceState(...args);
    notify();
  };

  window.addEventListener('popstate', notify);
}

// Suscribe un callback que se llama con el estado actual (en llamada o no)
// apenas se suscribe, y de nuevo cada vez que cambia la ruta. Devuelve una
// función para desuscribirse. Alcanza con escuchar el evento propio: el
// popstate nativo ya se re-emite como ese mismo evento en
// ensurePatchedHistory, así que no hace falta escucharlo acá también.
export function watchMeetingContext(callback) {
  ensurePatchedHistory();

  const handleChange = () => callback(isInsideMeetingCall());
  handleChange();

  window.addEventListener(LOCATION_CHANGE_EVENT, handleChange);

  return () => {
    window.removeEventListener(LOCATION_CHANGE_EVENT, handleChange);
  };
}
