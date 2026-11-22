// Cliente WebSocket del service worker (Etapa 44): se conecta con el
// `WebSocket` NATIVO del navegador (no una librería) contra el servidor
// `ws` del backend (backend/src/ws) — el service worker corre en
// `chrome-extension://`, así que no está sujeto a las mismas restricciones
// de CORS/Private Network Access que el fetch de la página (ver
// DOCUMENTACION.md, Etapa 8), y WebSocket nunca estuvo sujeto a CORS de
// todos modos (el servidor valida el Origin a mano, ver `verifyClient` en
// backend/src/ws/index.js).
//
// Auditoría de configuración — sale de `VITE_BACKEND_URL` (build-time env
// de Vite), derivada junto con `BACKEND_URL` en `../config.js` (mismo
// backend, solo cambia el protocolo) en vez de tener su propia variable de
// entorno separada. Ver ese archivo para el detalle completo.
// La URL sale de `../config.js`, que combina el valor de build con el que
// pueda haber guardado la pagina de opciones en `chrome.storage`. Como ese
// segundo nivel es asincrono, se lee con `getWsUrl()` en el momento de abrir
// el socket y no como constante de modulo -- ver `connectRoom`.
import { configuracionLista, configuracionHidratada, getWsUrl } from '../config.js';
const RECONNECT_MS = 2000;

// Logging temporal de diagnóstico (Etapa 56) — para correlacionar con los
// logs del backend mientras se investiga el reporte de "las pestañas se ven
// desconectadas tras ~1 minuto en segundo plano". Se saca (o se apaga)
// una vez que la causa esté confirmada — no es logging que deba quedar
// para siempre. `[Sparkle][SW]` para distinguirlo de `[Sparkle][WS]`
// (backend) y `[Sparkle]` a secas (otros logs ya existentes de este mismo
// archivo).
function logSW(message) {
  console.log(`[Sparkle][SW][${new Date().toISOString()}] ${message}`);
}

// Se ejecuta una única vez CADA VEZ que el service worker arranca desde
// cero (al instalar/actualizar la extensión, al reabrir el navegador, O
// cada vez que Chrome lo suspende y lo vuelve a levantar — un service
// worker suspendido no "pausa" su módulo, lo DESTRUYE por completo; la
// próxima vez que Chrome lo necesite, vuelve a evaluar este archivo desde
// la línea 1, con todo el estado en memoria — incluido el `Map` `rooms` de
// más abajo — en blanco). Ver este log repetirse más de una vez durante
// una misma sesión (sin haber recargado la extensión a mano) es la señal
// más directa posible de que el service worker se está suspendiendo.
logSW('Service worker (re)iniciando — módulo wsClient.js evaluado desde cero.');

// Etapa 52 — cuánto se espera (como máximo) a que la conexión de una sala
// esté OPEN antes de rendirse en un comando del docente (iniciar/finalizar/
// reanudar clase). Ver `waitForSocketOpen()` más abajo: existe
// específicamente para el error "WebSocket no conectado a esa sala todavía"
// que aparecía en CUALQUIER botón del docente — el caso más común no es que
// la conexión esté rota, sino que todavía está `CONNECTING` (recién se
// mandó el "join") o reconectando tras un corte breve; ambos casos se
// resuelven solos en un par de segundos, no hace falta fallarle al usuario
// de una. 8s cubre varios ciclos de `RECONNECT_MS` sin sentirse colgado.
const COMMAND_WAIT_MAX_MS = 8000;
const COMMAND_WAIT_POLL_MS = 150;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Una sala = una conexión WebSocket física, exactamente como la modela el
// servidor (un socket pertenece a UN meetingCode a la vez — ver
// backend/src/ws/index.js). Varias pestañas de la MISMA reunión, MISMO rol
// y MISMO email comparten la misma conexión (ej. el mismo docente con dos
// pestañas de Meet abiertas); reuniones distintas, o la MISMA reunión con
// una identidad (rol+email) distinta, tienen conexiones físicas
// independientes.
//
// Etapa 66 — bug real encontrado investigando un reporte de sincronización
// ("el docente no ve al alumno que ya estaba conectado desde antes"): hasta
// esta etapa, la clave de este Map era el `meetingCode` A SECAS. Eso
// funciona perfecto para dos pestañas de la MISMA persona, pero se rompe
// apenas el MISMO service worker de background maneja dos IDENTIDADES
// distintas para la misma reunión (el caso típico al probar la extensión
// en un solo navegador: una pestaña de Meet como docente y otra como
// alumno, ambas comparten el mismo background) — el segundo `joinRoom`
// encontraba la sala del primero YA CREADA (mismo `meetingCode`),
// pisaba `room.role`/`room.email` con la identidad nueva, y reenviaba un
// "join" con esa identidad sobre EL MISMO socket físico. Del lado del
// servidor eso es indistinguible de "esta misma conexión ahora es otra
// persona" (ver `handleJoin` en `backend/src/ws/index.js`): la conexión
// que estaba registrada como alumno se convertía en la del docente, y el
// alumno desaparecía del listado sin que se haya desconectado de verdad.
// El fix: la clave del Map pasa a ser `meetingCode + role + email` — cada
// identidad distinta para una misma reunión obtiene su PROPIA conexión
// física, mientras que varias pestañas de la MISMA identidad siguen
// compartiendo una sola (el comportamiento que esto existía para lograr).
// clave (`roomKey()`) -> { meetingCode, role, email, socket: WebSocket|null, tabIds: Set<number> }
const rooms = new Map();

