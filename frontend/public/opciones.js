// Pagina de opciones de la extension.
//
// NO pasa por Vite: es un archivo suelto de `public/`, copiado tal cual a
// `dist/`. Por eso no importa nada y habla con `chrome.storage` directo. Las
// claves que usa son las mismas que declara `src/config.js`
// (`backendUrl` y `backendUrlDeBuild`); si alguna vez cambian alla, hay que
// cambiarlas aca -- no hay forma de compartir la constante sin meter este
// archivo en el build, y meterlo obligaria a un quinto entry point de Vite
// para una pagina de cuatro controles.

const CLAVE = 'backendUrl';
const CLAVE_BUILD = 'backendUrlDeBuild';

const $url = document.getElementById('url');
const $aviso = document.getElementById('aviso');
const $efectiva = document.getElementById('efectiva');
const $deBuild = document.getElementById('deBuild');
const $ws = document.getElementById('ws');

function normalizar(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function avisar(texto, clase) {
  $aviso.textContent = texto;
  $aviso.className = `aviso ${clase}`;
  $aviso.hidden = false;
}

async function estado() {
  const g = await chrome.storage.local.get([CLAVE, CLAVE_BUILD]);
  const deBuild = g[CLAVE_BUILD] || '(todavia no lo reporto la extension)';
  const efectiva = normalizar(g[CLAVE]) || g[CLAVE_BUILD] || '';
  return { guardado: g[CLAVE], deBuild, efectiva };
}

async function pintar() {
  const { guardado, deBuild, efectiva } = await estado();
  $deBuild.textContent = deBuild;
  $efectiva.textContent = efectiva
    ? `${efectiva}${guardado ? '  (guardado aca)' : '  (valor de fabrica)'}`
    : '—';
  $ws.textContent = efectiva ? `${efectiva.replace(/^http/, 'ws')}/ws` : '—';
  document.getElementById('id').textContent = chrome.runtime.id;
  if (!$url.value) $url.value = efectiva;
}

document.getElementById('guardar').addEventListener('click', async () => {
  const valor = normalizar($url.value);
  if (!valor) {
    avisar('Escribi una URL, o usa "Volver al valor de fabrica".', 'mal');
    return;
  }
  if (!/^https?:\/\/[^/\s]+$/.test(valor)) {
    avisar(
      'Tiene que ser http:// o https:// seguido de host (y puerto si hace falta), sin path. '
      + 'Por ejemplo: http://localhost:3000',
      'mal'
    );
    return;
  }
  await chrome.storage.local.set({ [CLAVE]: valor });
  $url.value = valor;
  await pintar();
  avisar(`Guardado: ${valor}. Recarga la pestaña de Meet para que el WebSocket se reconecte.`, 'ok');
});

document.getElementById('default').addEventListener('click', async () => {
  await chrome.storage.local.remove(CLAVE);
  $url.value = '';
  await pintar();
  avisar('Listo: vuelve a usar la direccion con la que se compilo la extension.', 'ok');
});

document.getElementById('probar').addEventListener('click', async (ev) => {
  const boton = ev.currentTarget;
  const destino = normalizar($url.value) || (await estado()).efectiva;
  if (!destino) {
    avisar('No hay ninguna direccion para probar.', 'mal');
    return;
  }
  boton.disabled = true;
  avisar(`Probando ${destino} ...`, 'info');
  // El backend responde `{status:'ok'}` en la raiz (backend/src/server.js).
  // Un timeout explicito porque un host inalcanzable puede colgar el fetch
  // bastante mas de lo que nadie va a esperar mirando la pagina.
  const corte = AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined;
  try {
    const r = await fetch(`${destino}/`, { signal: corte });
    const cuerpo = await r.json().catch(() => null);
    if (r.ok && cuerpo && cuerpo.status === 'ok') {
      avisar(`Responde bien: ${cuerpo.service || 'backend'} en ${destino}`, 'ok');
    } else {
      avisar(
        `Contesto HTTP ${r.status}, pero no es el backend de Sparkle. `
        + 'Revisa que la direccion apunte a Caddy o al backend, no a otra cosa.',
        'mal'
      );
    }
  } catch (err) {
    avisar(
      `No contesta (${err.name === 'TimeoutError' ? 'timeout' : err.message}). `
      + 'Puede ser que el backend no este levantado, que la maquina no sea alcanzable '
      + '(Tailscale/LAN), o que el ID de esta extension no este en ALLOWED_EXTENSION_IDS.',
      'mal'
    );
  } finally {
    boton.disabled = false;
  }
});

pintar();
