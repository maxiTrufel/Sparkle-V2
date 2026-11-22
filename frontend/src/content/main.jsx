import { createRoot } from 'react-dom/client';
import App from '../App';
import panelStyles from '../styles/panel.css?inline';
import { watchMeetingContext } from '../utils/meetContext';
import { watchEmailOutsideCall } from '../utils/emailMemory';

const HOST_ID = 'sparkle-v2-host';

let root = null;
let stopEmailWatch = null;

function mountPanel() {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    width: '320px',
    height: '100vh',
    zIndex: '2147483647',
    // El host no debe capturar clicks de la página por sí mismo: el panel
    // puede estar deslizado fuera de vista, y ese espacio "vacío" tiene que
    // dejar pasar la interacción hacia la página. Los elementos visibles
    // (pestaña y panel) reactivan pointer-events por su cuenta en panel.css.
    pointerEvents: 'none',
  });
  document.body.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = panelStyles;
  shadowRoot.appendChild(style);

  const appContainer = document.createElement('div');
  shadowRoot.appendChild(appContainer);

  root = createRoot(appContainer);
  root.render(<App />);
}

function unmountPanel() {
  const host = document.getElementById(HOST_ID);
  if (!host) return;

  if (root) {
    root.unmount();
    root = null;
  }
  host.remove();
}

// El panel entero (botón de abrir/cerrar incluido) solo existe dentro de
// una llamada activa — en landing, el lobby de otra pantalla, o cualquier
// URL de Meet sin código de reunión, no se inyecta nada en absoluto. Se
// monta/desmonta según la URL en vez de montarse siempre y decidir puertas
// adentro qué mostrar (ver DOCUMENTACION.md, Etapa 17). `watchMeetingContext`
// llama al callback también con el estado inicial al suscribirse, así que
// esta única llamada cubre tanto la carga inicial del content script como
// cada cambio de ruta posterior de la SPA.
//
// Etapa 82 — fuera de una reunión (la página de inicio, donde se toca
// "Nueva reunión") se anota el email de la cuenta para esta pestaña: si
// después se entra directo a la llamada, ahí adentro puede no haber de
// dónde leerlo (ver `utils/emailMemory.js`).
watchMeetingContext((inCall) => {
  stopEmailWatch?.();
  stopEmailWatch = null;
  if (inCall) {
    mountPanel();
  } else {
    unmountPanel();
    stopEmailWatch = watchEmailOutsideCall();
  }
});