function roomKey(meetingCode, role, email) {
  return `${meetingCode}::${role || ''}::${email || ''}`;
}

// El "join" se manda en dos lugares (acá, y en `joinRoom` para el caso de
// reconexión de más abajo) — factoreado para no duplicar el `JSON.stringify`
// ni el chequeo de `readyState`. `email` (Etapa 46) solo lo usa el servidor
// si `role === 'student'` (listado de alumnos conectados) — se manda igual
// para el docente, el servidor lo ignora en ese caso.
function sendJoin(room) {
  if (room.socket?.readyState === WebSocket.OPEN) {
    room.socket.send(JSON.stringify({ type: 'join', meetingCode: room.meetingCode, role: room.role, email: room.email }));
  }
}

// Etapa 52 — avisa a cada pestaña suscrita si la conexión FÍSICA de la sala
// está arriba o no, en vivo (no es un evento que reenvíe el servidor, es
// puramente del lado del cliente: se dispara en el 'open'/'close' del
// socket de acá abajo). Antes de esto, el panel no tenía forma de saber que
// su conexión se había caído hasta que un comando le fallaba — con esto
// puede deshabilitar los botones mientras `connected` sea `false` (ver
// App.jsx/TeacherPanel.jsx), en vez de dejar que el usuario apriete un
// botón que sabemos de antemano que va a fallar.
function notifyConnection(room, connected) {
  for (const tabId of room.tabIds) {
    chrome.tabs.sendMessage(tabId, { type: 'SPARKLE_WS_CONNECTION', meetingCode: room.meetingCode, connected }).catch(() => {
      // Misma razón que el catch de abajo en el listener de 'message': la
      // pestaña puede haberse cerrado justo antes.
    });
  }
}

// Etapa 54 — cuánto se espera un "pong" antes de dar la conexión por
// zombie (ver `checkConnectionAlive()` más abajo). Corto a propósito: es
// un mensaje local sin ningún trabajo pesado del lado del servidor, así
// que una conexión sana contesta en milisegundos — no hay motivo para
// tolerar más que eso antes de sospechar que está muerta.
const PING_TIMEOUT_MS = 1500;

// Si esta conexión RECIBIÓ algún mensaje del servidor hace menos que esto,
// está viva: un comando del docente se manda directo, sin el ping previo de
// `checkConnectionAlive`. Una conexión zombie se define justamente por no
// transportar nada, así que tráfico entrante reciente ya prueba lo mismo que
// el pong. Con clase en curso el docente recibe `attention_roster_updated`
// cada pocos segundos, así que en el caso común el ping sobra — y con la
// notebook saturada (Vexa + dos pestañas de Meet), ese ping podía tardar
// más de `PING_TIMEOUT_MS`, darse por zombie y forzar una reconexión: "Detener
// Clase" tardaba ~3 s en tener efecto. `room.lastMessageAt` se reinicia con
// cada socket nuevo (`connectRoom`), así que nunca cuenta tráfico de una
// conexión anterior.
const RECENT_TRAFFIC_MS = 5000;

