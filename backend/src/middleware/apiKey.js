// Clave compartida entre la extensión y el backend (§7 del Plan de
// Despliegue, opción B).
//
// QUÉ PROBLEMA RESUELVE
// ---------------------
// Hasta acá el único control de acceso era la whitelist de CORS de
// `server.js`, y CORS solo frena navegadores: un `curl` no manda header
// `Origin`, así que entraba sin más. Con el backend en `localhost` eso no
// importaba. En un dominio público significa que cualquiera que sepa el
// código de un Meet se baja la transcripción entera de esa clase:
//
//   curl https://api.sparkleedu.me/api/meetings/abc-defg-hij/transcript
//
// Y el código de Meet no es un secreto: lo tienen todos los que estuvieron
// en la clase.
//
// QUÉ *NO* RESUELVE — importante, es la mitad del trade-off
// ---------------------------------------------------------
// La clave viaja horneada en el bundle de la extensión, así que cualquiera
// que descomprima el `.crx` la puede leer. Esto frena el escaneo
// oportunista y a cualquiera que no se tome ese trabajo; NO es
// autenticación de verdad. Lo correcto para una clase real con datos de
// alumnos es un token de sesión por reunión, emitido por el backend al
// registrarse (opción C de §7). Esto es el escalón de abajo, elegido a
// propósito porque cuesta una hora y medio y no cambia la arquitectura.
//
// SI NO HAY CLAVE CONFIGURADA, NO SE EXIGE NADA
// ----------------------------------------------
// `SPARKLE_API_KEY` vacío deja pasar todo, con un aviso al arrancar. Es lo
// que hace que el desarrollo local y los tests (que montan el router
// directo, sin `server.js`) sigan andando sin configurar nada. La
// contrapartida es que un despliegue con la variable sin setear queda
// abierto y solo lo dice un `console.warn` — por eso el aviso es ruidoso y
// por eso la variable está en la lista de secretos obligatorios del deploy
// (paso E.3).
const crypto = require('crypto');

const NOMBRE_HEADER = 'x-sparkle-key';
// El WebSocket la manda por query string y no por header: la API
// `WebSocket` del navegador no permite headers propios en el handshake, a
// diferencia de `fetch`. Ver `verifyClient` en src/ws/index.js.
const NOMBRE_QUERY = 'key';

// Rutas que se responden sin clave. `GET /` es el chequeo de salud que usa
// la verificación post-deploy del workflow (paso E.5): si pidiera clave,
// el deploy tendría que conocerla para saber si el deploy funcionó, y no
// devuelve nada más que `{ status: 'ok' }`.
const RUTAS_PUBLICAS = new Set(['/']);

// `timingSafeEqual` revienta si los buffers miden distinto, así que la
// comparación de longitud va primero y por separado. Filtrar por longitud
// filtra información sobre la clave, pero es información que igual está en
// el bundle de la extensión: no cambia nada del modelo de amenaza.
function comparaSegura(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Devuelve la clave que trae el request, mire donde mire. Exportada porque
// el servidor de WebSocket hace la misma lectura sobre `info.req`.
function claveDelRequest(req) {
  const porHeader = req.headers?.[NOMBRE_HEADER];
  if (porHeader) return String(porHeader);

  // `req.url` en el upgrade de WS es relativo ("/ws?key=..."), así que hace
  // falta una base cualquiera para poder parsearlo.
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get(NOMBRE_QUERY) || '';
  } catch {
    return '';
  }
}

function crearMiddlewareApiKey(claveEsperada) {
  if (!claveEsperada) {
    console.warn(
      '[Sparkle][auth] SPARKLE_API_KEY no está configurada: la API queda ' +
        'ABIERTA, cualquiera con el código de un Meet puede leer sus datos. ' +
        'Está bien para desarrollo local; en producción es un agujero. ' +
        'Generá una con: openssl rand -hex 32'
    );
    return (_req, _res, next) => next();
  }

  return function exigirApiKey(req, res, next) {
    // El preflight de CORS nunca lleva headers propios (justamente los está
    // yendo a preguntar), así que exigirle la clave rompería todo request
    // con `Content-Type: application/json`.
    if (req.method === 'OPTIONS') return next();
    if (RUTAS_PUBLICAS.has(req.path)) return next();

    if (comparaSegura(claveDelRequest(req), claveEsperada)) return next();

    console.warn(
      `[Sparkle][auth] Rechazado ${req.method} ${req.path} — clave ausente o incorrecta.`
    );
    return res.status(401).json({ error: 'Clave de API ausente o incorrecta.' });
  };
}

module.exports = {
  crearMiddlewareApiKey,
  claveDelRequest,
  comparaSegura,
  NOMBRE_HEADER,
  NOMBRE_QUERY,
};
