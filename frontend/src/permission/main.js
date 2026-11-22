// Página visible que solicita el permiso de cámara para el origen de la
// extensión.
//
// Por qué existe: la detección corre en un documento offscreen, y los
// documentos offscreen NO pueden recibir foco (está en la documentación de
// `chrome.offscreen`). Sin foco no pueden mostrar el diálogo de permisos, así
// que Chrome descarta la solicitud sola y `getUserMedia` falla con
// `NotAllowedError: Permission dismissed` — sin que el usuario haya visto ni
// rechazado nada.
//
// La solución es pedir el permiso desde una superficie VISIBLE de la extensión.
// Los permisos se otorgan por origen, y una página de extensión comparte el
// origen `chrome-extension://<id>` con el documento offscreen, así que una vez
// concedido acá el offscreen lo hereda y ya no vuelve a preguntar.
//
// Esto es independiente del permiso que Meet pide para el preview de cámara del
// panel: aquel se otorga a `meet.google.com`, este a la extensión. Son dos
// orígenes distintos y Chrome los trata por separado.

const button = document.getElementById('request');
const statusEl = document.getElementById('status');

function showStatus(text, cssClass = '') {
  statusEl.textContent = text;
  statusEl.className = `estado ${cssClass}`;
}

// Si el cartel de Chrome no aparece (se cerró, o quedó como un ícono en la
// barra de direcciones), `getUserMedia` se queda esperando sin dar error, y
// antes el botón quedaba deshabilitado para siempre.
const PROMPT_HINT_MS = 12000;

async function requestPermission() {
  button.disabled = true;
  showStatus('Esperando tu respuesta…');
  const hintTimer = setTimeout(() => {
    button.disabled = false;
    showStatus('¿No ves el cartel de Chrome? Tocá el ícono de la cámara en la barra de direcciones, o volvé a apretar el botón.');
  }, PROMPT_HINT_MS);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });

    // Solo queríamos el permiso, no el stream: se corta de inmediato. El
    // documento offscreen abrirá el suyo cuando corresponda.
    stream.getTracks().forEach((t) => t.stop());

    showStatus('Permiso concedido. Ya podés cerrar esta pestaña.', 'ok');
    button.textContent = 'Listo';

    // Avisa al service worker para que reintente la detección sin que el
    // usuario tenga que apagar y volver a encender el interruptor.
    chrome.runtime.sendMessage({ type: 'SPARKLE_CAMERA_PERMISSION_OK' }).catch(() => {});

    setTimeout(() => window.close(), 2500);
  } catch (err) {
    button.disabled = false;
    if (err.name === 'NotAllowedError') {
      showStatus(
        'No se concedió el permiso. Si lo bloqueaste antes, hay que habilitarlo '
        + 'desde el ícono de la cámara en la barra de direcciones.',
        'error',
      );
    } else if (err.name === 'NotFoundError') {
      showStatus('No se encontró ninguna cámara conectada.', 'error');
    } else {
      showStatus(`No se pudo acceder a la cámara: ${err.message}`, 'error');
    }
    console.log(`[Sparkle][permission] ${err.name}: ${err.message}`);
  } finally {
    clearTimeout(hintTimer);
  }
}

button.addEventListener('click', requestPermission);

// Si el permiso ya estaba concedido de antes, no tiene sentido hacer clickear
// de nuevo: se detecta y se cierra sola.
if (navigator.permissions?.query) {
  navigator.permissions.query({ name: 'camera' }).then((p) => {
    if (p.state === 'granted') {
      showStatus('El permiso ya estaba concedido.', 'ok');
      button.disabled = true;
      button.textContent = 'Listo';
      chrome.runtime.sendMessage({ type: 'SPARKLE_CAMERA_PERMISSION_OK' }).catch(() => {});
      setTimeout(() => window.close(), 1800);
    }
  }).catch(() => {});
}