// Etapa 54 — investigando un reporte de "el WebSocket deja de escuchar
// tras varios minutos sin actividad" se confirmaron dos cosas por lectura
// de código (no por especulación):
//   1. El re-join periódico (Etapa 52) vive en `App.jsx`, del lado del
//      CONTENT SCRIPT — no en este archivo (el service worker). Un content
//      script no se suspende por inactividad como sí le puede pasar a un
//      service worker de Manifest V3 — sobrevive mientras la pestaña siga
//      abierta. La sospecha original ("el setInterval no sobrevive la
//      suspensión del SW") no aplica: ese timer nunca vivió ahí.
//   2. El servidor no tiene NINGÚN timeout de conexión inactiva propio —
//      ni `http.Server` (con `timeout` en 0, el default de Node, sin
//      override en `server.js`) ni la librería `ws` (que no implementa
//      ningún idle-timeout: solo cierra por `close()`/error explícitos, o
//      por el heartbeat propio que ya existe, Etapa 46).
// La causa real: `readyState === WebSocket.OPEN` NO prueba que la conexión
// siga viva. Una conexión "zombie" — cortada en algún punto intermedio de
// la red (NAT/wifi/VPN que descarta un socket inactivo sin mandar ningún
// FIN/RST, la notebook que durmió y volvió, etc.) sin que ninguna de las
// dos puntas reciba una señal de cierre — sigue reportando `OPEN` del lado
// del navegador indefinidamente: el sistema operativo puede tardar HORAS
// en notar por sí solo que la conexión está muerta (el keepalive de TCP
// del SO tiene un intervalo por defecto medido en horas, no en segundos).
// El heartbeat del servidor (ping/pong NATIVO del protocolo WebSocket, vía
// la librería `ws`) sí detecta esto de SU lado en como mucho un par de
// ciclos (~60s) y cierra la conexión ahí — pero ese ping/pong nativo NO es
// visible para JavaScript del lado del navegador (el `WebSocket` nativo lo
// maneja de forma transparente, sin disparar ningún evento) y, aunque el
// servidor sí haga `socket.terminate()`, esa señal de cierre puede no
// llegar nunca de vuelta al cliente si la red que cortó la conexión
// también bloquea el tráfico en ese sentido. El resultado: el cliente se
// queda creyendo que la conexión sigue "abierta" mucho después de que el
// servidor ya la dio de baja.
//
// El fix: un ping/pong PROPIO, a nivel de aplicación (mensajes JSON
// comunes y silvestres, `{ type: 'ping' }` / `{ type: 'pong' }` — ver
// `backend/src/ws/index.js`), que SÍ es visible para este código y permite
// verificar la conexión ACTIVAMENTE en vez de confiar en `readyState`.
// `room.socket` puede cambiar mientras se espera la respuesta (una
// reconexión concurrente lo reemplazaría) — se guarda una referencia local
// al socket ACTUAL al empezar, y se ignora cualquier respuesta si para
// cuando llega ya no es el socket vigente de esta sala.
function checkConnectionAlive(room) {
  const socket = room.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);

  return new Promise((resolve) => {
    let resolved = false;
    const sentAt = Date.now();

    const finish = (alive) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      socket.removeEventListener('message', onMessage);
      logSW(
        `PING(app) sala="${room.meetingCode}" rol=${room.role} → ${alive ? `PONG recibido a los ${Date.now() - sentAt}ms` : `sin respuesta tras ${PING_TIMEOUT_MS}ms (zombie)`}`
      );
      resolve(alive);
    };

    function onMessage(event) {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (message?.type === 'pong') finish(true);
    }

    const timeoutId = setTimeout(() => finish(false), PING_TIMEOUT_MS);
    socket.addEventListener('message', onMessage);
    logSW(`PING(app) sala="${room.meetingCode}" rol=${room.role} → mandado`);
    socket.send(JSON.stringify({ type: 'ping' }));
  });
}

