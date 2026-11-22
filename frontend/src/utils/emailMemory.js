import { detectGoogleAccountEmail } from './detectEmail.js';

// Memoria del email de la cuenta, POR PESTAÑA (Etapa 82).
//
// Adentro de una llamada, Meet no muestra el email de la cuenta en ningún
// lugar fijo: solo aparece un rato en el cartel "Your meeting's ready /
// Joined as …" (ver Etapa 19). Si se entra directo a la llamada (reunión
// instantánea) y ese cartel se demora o se cierra antes de que Sparkle lo
// lea, no queda de dónde sacarlo. En cambio, en la página de inicio de Meet
// (donde se toca "Nueva reunión") y en la sala de espera el email sí está.
// Por eso cada vez que Sparkle lo ve en esta pestaña lo anota acá, y el
// panel lo usa si adentro de la llamada no encuentra nada.
//
// Es `sessionStorage` y no `chrome.storage` a propósito: queda atado a ESTA
// pestaña (sobrevive a recargarla, no se comparte con otras), así que no se
// mezclan cuentas si alguien usa otra cuenta en otra pestaña — el riesgo del
// cache global de la Etapa 21, revertido en la 22. Y lo que se lee de la
// página siempre tiene prioridad sobre lo anotado.
const CLAVE = 'sparkle_email_de_esta_pestana';

export function getTabEmail() {
  try {
    return window.sessionStorage.getItem(CLAVE);
  } catch {
    return null;
  }
}

export function setTabEmail(email) {
  if (!email) return;
  try {
    window.sessionStorage.setItem(CLAVE, email);
  } catch {
    // Sin sessionStorage (bloqueado por el navegador): el panel sigue
    // dependiendo solo de lo que encuentre en la página.
  }
}

// Fuera de una reunión el panel no existe (ver `content/main.jsx`), así que
// nadie mira la página. Esto la mira cada segundo, hasta encontrar el email
// o hasta 30 s, y lo anota. Solo con las estrategias seguras: la página de
// inicio lista las próximas reuniones, que pueden traer emails de otros.
const INTERVALO_MS = 1000;
const DURACION_MAXIMA_MS = 30000;

export function watchEmailOutsideCall() {
  const startedAt = Date.now();
  let intervalId = null;
  let done = false;

  const stop = () => {
    done = true;
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
  };

  const check = () => {
    const email = detectGoogleAccountEmail({ allowPlainText: false });
    if (email) {
      setTabEmail(email);
      stop();
    } else if (Date.now() - startedAt >= DURACION_MAXIMA_MS) {
      stop();
    }
  };

  check();
  if (!done) intervalId = setInterval(check, INTERVALO_MS);
  return stop;
}
