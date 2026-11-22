// Servidor WebSocket (Etapa 44): comunicación en tiempo real entre el panel
// docente y el panel alumno, con persistencia del estado "clase activa" en
// la tabla `meetings` (no solo en memoria — ver `services/classService.js`).
//
// Se usa `ws` en vez de socket.io: no hace falta el protocolo/transporte
// propio de socket.io (fallback a polling, reconexión automática con ACKs,
// namespaces, etc.) para este caso — un solo tipo de evento por sala, con
// mensajes JSON planos. `ws` es una implementación fina del estándar
// WebSocket, sin nada del lado del cliente que instalar (el service worker
// de la extensión usa el `WebSocket` nativo del navegador para conectarse).
//
// Este archivo es solo el BOOTSTRAP: crea el `WebSocketServer`, valida el
// origen, arranca el heartbeat, y por cada conexión física despacha cada
// mensaje al handler que corresponde (`./handlers.js`) según su `type`. El
// estado en memoria de las salas vive en `./rooms.js`; toda regla de
// negocio real (la misma que usa la capa REST) vive en `../services/`.
const { WebSocketServer } = require('ws');
const {
  claveDelRequest,
  comparaSegura: comparaClaveSegura,
} = require('../middleware/apiKey');
const { logWS, describeSocket, send } = require('./rooms');
const {
  handleJoin,
  handleStartClass,
  handleEndClass,
  handleResumeClass,
  handleSetAttentionMode,
  handleClose,
  handleSendQuestion,
  handleFinishQuestion,
  handleAnswerQuestion,
  handleSkipQuestion,
  handleAttentionSnapshot,
  handleAttentionStopped,
} = require('./handlers');

// Heartbeat (Etapa 46): un cierre "prolijo" de la conexión (el cliente
// manda el frame de cierre) siempre dispara 'close' — pero una pérdida de
// red abrupta (se apaga el wifi, se cierra la notebook de un golpe) NO
// manda ese frame, y sin esto el servidor jamás se entera de que ese
// socket ya no sirve. El patrón estándar de `ws` para esto es ping/pong:
// cada `HEARTBEAT_MS` se le manda un `ping()` a cada cliente, y se espera
// el `pong`.
const HEARTBEAT_MS = 30000;

// Etapa 55 — cuántos ciclos de heartbeat SEGUIDOS tienen que fallar antes
// de dar una conexión por muerta. Con tolerancia `1` (versión hasta esa
// etapa), un `pong` que simplemente tarda más de `HEARTBEAT_MS` en llegar
// (latencia momentánea, nada de una desconexión real) ya alcanzaba para el
// `terminate()` del ciclo SIGUIENTE. Con `3`, una conexión tiene que fallar
// TRES ciclos consecutivos (hasta ~90s de silencio total, sin ningún `pong`
// de por medio) antes de cortarse — tiempo razonable para nunca enterarse
// de una pérdida de red real, sin confundir latencia puntual con
// desconexión. Cualquier `pong` (incluso uno "tarde", de un ciclo anterior)
// resetea el contador a cero.
const HEARTBEAT_PING_TOLERANCE = 3;

function startHeartbeat(wss, heartbeatMs = HEARTBEAT_MS, pingTolerance = HEARTBEAT_PING_TOLERANCE) {
  const interval = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (socket.isAlive === false) {
        socket.pingsWithoutResponse = (socket.pingsWithoutResponse || 0) + 1;
        logWS(
          `PING(nativo) sin PONG del ciclo anterior — ${describeSocket(socket)} (van ${socket.pingsWithoutResponse}/${pingTolerance}).`
        );
        if (socket.pingsWithoutResponse >= pingTolerance) {
          console.warn(
            `[Sparkle][WS] Conexión sin responder a ${socket.pingsWithoutResponse} pings seguidos — se da por caída ` +
              `(posible pérdida de red) — ${describeSocket(socket)}.`
          );
          return socket.terminate();
        }
      } else {
        socket.pingsWithoutResponse = 0;
      }
      socket.isAlive = false;
      logWS(`PING(nativo) mandado — ${describeSocket(socket)}.`);
      socket.ping();
    });
  }, heartbeatMs);

  wss.on('close', () => clearInterval(interval));
}