function connectRoom(key) {
  const room = rooms.get(key);
  if (!room) return; // se limpió (ninguna pestaña la sigue necesitando)

  if (room.socket && (room.socket.readyState === WebSocket.OPEN || room.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // ESTA FUNCIÓN TIENE QUE SEGUIR SIENDO SÍNCRONA.
  //
  // La dirección del backend puede venir de `chrome.storage` (ver
  // `../config.js`), que es asíncrono. La tentación es poner un `await` acá,
  // y ROMPE: los llamadores dan por hecho que al volver de `connectRoom()` el
  // socket YA existe, y miran `room.socket.readyState` en la línea siguiente.
  // Con un `await` de por medio, `room.socket` todavía es `undefined` y eso
  // revienta con "Cannot read properties of undefined". Lo detectaron
  // `wsClient.test.js` (Problema 1, Etapa 57 y Etapa 66) — cuatro tests.
  //
  // En vez de esperar siempre, se pregunta si ya hay un valor definitivo. Sólo
  // cuando NO lo hay —los pocos milisegundos entre que arranca el service
  // worker y `chrome.storage` contesta— se pospone el intento. Después de eso
  // este `if` es falso para siempre y la función es enteramente síncrona.
  if (!configuracionHidratada()) {
    configuracionLista.then(() => connectRoom(key));
    return;
  }

  logSW(
    `Creando conexión física nueva para sala="${room.meetingCode}" rol=${room.role} ` +
      `(readyState previo: ${room.socket?.readyState ?? '(sin socket)'}).`
  );
  const socket = new WebSocket(getWsUrl());
  room.socket = socket;
  room.lastMessageAt = 0;

  socket.addEventListener('open', () => {
    logSW(`Conexión física ABIERTA para sala="${room.meetingCode}" rol=${room.role}.`);
    sendJoin(room);
    notifyConnection(room, true);
  });

  socket.addEventListener('message', (event) => {
    // Cualquier mensaje entrante (pong incluido) prueba que ESTA conexión
    // está viva — ver `RECENT_TRAFFIC_MS`.
    if (room.socket === socket) room.lastMessageAt = Date.now();

    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      console.warn('[Sparkle] Mensaje WS no es JSON válido, se ignora.');
      return;
    }

    const TYPES_TO_FORWARD = [
      'class_status',
      'class_started',
      'class_ended',
      'class_resumable',
      'class_resumed',
      'class_start_rejected',
      'students_updated',
      'join_rejected',
      // Preguntas en tiempo real — ver `hooks/useLiveQuestions.js`, el
      // único consumidor de estos seis del lado de la pestaña.
      'question_state',
      'question_started',
      'question_finished',
      'question_stats_updated',
      'question_send_rejected',
      'answer_accepted',
      'answer_rejected',
      // Monitoreo de atención en vivo — ver `hooks/useLiveAttention.js`,
      // único consumidor (solo le llega a sockets "teacher", ver
      // `sendToTeachers` en el backend).
      'attention_roster_updated',
      // Modo de clase — ver `hooks/useAttentionModeSync.js`. A diferencia
      // del de arriba, le llega a AMBOS roles (`broadcast`, no
      // `sendToTeachers`, ver `backend/src/ws/handlers.js`).
      'attention_mode_updated',
    ];
    if (!TYPES_TO_FORWARD.includes(message.type)) return;

    // Reenvío a cada pestaña suscrita a esta sala — el content script
    // decide ahí qué hacer con cada evento (actualizar la vista, disparar
    // un aviso EN el panel), ver App.jsx.
    for (const tabId of room.tabIds) {
      chrome.tabs.sendMessage(tabId, { type: 'SPARKLE_WS_EVENT', payload: message }).catch(() => {
        // La pestaña puede haberse cerrado justo entre el mensaje y el
        // envío; `chrome.tabs.onRemoved` ya se encarga de la limpieza
        // (ver `cleanupTab` más abajo), no hace falta nada acá.
      });
    }
  });

  socket.addEventListener('close', (event) => {
    // `event.code`/`event.reason` (Etapa 56, diagnóstico): un cierre
    // "prolijo" iniciado por este mismo lado (`leaveRoomInternal`) da
    // 1000/"" normalmente; un `code` distinto (ej. 1006, "abnormal
    // closure") es la huella de una conexión que se cortó SOLA — sea
    // porque el servidor la terminó (heartbeat vencido, Etapa 55) o porque
    // la red/el sistema operativo la mató sin ningún cierre prolijo de por
    // medio. Correlacionar este `code` con los logs del backend confirma
    // (o descarta) cuál de los dos lados originó el corte.
    logSW(`Conexión física CERRADA para sala="${room.meetingCode}" rol=${room.role} — code=${event.code} reason="${event.reason || ''}".`);
    // Reintenta solo si la sala sigue existiendo (si `cleanupTab` ya la
    // borró del Map, fue un cierre intencional — no reconectar).
    if (!rooms.has(key)) return;
    notifyConnection(room, false);
    // Etapa 56: si este log aparece pero el de "Creando conexión física
    // nueva" (dentro de `connectRoom`) NUNCA aparece ~`RECONNECT_MS`
    // después, es la huella de que el service worker se suspendió/mató
    // ANTES de que este `setTimeout` llegara a disparar — un `setTimeout`
    // no sobrevive la destrucción del service worker (a diferencia de un
    // `chrome.alarms`, que si el SW se reinicia por otro motivo, Chrome lo
    // vuelve a disparar solo).
    logSW(`Reconexión de sala="${room.meetingCode}" rol=${room.role} agendada para dentro de ${RECONNECT_MS}ms.`);
    setTimeout(() => connectRoom(key), RECONNECT_MS);
  });
}

// Se llama desde el listener de mensajes del background apenas el content
// script determina meetingCode + rol (Etapa 44, punto 6) — incluida una
// RECONEXIÓN (recarga de la pestaña, o reapertura del panel), no solo la
// primera vez.
//
// Bug de reconexión (Etapa 45): si la conexión WS de esta sala ya estaba
// abierta (sobrevive a un reload de la pestaña — el service worker de
// background no se reinicia solo porque una pestaña recargó), el evento
// 'open' del socket YA se disparó hace rato y no vuelve a dispararse — así
// que antes de este fix, `connectRoom` cortaba en su chequeo de
// `readyState` y nunca se volvía a mandar "join". La pestaña reconectada se
// quedaba sin su propio "class_status" de catch-up y mostraba "esperando"
// aunque la clase ya estuviera activa en la base. El fix: si el socket ya
// está OPEN, mandar el "join" acá mismo, a mano.
//
// Etapa 66 — antes de crear/reusar la sala de la identidad ACTUAL
// (`meetingCode`+`role`+`email`), se limpia cualquier sala VIEJA de esta
// misma pestaña para el mismo `meetingCode` pero con una identidad
// DISTINTA (`clearPreviousIdentities`). Cubre el caso de un docente cuyo
// "join" fue rechazado (`join_rejected`, ver `App.jsx`/`TeacherPanel.jsx`)
// y elige "Unirme como alumno": sin esta limpieza, la pestaña quedaría
// registrada en DOS salas a la vez para el mismo `meetingCode` (la vieja,
// rechazada, como "profesor" — y la nueva como "alumno"), dejando una
// conexión física huérfana abierta de más.
export function joinRoom(tabId, meetingCode, role, email) {
  const key = roomKey(meetingCode, role, email);
  clearPreviousIdentities(tabId, meetingCode, key);

  let room = rooms.get(key);
  if (!room) {
    room = { meetingCode, role, email, socket: null, tabIds: new Set() };
    rooms.set(key, room);
  }
  room.tabIds.add(tabId);

  if (room.socket?.readyState === WebSocket.OPEN) {
    console.log(
      `[Sparkle] Sala "${meetingCode}" rol=${role} ya conectada — reenviando "join" (reconexión de la pestaña ${tabId}).`
    );
    sendJoin(room);
    // Etapa 52 — el 'open' del socket ya pasó hace rato (por eso entramos
    // acá), así que nunca va a volver a dispararse para avisarle a ESTA
    // pestaña en particular que la conexión está arriba (recién se agregó a
    // `tabIds` un par de líneas más arriba). Sin este aviso explícito, una
    // pestaña que se une/reconecta a una sala YA conectada se quedaba con
    // `wsConectado` en `false` para siempre en React (ver App.jsx) — los
    // botones de TeacherPanel permanecían deshabilitados sin motivo real.
    notifyConnection(room, true);

    // Etapa 54 — el "join" optimista de arriba no cuesta nada mandarlo
    // igual (si la conexión SÍ está viva, es lo correcto); en paralelo, sin
    // bloquear este `joinRoom` (que sigue siendo síncrono para quien lo
    // llama), se verifica si esa conexión realmente sigue viva o es un
    // zombie (ver `checkConnectionAlive`). Este es el camino PASIVO — lo
    // dispara el re-join periódico de `App.jsx` cada 15s — así que una
    // conexión zombie no depende de que el docente apriete un botón para
    // reparse sola: se detecta y reconecta acá, de fondo.
    checkConnectionAlive(room).then((alive) => {
      if (alive || room.socket?.readyState !== WebSocket.OPEN) return;
      console.warn(
        `[Sparkle] La conexión de "${meetingCode}" rol=${role} no respondió al ping — se da por muerta (zombie) y se fuerza una reconexión.`
      );
      room.socket.close(); // dispara el 'close' de más arriba, que reconecta solo
    });
    return;
  }

  connectRoom(key);
}

// Etapa 66 — ver el comentario de `joinRoom()` de más arriba: recorre
// todas las salas de este `meetingCode` (identidades DISTINTAS a la que se
// está por unir ahora) y saca a `tabId` de cualquiera donde haya quedado
// registrada de una elección de rol anterior (ej. el rechazo de
// "join_rejected" seguido de "Unirme como alumno"). Si esa sala vieja se
// queda sin ninguna pestaña, se cierra su conexión física (mismo camino que
// `leaveRoom`, vía `leaveRoomInternal`) en vez de dejarla abierta sin
// ningún uso.
function clearPreviousIdentities(tabId, meetingCode, currentKey) {
  for (const [key, room] of rooms) {
    if (key === currentKey) continue;
    if (room.meetingCode !== meetingCode) continue;
    if (!room.tabIds.has(tabId)) continue;
    logSW(
      `Pestaña ${tabId} cambia de identidad en "${meetingCode}" — se saca de la sala vieja rol=${room.role} email=${room.email}.`
    );
    leaveRoomInternal(key, room, tabId);
  }
}

// Etapa 57 — reconecta si hace falta, o verifica liveness (ping/pong de
// aplicación) si ya está `OPEN`. Compartido por `keepRoomAlive()` (un
// keepalive puntual, con `tabId` de por medio) y `sweepAllRooms()` (el
// barrido de `chrome.alarms`, sin ningún `tabId` — opera directo sobre lo
// que ya está trackeado en `rooms`) — ver los dos más abajo.
function repairIfNeeded(room, key) {
  if (room.socket?.readyState === WebSocket.OPEN) {
    checkConnectionAlive(room).then((alive) => {
      if (alive || room.socket?.readyState !== WebSocket.OPEN) return;
      logSW(`[keepalive] Sala "${room.meetingCode}" rol=${room.role} — conexión zombie detectada, se fuerza reconexión.`);
      room.socket.close(); // dispara el 'close' de connectRoom(), que reconecta solo
    });
    return;
  }
  connectRoom(key); // no-op si ya está CONNECTING
}

// Etapa 57 — investigando un reporte de "las pestañas se ven desconectadas
// tras un rato en segundo plano" (ver DOCUMENTACION.md para el detalle
// completo) se confirmó una asimetría real en el re-join periódico de la
// Etapa 52: el `setInterval` de `App.jsx` que llama a `joinRoom` cada 15s
// estaba escrito para correr SOLO si `rolBackend === 'teacher'` — el
// alumno nunca tuvo ningún mecanismo periódico. Esto importa porque la
// causa de fondo (documentada por Chrome) es que un service worker de
// Manifest V3 se suspende tras ~30s SIN NINGÚN evento de la extensión — un
// WebSocket abierto pero en silencio no cuenta como actividad por sí solo
// (desde Chrome 116 sí cuenta el TRÁFICO activo por ese socket, pero no
// alcanza con que exista). El re-join periódico del docente funcionaba,
// sin quererlo, como keepalive: cada mensaje de `chrome.runtime` que
// recibe el service worker (sea cual sea, cuenta cualquiera) resetea ese
// timer de inactividad — pero como estaba atado solo al docente, el lado
// del ALUMNO no tenía nada previniendo la suspensión de SU PROPIO service
// worker (cada pestaña de Meet, sea de quien sea, tiene su propia
// instancia de la extensión con su propio service worker independiente).
//
// El fix: esta función es la versión LIVIANA de "asegurate de que esta
// sala siga viva", pensada específicamente para el tick periódico de
// keepalive de `App.jsx` — que ahora corre para AMBOS roles, no como reemplazo
// del join inicial (que sigue siendo `joinRoom`, arriba, con su
// broadcast completo, apropiado solo para un join genuino). La diferencia
// con `joinRoom`: si la sala YA existe y el socket está `OPEN`, acá NO
// se reenvía un "join" completo — un "join" repetido cada 15s, multiplicado
// por potencialmente decenas de alumnos en una clase grande, dispararía
// igual cantidad de broadcasts de `students_updated` a TODA la
// sala sin necesidad (ver `handleJoin` en `backend/src/ws/index.js`).
// Alcanza con el ping/pong de aplicación de la Etapa 54 para dos cosas a
// la vez: (a) confirmar que la conexión sigue viva de verdad y repararla
// si es un zombie, y (b) — el motivo por el que existe esta función — que
// el service worker reciba un mensaje real de `chrome.runtime`, lo cual
// cuenta como actividad de la extensión y evita la suspensión por
// inactividad. Si la sala NO existe (el service worker se reinició del
// todo y perdió el `Map` en memoria), sí hace falta el join completo — se
// delega en `joinRoom`, que ya sabe reconstruirla desde `tabId`/`role`/
// `email`.
export function keepRoomAlive(tabId, meetingCode, role, email) {
  const key = roomKey(meetingCode, role, email);
  const room = rooms.get(key);
  if (!room) {
    logSW(`[keepalive] Sala "${meetingCode}" rol=${role} no existía en el background — reconstruyendo vía joinRoom.`);
    joinRoom(tabId, meetingCode, role, email);
    return;
  }
  room.tabIds.add(tabId); // defensivo: por si esta pestaña puntual todavía no estaba
  repairIfNeeded(room, key);
}

// Etapa 57 — red de seguridad INDEPENDIENTE del keepalive de arriba:
// `chrome.alarms`, a diferencia de un `setTimeout`/`setInterval` de este
// mismo archivo, lo gestiona EL NAVEGADOR, no el runtime JS del service
// worker — Chrome lo sigue disparando en su horario aunque el service
// worker se haya suspendido entre medio, despertándolo específicamente
// para esto (es, literalmente, el mecanismo que Chrome documenta para
// este problema — ver DOCUMENTACION.md). No necesita que ninguna pestaña
// le mande un mensaje para dispararse (a diferencia de `keepRoomAlive`,
// que sí depende de eso) — cubre el caso en que, por lo que sea, ninguna
// pestaña llegó a mandar su keepalive a tiempo (ej. throttling agresivo de
// una pestaña en segundo plano prolongado). Limitación real, y por qué NO
// reemplaza a `keepRoomAlive`: este barrido solo puede reparar/reconectar
// salas que YA estén trackeadas en `rooms` — si el service worker se
// reinició del todo y perdió el `Map` en memoria, no tiene de dónde sacar
// el `tabId`/`role`/`email` para reconstruir una sala desde cero (eso
// sigue dependiendo de que una pestaña mande su keepalive/join, que sí
// trae esos datos). Ambos mecanismos son complementarios, no alternativos.
function sweepAllRooms(origin) {
  logSW(`[keepalive] Barrido de ${rooms.size} sala(s) trackeada(s) — origen: ${origin}.`);
  for (const [key, room] of rooms) repairIfNeeded(room, key);
}

// 0.5 minutos (30s) — el mínimo que permite `chrome.alarms.create()`.
const ALARM_KEEPALIVE_NAME = 'sparkle-keepalive';
const ALARM_KEEPALIVE_PERIOD_MIN = 0.5;

// Se registra una sola vez, al evaluar este módulo (mismo momento que el
// log de arranque de más arriba) — `typeof chrome !== 'undefined' &&
// chrome.alarms` evita reventar en los tests (`wsClient.test.js` mockea
// `chrome.tabs`/`chrome.runtime` pero no necesariamente `chrome.alarms`) y,
// en los hechos, también documenta que este archivo no asume que el
// permiso `"alarms"` esté siempre disponible.
if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.create(ALARM_KEEPALIVE_NAME, {
    periodInMinutes: ALARM_KEEPALIVE_PERIOD_MIN,
    delayInMinutes: ALARM_KEEPALIVE_PERIOD_MIN,
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_KEEPALIVE_NAME) return;
    sweepAllRooms('chrome.alarms');
  });
}