// `allowedOrigins` es la misma whitelist que arma `server.js` para CORS
// (meet.google.com + chrome-extension://<id> desde ALLOWED_EXTENSION_IDS).
// `options.heartbeatMs`/`options.pingTolerance`: SOLO para tests —
// permiten correr la misma máquina de estados del heartbeat con ciclos de
// milisegundos en vez de minutos reales; en producción (`server.js`) nunca
// se pasan.
// `options.apiKey`: la clave compartida de §7 del plan de despliegue. Si
// viene vacía (desarrollo local, tests) no se exige nada, igual que en el
// middleware HTTP. Ver src/middleware/apiKey.js.
function startWebSocketServer(httpServer, allowedOrigins, options = {}) {
  const {
    heartbeatMs = HEARTBEAT_MS,
    pingTolerance = HEARTBEAT_PING_TOLERANCE,
    apiKey = '',
  } = options;
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    verifyClient(info, callback) {
      // La clave va PRIMERO porque es el control que sí frena a un cliente
      // que no sea un navegador; el chequeo de origen de abajo solo aplica
      // a los que sí lo son. La clave llega por query string
      // (`/ws?key=...`) y no por header: la API `WebSocket` del navegador
      // no deja mandar headers propios en el handshake.
      if (apiKey && !comparaClaveSegura(claveDelRequest(info.req), apiKey)) {
        console.warn('[Sparkle][WS] Conexión rechazada: clave ausente o incorrecta.');
        callback(false, 401, 'Clave de API ausente o incorrecta');
        return;
      }

      const origin = info.origin;
      // Sin header Origin (herramientas server-to-server, ej. un test con
      // un cliente ws de Node) se deja pasar; con Origin, tiene que estar
      // en la whitelist.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(true);
        return;
      }
      console.warn(`[Sparkle][WS] Conexión rechazada por origen no permitido: ${origin}`);
      callback(false, 403, 'Origen no permitido');
    },
  });

  startHeartbeat(wss, heartbeatMs, pingTolerance);

  wss.on('connection', (socket) => {
    logWS('Conexión física ABIERTA (todavía sin "join" — se identifica recién con el primer mensaje).');
    socket.isAlive = true;
    socket.pingsWithoutResponse = 0;
    socket.on('pong', () => {
      logWS(`PONG(nativo) recibido — ${describeSocket(socket)}.`);
      socket.isAlive = true;
      socket.pingsWithoutResponse = 0; // cualquier señal de vida resetea la tolerancia por completo
    });

    socket.on('message', async (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (err) {
        console.warn('[Sparkle][WS] Mensaje recibido no es JSON válido, se ignora.');
        return;
      }

      const { type, meetingCode } = message || {};

      // Etapa 54 — "ping" es el único mensaje que NO es sobre una sala en
      // particular: es una verificación de la conexión física en sí (ver
      // `verificarConexionViva()` en el service worker de la extensión).
      // Se responde ANTES del chequeo de `meetingCode` de abajo (que si no,
      // lo descartaría sin más) y sin ningún trabajo adicional.
      if (type === 'ping') {
        logWS(`PING(app) recibido — ${describeSocket(socket)} — contestando PONG.`);
        send(socket, { type: 'pong' });
        return;
      }

      if (!meetingCode || typeof meetingCode !== 'string' || !meetingCode.trim()) return;
      const normalizedMeetingCode = meetingCode.trim().toLowerCase();

      try {
        if (type === 'join') {
          await handleJoin(socket, normalizedMeetingCode, message.role, message.email);
        } else if (type === 'start_class') {
          await handleStartClass(socket, normalizedMeetingCode);
        } else if (type === 'end_class') {
          await handleEndClass(socket, normalizedMeetingCode);
        } else if (type === 'resume_class') {
          await handleResumeClass(socket, normalizedMeetingCode);
        } else if (type === 'set_attention_mode') {
          await handleSetAttentionMode(socket, normalizedMeetingCode, message);
        } else if (type === 'send_question') {
          await handleSendQuestion(socket, normalizedMeetingCode, message);
        } else if (type === 'finish_question') {
          await handleFinishQuestion(socket, normalizedMeetingCode, message);
        } else if (type === 'answer_question') {
          await handleAnswerQuestion(socket, normalizedMeetingCode, message);
        } else if (type === 'skip_question') {
          await handleSkipQuestion(socket, normalizedMeetingCode, message);
        } else if (type === 'attention_snapshot') {
          handleAttentionSnapshot(socket, normalizedMeetingCode, message);
        } else if (type === 'attention_stopped') {
          handleAttentionStopped(socket, normalizedMeetingCode, message);
        }
      } catch (err) {
        console.error(`[Sparkle][WS] Error manejando mensaje "${type}":`, err.message);
      }
    });

    socket.on('close', (code, reasonBuffer) => {
      handleClose(socket, code, reasonBuffer);
    });
  });

  console.log('[Sparkle] Servidor WebSocket montado en /ws.');
  return wss;
}

module.exports = { startWebSocketServer };