// Etapa 52 — espera (reintentando la conexión activamente, no solo el
// timer pasivo de `RECONNECT_MS`) a que la sala tenga un socket físico
// OPEN, en vez de fallar apenas se la consulta en un instante en que
// todavía no lo está. Dos casos cubiertos, indistintamente:
//   1. La sala existe pero el socket está CONNECTING o a mitad de un
//      reintento tras un corte — se sondea cada `COMMAND_WAIT_POLL_MS`
//      hasta que quede OPEN.
//   2. La sala NO existe en este Map — típicamente porque el service
//      worker se reinició (MV3 puede suspenderlo por inactividad y volverlo
//      a levantar en cualquier momento, perdiendo todo el estado en
//      memoria) y ya nadie volvió a mandar "join". `tabId`/`role`/`email`
//      (los mismos datos que ya tenía guardados el content script, que SÍ
//      sobrevive al reinicio del service worker) alcanzan para reconstruir
//      la sala desde cero, vía `joinRoom`, y seguir esperando desde ahí.
//   3. La sala existe, el socket está OPEN, PERO es una conexión zombie
//      (Etapa 54, ver `checkConnectionAlive` más arriba) — se fuerza su
//      cierre y se sigue el loop esperando a que la reconexión real
//      complete, en vez de mandar el comando a un socket que nunca lo va a
//      entregar.
// Con esto, CUALQUIER comando del docente (los tres de abajo, y cualquiera
// que se agregue después) queda cubierto en un solo lugar — no hace falta
// un reintento particular por botón. Este es el camino ACTIVO (dispara con
// cada click del docente, no con un timer) — la garantía de fondo real:
// sin importar si el re-join periódico llegó a detectar/reparar una
// conexión zombie o no, ESTE chequeo se hace de nuevo, siempre, antes de
// confiar en la conexión para ejecutar la acción que el docente pidió.
async function waitForSocketOpen(tabId, meetingCode, role, email) {
  const key = roomKey(meetingCode, role, email);
  const deadline = Date.now() + COMMAND_WAIT_MAX_MS;
  let rejoinAttempted = false;

  while (Date.now() < deadline) {
    let room = rooms.get(key);

    if (!room && !rejoinAttempted) {
      rejoinAttempted = true;
      console.log(`[Sparkle] Sala "${meetingCode}" rol=${role} no existía en el background — se reconstruye antes del comando.`);
      joinRoom(tabId, meetingCode, role, email);
      room = rooms.get(key);
    }

    if (room?.socket?.readyState === WebSocket.OPEN) {
      if (Date.now() - (room.lastMessageAt || 0) < RECENT_TRAFFIC_MS) return room;
      const alive = await checkConnectionAlive(room);
      if (alive) return room;
      console.warn(
        `[Sparkle] Sala "${meetingCode}" rol=${role}: conexión no respondió al ping antes de ejecutar un comando — se da por ` +
          `muerta (zombie) y se fuerza una reconexión.`
      );
      room.socket?.close(); // dispara el 'close' de connectRoom(), que reconecta solo
    } else if (room) {
      connectRoom(key); // no-op si ya hay una conexión en curso
    }

    await wait(COMMAND_WAIT_POLL_MS);
  }

  return null;
}

// Los comandos del docente comparten la misma forma: asegurarse de tener
// una conexión abierta a la sala (reconectando/reconstruyendo si hace
// falta, ver `waitForSocketOpen`) y mandar el tipo de mensaje
// correspondiente. `payload` (preguntas en tiempo real) se mezcla en el
// mensaje además de `type`/`meetingCode` — los tres comandos originales
// (iniciar/finalizar/reanudar clase) no necesitan ninguno, así que su forma
// no cambió, solo se agregó el parámetro con default `{}`.
async function sendTeacherCommand(tabId, meetingCode, email, type, payload = {}) {
  const room = await waitForSocketOpen(tabId, meetingCode, 'teacher', email);
  if (!room) {
    throw new Error('WebSocket no conectado a esa sala todavía — reintentá en un momento.');
  }
  room.socket.send(JSON.stringify({ type, meetingCode, ...payload }));
  return { ok: true };
}

// Simétrico a `sendTeacherCommand`, para los comandos que manda un ALUMNO
// (responder/saltear una pregunta) — mismo `waitForSocketOpen`, pero con
// rol "student".
async function sendStudentCommand(tabId, meetingCode, email, type, payload = {}) {
  const room = await waitForSocketOpen(tabId, meetingCode, 'student', email);
  if (!room) {
    throw new Error('WebSocket no conectado a esa sala todavía — reintentá en un momento.');
  }
  room.socket.send(JSON.stringify({ type, meetingCode, ...payload }));
  return { ok: true };
}

export function startClass(tabId, meetingCode, email) {
  return sendTeacherCommand(tabId, meetingCode, email, 'start_class');
}

export function endClass(tabId, meetingCode, email) {
  return sendTeacherCommand(tabId, meetingCode, email, 'end_class');
}

// Etapa 50: el docente elige "Reanudar" en el prompt que dispara
// "class_resumable".
export function resumeClass(tabId, meetingCode, email) {
  return sendTeacherCommand(tabId, meetingCode, email, 'resume_class');
}

// El docente elige un modo de clase en el selector de la pantalla pre-clase
// — `modeId` es 1-5. El backend persiste, resuelve el preset completo
// (X/Y/K/Q/C del alumno + P/V_doc/Q_doc/C_doc del docente) y lo manda de
// vuelta a TODA la sala como "attention_mode_updated" (ver
// `ws/handlers.js#handleSetAttentionMode`) — este comando solo entrega el
// pedido, no devuelve el preset él mismo.
export function setAttentionMode(tabId, meetingCode, email, modeId) {
  return sendTeacherCommand(tabId, meetingCode, email, 'set_attention_mode', { modeId });
}

// Preguntas en tiempo real — el docente "Envía" la pregunta que estaba
// revisando (ver `screens/GenerateQuestion.jsx`); `question` es
// `{ prompt, options, correctOptionIndex, durationSeconds }`. El backend
// persiste y hace el broadcast (ver `backend/src/ws/handlers.js`,
// `handleSendQuestion`) — este comando solo entrega el mensaje.
export function sendQuestion(tabId, meetingCode, email, question) {
  return sendTeacherCommand(tabId, meetingCode, email, 'send_question', question);
}

// El docente corta la pregunta antes de que venza (ver `LiveQuestionStats.jsx`).
export function finishQuestion(tabId, meetingCode, email, questionId) {
  return sendTeacherCommand(tabId, meetingCode, email, 'finish_question', { questionId });
}

// Un alumno responde — `selectedOptionIndex` es 0-3; el backend calcula
// `isCorrect` del lado del servidor, nunca se manda desde acá.
export function answerQuestion(tabId, meetingCode, email, questionId, selectedOptionIndex) {
  return sendStudentCommand(tabId, meetingCode, email, 'answer_question', { questionId, selectedOptionIndex });
}

// "Prefiero no responder", ya confirmado del lado de la UI (ver
// `screens/StudentPanel.jsx`) — acá solo viaja la decisión ya tomada.
export function skipQuestion(tabId, meetingCode, email, questionId) {
  return sendStudentCommand(tabId, meetingCode, email, 'skip_question', { questionId });
}

// Monitoreo de atención en vivo (panel del docente, `ConcentrationStats.jsx`)
// — `snapshot` es `{ anonId, name, kind, concentration, inattentive,
// noFaceFraction, ts }`, generado y enviado periódicamente por
// `hooks/useAttentionBroadcast.js` mientras la cámara del alumno está
// activa. Ver el comentario de privacidad en ese hook y en
// `backend/src/ws/handlers.js`, `handleAttentionSnapshot`.
//
// `kind` (NO `type`) es a propósito: `sendStudentCommand`, acá abajo, arma
// el mensaje real de WS como `{ type: 'attention_snapshot', meetingCode,
// ...payload }` — si `snapshot` tuviera su propio campo `type`, el spread
// lo pisaría y el backend nunca vería `type === 'attention_snapshot'` (se
// descartaría en silencio, sin matchear ningún branch de `ws/index.js`).
export function sendAttentionSnapshot(tabId, meetingCode, email, snapshot) {
  return sendStudentCommand(tabId, meetingCode, email, 'attention_snapshot', snapshot);
}

// El alumno apagó la cámara — saca su entrada del roster del docente en
// vez de dejarla con un valor último "congelado" para siempre.
export function sendAttentionStopped(tabId, meetingCode, email, anonId) {
  return sendStudentCommand(tabId, meetingCode, email, 'attention_stopped', { anonId });
}

// Saca a `tabId` de `room` y, si era la última pestaña interesada, borra la
// sala del Map y cierra su conexión física — con eso el servidor ve un
// `close` real y hace toda su limpieza de siempre (sacar el socket de su
// propia sala, avisar `students_updated` si era alumno — ver
// backend/src/ws/index.js, Etapa 46), exactamente el mismo camino que ya
// usa una desconexión abrupta o el cierre de la pestaña. No hace falta un
// mensaje "leave" nuevo en el protocolo WS: cerrar la conexión YA ES la
// señal de salida, tanto para el servidor como para quien reconecte
// después (Etapa 45: un `join` posterior abre un socket nuevo sin problema).
function leaveRoomInternal(key, room, tabId) {
  room.tabIds.delete(tabId);
  if (room.tabIds.size === 0) {
    rooms.delete(key);
    room.socket?.close();
  }
}

// Se llama explícitamente cuando `callStage` deja de ser 'en-llamada'
// (Etapa 47) — a diferencia de `cleanupTab`, acá la PESTAÑA sigue abierta
// (el usuario está en el lobby, la sala de espera, o la pantalla de
// salida), solo dejó de interesarle ESTA sala puntual.
//
// Etapa 66 — ya no alcanza con `rooms.get(meetingCode)` (la clave ahora
// incluye role+email, que este llamador no conoce — ver
// `backendMessaging.js`, `leaveRoom()` solo recibe `meetingCode`): se
// recorren las salas de este `meetingCode` buscando en cuál está `tabId`
// (a lo sumo en una — una pestaña solo tiene una identidad activa a la vez
// para un mismo `meetingCode`, ver `clearPreviousIdentities`).
export function leaveRoom(tabId, meetingCode) {
  for (const [key, room] of rooms) {
    if (room.meetingCode === meetingCode && room.tabIds.has(tabId)) {
      leaveRoomInternal(key, room, tabId);
    }
  }
}

// Se engancha a `chrome.tabs.onRemoved` desde background/main.js: si una
// pestaña se cierra, se saca de todas las salas donde figuraba (a
// diferencia de `leaveRoom`, acá no se sabe de antemano en qué sala
// estaba esta pestaña, así que se recorren todas).
export function cleanupTab(tabId) {
  for (const [key, room] of rooms) {
    leaveRoomInternal(key, room, tabId);
  }
}
