const {
  rooms,
  logWS,
  addToRoom,
  removeFromRoom,
  send,
  broadcast,
  getConnectedStudents,
  broadcastStudentList,
  sendToTeachers,
  sendToStudents,
  isTeacherConnected,
} = require('./rooms');
const roleService = require('../services/roleService');
const classService = require('../services/classService');
const sessionService = require('../services/sessionService');
const questionService = require('../services/questionService');
const questionTimers = require('./questionTimers');
const attentionState = require('./attentionState');
const vexaService = require('../services/vexaService');
const documentService = require('../services/documentService');
const { isValidAttentionMode, resolveAttentionMode } = require('../constants/attentionModes');

const OPTION_LETTERS = ['a', 'b', 'c', 'd'];

// ── Período de gracia ante la desconexión del docente ────────────────────
//
// Chrome CONGELA las pestañas en segundo plano ("tab freezing"): si el
// docente pasa a otra pestaña o minimiza la ventana un rato, el navegador
// le corta los timers y termina cerrando el WebSocket. Desde el servidor
// eso es indistinguible de "cerró la pestaña y se fue", y sin este período
// de gracia la clase se finalizaba SOLA — con el docente todavía en la
// reunión de Meet, sin haber hecho nada.
//
// El mecanismo de `sparkleReplaced` de `handleJoin`/`handleClose` NO cubre
// este caso: ese resuelve el F5, donde el socket nuevo llega ANTES de que
// el viejo termine de cerrarse. Con una pestaña congelada el orden es el
// inverso — primero el "close", y la reconexión recién cuando la pestaña
// vuelve al frente, con la clase ya finalizada.
//
// Por eso la finalización automática se DEMORA: si el docente vuelve
// dentro de la ventana, el timer se cancela y la clase nunca se enteró.
// Solo si no vuelve se finaliza, con el mismo efecto de antes.
//
// ⚠️ Esto NO toca la finalización MANUAL ("Detener Clase"), que sigue
// siendo inmediata: ahí el docente expresó una intención y hacerlo esperar
// sería un bug distinto.
//
// El valor por defecto (90 s) es un compromiso: cubre de sobra una
// congelación de pestaña o un microcorte de red, y hace que una salida de
// verdad tarde minuto y medio en registrarse — que no le molesta a nadie,
// porque la clase ya no tiene quién la conduzca de todos modos.
const GRACIA_DESCONEXION_DOCENTE_MS = Number(process.env.TEACHER_DISCONNECT_GRACE_MS ?? 90_000);

// meetingCode → Timeout pendiente. Solo puede haber uno por reunión: si el
// docente se cae, vuelve y se vuelve a caer, el segundo `handleClose`
// reemplaza al primero (ver `programarFinalizacionAutomatica`).
const finalizacionesPendientes = new Map();

function cancelarFinalizacionPendiente(meetingCode, motivo) {
  const timer = finalizacionesPendientes.get(meetingCode);
  if (!timer) return false;

  clearTimeout(timer);
  finalizacionesPendientes.delete(meetingCode);
  logWS(`Finalización automática CANCELADA para "${meetingCode}" — ${motivo}.`);
  return true;
}

// ─── Período de gracia del bot de Vexa ─────────────────────────────────
//
// Mismo problema que el de arriba, en el camino de al lado, y no lo cubría
// el arreglo de v0.1.2: cuando la sala WS queda vacía, el bot de
// transcripción salía de la reunión EN EL ACTO. Chrome congela las
// pestañas en segundo plano y les cierra el WebSocket, así que basta con
// que las pestañas del docente y del alumno se congelen casi a la vez para
// que la sala parezca vacía por un instante y el bot se vaya de una
// reunión que sigue en curso.
//
// Pasó de verdad en la reunión "jaa-ybou-siz" (6/9/2026): los dos sockets
// se cerraron con 200 ms de diferencia, el bot salió, y dos segundos
// después los dos volvieron. La clase se salvó —esa SÍ tenía gracia y se
// canceló— pero el bot ya estaba afuera.
//
// ⚠️ Y volver no es gratis: el `startBot` del re-join pide un bot NUEVO,
// que entra a "awaiting_admission" y necesita que alguien apriete
// "Admitir" en Meet. Si nadie lo hace, Meet lo descarta a los ~5 minutos
// con `join_failure` y la reunión se queda sin transcripción para siempre,
// sin ningún error visible del lado de Sparkle. Por eso el arreglo es
// evitar la salida, no confiar en la reentrada.
//
// Se demora por el mismo motivo y con la misma ventana que la finalización
// de la clase: si alguien vuelve, el bot nunca se enteró de nada.
const GRACIA_SALA_VACIA_MS = Number(process.env.EMPTY_ROOM_BOT_GRACE_MS ?? GRACIA_DESCONEXION_DOCENTE_MS);

// meetingCode → Timeout pendiente, uno por reunión.
const parosDeBotPendientes = new Map();

function cancelarParoDeBotPendiente(meetingCode, motivo) {
  const timer = parosDeBotPendientes.get(meetingCode);
  if (!timer) return false;

  clearTimeout(timer);
  parosDeBotPendientes.delete(meetingCode);
  logWS(`Salida del bot de Vexa CANCELADA para "${meetingCode}" — ${motivo}.`);
  return true;
}

// El chequeo de "la sala sigue vacía" se repite DENTRO del timer y no acá,
// por lo mismo que en `programarFinalizacionAutomatica`: entre que se
// programa y que dispara pasa minuto y medio, y lo que importa es el
// estado al ejecutar, no al programar.
function programarSalidaDelBot(meetingCode) {
  cancelarParoDeBotPendiente(meetingCode, 'llegó una desconexión más nueva');

  logWS(
    `Sala "${meetingCode}" vacía — el bot de Vexa saldrá en ` +
      `${Math.round(GRACIA_SALA_VACIA_MS / 1000)} s si no vuelve nadie.`
  );

  const timer = setTimeout(() => {
    parosDeBotPendientes.delete(meetingCode);
    if (rooms.has(meetingCode)) {
      logWS(`Salida del bot de Vexa DESCARTADA para "${meetingCode}" — la sala volvió a tener gente.`);
      return;
    }
    logWS(`Sacando el bot de Vexa de "${meetingCode}" — la sala siguió vacía todo el período de gracia.`);
    vexaService.stopBot(meetingCode).catch((err) => console.error('[Vexa] stopBot on empty room failed:', err));
    vexaService.stopPolling(meetingCode);
  }, GRACIA_SALA_VACIA_MS);

  // Mismo motivo que en la finalización diferida: un timer pendiente no
  // tiene que mantener vivo el proceso de `node --test`.
  if (typeof timer.unref === 'function') timer.unref();

  parosDeBotPendientes.set(meetingCode, timer);
}

// Handlers de cada tipo de mensaje WS — orquestan: leen/escriben el estado
// EN MEMORIA de la sala (`./rooms.js`) y llaman a las reglas de negocio de
// `services/` (las MISMAS que usa la capa REST, ver
// `controllers/meetingsController.js` — nada de esto se reimplementa acá).
// Cero SQL directo en este archivo.
const VALID_ROLES = ['teacher', 'student'];

// Cuando la clase arranca (o se reanuda) con alumnos que YA estaban
// conectados a la sala esperando, cada uno de ellos "empieza" su sesión de
// conexión recién ahora — no desde que se unieron a la sala en silencio.
// Vive acá (no en `services/sessionService.js`) porque necesita el listado
// de conectados AHORA MISMO, que es estado en memoria de la sala — el
// service no lo conoce, solo sabe abrir/cerrar una sesión puntual.
async function openSessionsForConnectedStudents(meetingCode) {
  for (const { email } of getConnectedStudents(meetingCode)) {
    await sessionService.openSession(meetingCode, email);
  }
}

// Un cliente (docente o alumno) se une a la sala de su meetingCode. Se
// consulta el estado ACTUAL en la base (no el de memoria) y se le contesta
// de inmediato con "class_status" — así un alumno que se conecta tarde (o
// que recarga/reconecta) ve el estado correcto sin esperar a que el
// docente vuelva a apretar "Comenzar Clase".
//
// Etapa 51 — solo un "teacher" por sala: si el que se une es "teacher" y
// YA hay otro socket con ese rol en la sala, se evalúa si es la MISMA
// persona (mismo email) reconectándose — ej. un F5 donde el socket físico
// viejo todavía no terminó su handshake de cierre del lado del servidor
// cuando el nuevo ya está mandando su "join" (una carrera genuina, dados
// dos round-trips de red independientes) — en ese caso se reemplaza la
// conexión vieja sin más trámite. Si es una persona DISTINTA, se rechaza
// con "join_rejected" y no se completa la unión. El email se guarda para
// AMBOS roles — es lo que hace posible esta comparación de "¿sos la misma
// persona?".
//
// Etapa 61 — este chequeo EN MEMORIA (contra `rooms`, conexiones activas
// ahora mismo) sigue siendo el primero: cubre la ventana de carrera más
// chica y más probable (dos "join" casi simultáneos) sin esperar ningún
// round-trip a la base. Pero YA NO es el único: justo después se suma el
// chequeo PERMANENTE contra la base (`roleService.otherTeacherExists`)
// — así que un profesor que se desconectó hace rato sigue bloqueando a
// cualquier OTRO email, aunque `rooms` ya no tenga ningún rastro de él.
async function handleJoin(socket, meetingCode, role, email) {
  const normalizedRole = VALID_ROLES.includes(role) ? role : null;
  const normalizedEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;

  if (normalizedRole === 'teacher') {
    const targetRoom = rooms.get(meetingCode);
    if (targetRoom) {
      for (const other of targetRoom) {
        if (other === socket || other.role !== 'teacher') continue;

        if (normalizedEmail && other.email === normalizedEmail) {
          logWS(
            `JOIN de profesor: se reemplaza una conexión física previa del mismo docente ` +
              `(email=${normalizedEmail}) en "${meetingCode}".`
          );
          removeFromRoom(meetingCode, other);
          // El "close" físico del socket viejo todavía va a llegar en algún
          // momento (el navegador recién está terminando de cerrar esa
          // conexión) — sin este flag, `handleClose()` lo procesaría de
          // nuevo cuando llegue: no hace daño por sí solo (`removeFromRoom`
          // ya es no-op sobre un socket que no está en la sala), PERO más
          // abajo en ESTE `handleJoin` todavía queda un `await
          // roleService.otherTeacherExists(...)` antes de que el socket
          // NUEVO se agregue con `addToRoom()` — si el "close" tardío llega
          // justo en esa ventana y no quedaba nadie más en la sala (ej. el
          // docente estaba solo), `rooms.has(meetingCode)` daría `false` por
          // un instante y `handleClose()` pararía el bot de Vexa aunque el
          // docente esté en pleno proceso de volver a entrar (F5), no de
          // irse. Este flag hace que `handleClose()` reconozca a este socket
          // como "ya reemplazado" y se retire sin tocar la sala ni el bot.
          other.sparkleReplaced = true;
          continue;
        }

        logWS(`JOIN RECHAZADO — ya hay otro profesor conectado a la reunión "${meetingCode}".`);
        send(socket, { type: 'join_rejected', meetingCode, reason: 'teacher_exists' });
        await roleService.clearTeacherRoleIfApplicable(meetingCode, normalizedEmail);
        return;
      }
    }

    if (await roleService.otherTeacherExists(meetingCode, normalizedEmail)) {
      logWS(
        `JOIN RECHAZADO — la reunión "${meetingCode}" ya tiene un profesor permanente distinto ` +
          `(email=${normalizedEmail}).`
      );
      send(socket, { type: 'join_rejected', meetingCode, reason: 'teacher_exists' });
      await roleService.clearTeacherRoleIfApplicable(meetingCode, normalizedEmail);
      return;
    }
  }

  const wasAlreadyInARoom = Boolean(socket.meetingCode);
  if (wasAlreadyInARoom) removeFromRoom(socket.meetingCode, socket);

  socket.meetingCode = meetingCode;
  socket.role = normalizedRole;
  socket.email = normalizedEmail;
  // Etapa 68 — cargado de la base, nunca confiado del cliente. Solo tiene
  // sentido para "student"; queda `null` para "teacher" sin necesidad de
  // una consulta de más.
  socket.name = normalizedRole === 'student' ? await roleService.getStudentName(meetingCode, normalizedEmail) : null;
  addToRoom(meetingCode, socket);

  // La sala dejó de estar vacía: si había una salida del bot programada,
  // se cancela. Va para CUALQUIER rol —lo que dispara la salida es que no
  // quede nadie, no que falte el docente— y después de `addToRoom`, para
  // que un timer que dispare justo en el medio encuentre la sala ya
  // poblada.
  cancelarParoDeBotPendiente(meetingCode, 'volvió a haber gente en la sala');

  logWS(
    `JOIN — meetingCode="${meetingCode}" role=${socket.role} email=${socket.email} ` +
      `(${wasAlreadyInARoom ? 're-join sobre el mismo socket físico' : 'primer join de este socket'})`
  );

  const state = await classService.getClassState(meetingCode);
  const active = state ? Boolean(state.active) : false;

  // Vexa — el bot de transcripción entra a la reunión en cuanto se detecta
  // un "docente" entre los participantes (esta sala WS de Sparkle es
  // nuestra propia lista de participantes: no hay lectura del roster real
  // de Google Meet, ver DOCUMENTACION.md). Deliberadamente INDEPENDIENTE de
  // `active` (el estado pedagógico de "clase" — preguntas, atención, etc.):
  // el bot arranca con la sola presencia del docente en la sala, sin
  // esperar a que además apriete "Comenzar Clase", y desde ahí inserta
  // transcripción todo el tiempo que esté en la reunión, sin ningún filtro
  // por estado de clase. Cubre de una el primer join, una reconexión (F5,
  // wifi que cae) y el caso de que el bot haya sido echado del Meet
  // manualmente — Vexa maneja solo el pedido si ya tiene un bot para este
  // meetingCode (ver `startBot` en `services/vexaService.js`), así que
  // llamarlo en cada join del docente es seguro (best-effort, no bloquea
  // el resto del "join"); `startPolling` también es no-op si ya había un
  // polling corriendo para esta reunión.
  if (socket.role === 'teacher') {
    // El docente volvió dentro del período de gracia: la clase que estaba
    // por finalizarse sola sigue viva y nadie se entera de que hubo un
    // corte. Va DESPUÉS de `addToRoom` a propósito — si el timer llegara a
    // dispararse justo en el medio, tiene que encontrar a este socket ya
    // en la sala para que su `isTeacherConnected` dé verdadero.
    cancelarFinalizacionPendiente(meetingCode, 'el docente volvió dentro del período de gracia');

    vexaService.startPolling(meetingCode);
    vexaService.startBot(meetingCode).catch((err) => console.error('[Vexa] startBot on join failed:', err));
  }

  // Etapa 68, Cambio 3 — si este alumno se une (o reconecta) con la clase
  // YA activa, su sesión de conexión empieza ACÁ (no cuando la clase
  // eventualmente arranque después: ya está arrancada).
  if (socket.role === 'student' && active) {
    await sessionService.openSession(meetingCode, normalizedEmail);
  }

  send(socket, { type: 'class_status', meetingCode, active });
  // Catch-up del listado para ESTE socket (docente o alumno que recién se
  // une/reconecta) — simétrico a "class_status". Si el que se unió es un
  // alumno, además se avisa a TODA la sala (ej. al docente) de que la lista
  // cambió.
  send(socket, { type: 'students_updated', meetingCode, students: getConnectedStudents(meetingCode) });
  if (socket.role === 'student') broadcastStudentList(meetingCode);

  // Prompt de "reanudar" (Etapa 50) — SOLO para el docente, y solo catch-up
  // dirigido a este socket. Ver `services/classService.isResumable()`
  // para el criterio exacto.
  if (socket.role === 'teacher' && classService.isResumable(state)) {
    logWS(
      `Reunión "${meetingCode}" reanudable (última finalización ${state.last_ended_type || '?'} reciente) ` +
        `— se avisa al docente.`
    );
    send(socket, { type: 'class_resumable', meetingCode });
  }

  // Preguntas en tiempo real — catch-up simétrico al de "class_status": un
  // alumno que entra tarde o se reconecta, o un docente que recarga el
  // panel mientras una pregunta sigue activa, tiene que verla sin hacer
  // nada (ver `sendQuestionStateCatchUp` más abajo).
  await sendQuestionStateCatchUp(socket, meetingCode);

  // Monitoreo de atención en vivo — catch-up SOLO para el docente (mismo
  // criterio que las estadísticas de preguntas): si recarga el panel a
  // mitad de clase, ve de una el roster vigente en vez de esperar a que
  // algún alumno mande su próximo snapshot.
  if (socket.role === 'teacher') {
    send(socket, {
      type: 'attention_roster_updated',
      meetingCode,
      students: attentionState.getSnapshot(meetingCode),
    });
  }

  // Modo de atención (X/Y/K/Q/C del alumno + P/V_doc/Q_doc/C_doc del
  // docente) — catch-up para AMBOS roles, a diferencia del roster de arriba:
  // un alumno que entra a una reunión ya en curso (o un docente que
  // recarga la pantalla pre-clase) tiene que arrancar con el modo vigente
  // sin esperar a que alguien vuelva a tocar el selector. Mismo mensaje que
  // ya usa `handleSetAttentionMode` para el broadcast en vivo — el
  // frontend no necesita distinguir "esto es catch-up" de "esto es un
  // cambio real", en los dos casos hay que aplicar el modo tal cual llega.
  send(socket, {
    type: 'attention_mode_updated',
    meetingCode,
    ...resolveAttentionMode(state?.attention_mode_id),
  });
}

// Solo el docente puede iniciar la clase — se chequea el rol registrado en
// el "join" de ESTE socket, no un dato que mande el cliente en este
// mensaje (evita que cualquiera con acceso a la consola del navegador
// mande el evento manualmente).
//
// Etapa 61 — segunda barrera, además de la de `handleJoin()`: revalida
// `otherTeacherExists()` acá también, justo antes de arrancar la
// clase — cubre el caso borde de que ese estado local haya quedado
// desincronizado del estado real de la base (ej. el profesor legítimo se
// registró en otra pestaña/dispositivo DESPUÉS de que este socket ya se
// hubiera unido).
async function handleStartClass(socket, meetingCode) {
  if (socket.role !== 'teacher') {
    console.warn(
      `[Sparkle][WS] Se ignoró "start_class" de un socket sin rol "teacher" (role=${socket.role}) ` +
        `para la reunión ${meetingCode}.`
    );
    return;
  }

  if (await roleService.otherTeacherExists(meetingCode, socket.email)) {
    logWS(
      `"start_class" RECHAZADO — la reunión "${meetingCode}" ya tiene un profesor permanente distinto ` +
        `(email=${socket.email}).`
    );
    send(socket, { type: 'join_rejected', meetingCode, reason: 'teacher_exists' });
    await roleService.clearTeacherRoleIfApplicable(meetingCode, socket.email);
    return;
  }

  // Requisito de producto — no se puede comenzar la clase sin material
  // cargado Y ANALIZADO OK (ver `services/documentService.js`,
  // `services/documentAnalysisService.js`). Validación AUTORITATIVA: esta
  // de acá, no la del frontend — `TeacherPanel.jsx` deshabilita el botón
  // "Comenzar Clase" mientras el análisis no esté en 'processed' como
  // barrera de UI/UX, pero deshabilitar un botón no es una regla de
  // negocio; esto cubre cualquier otro camino (ej. un mensaje WS armado a
  // mano, sin pasar por el botón).
  if (!(await documentService.isDocumentReadyForMeeting(meetingCode))) {
    logWS(`"start_class" RECHAZADO — la reunión "${meetingCode}" todavía no tiene un documento listo (cargado y analizado).`);
    send(socket, {
      type: 'class_start_rejected',
      meetingCode,
      reason: 'missing_document',
      message: 'Cargá el material de la clase y esperá a que termine de analizarse antes de comenzar.',
    });
    return;
  }

  await classService.startClass(meetingCode);
  // Vexa — el bot ya se pidió al entrar el docente a la sala
  // (`handleJoin`), pero se vuelve a pedir acá A PROPÓSITO.
  //
  // El comentario anterior decía que no hacía falta porque el ciclo de vida
  // del bot está desacoplado del estado pedagógico de "clase". Eso sigue
  // siendo cierto para cuándo ARRANCA el bot, y era una mala razón para no
  // reintentar: dejaba el `join` como la ÚNICA oportunidad de conseguir un
  // bot en toda la reunión. Si el bot se cae o lo echan del Meet a mitad de
  // clase, la única forma de recuperarlo era que el docente **recargara la
  // pestaña** — algo que nadie adivina, y que no da ninguna señal: la clase
  // arranca normal, solo que sin transcripción. Verificado el 6/9/2026
  // echando el bot a mano: "reanudar clase" no generaba un solo `startBot`.
  //
  // Volver a pedirlo es barato y seguro: si el bot está vivo, Vexa contesta
  // 409 y `startBot` corta sin tocar nada (ver `sesionVivaEnVexa`);
  // `startPolling` es no-op si ya había uno corriendo.
  vexaService.startPolling(meetingCode);
  vexaService.startBot(meetingCode).catch((err) => console.error('[Vexa] startBot on start_class failed:', err));

  console.log(`[Sparkle][WS] Clase iniciada para la reunión "${meetingCode}".`);
  broadcast(meetingCode, { type: 'class_started', meetingCode });
  await openSessionsForConnectedStudents(meetingCode);
}

// Simétrico a `handleStartClass` (Etapa 45): mismo chequeo de rol, mismo
// patrón de "actualizar la base y después avisarle a la sala".
//
// Etapa 58 — regresión reportada al probar en Chrome real: `class_resumable`
// solo se mandaba como catch-up de un "join" NUEVO — en una desconexión
// automática eso pasa solo (el docente necesariamente reconecta para volver
// a ver el panel), pero acá el docente hace click en "Detener Clase" y se
// queda en la MISMA conexión abierta, sin mandar ningún "join" nuevo: nunca
// le llegaba `class_resumable`. El fix: avisarle acá mismo, directo, a
// cualquier socket "teacher" que siga en la sala.
//
// Corrección — no se puede detener la clase mientras haya una pregunta
// activa (ni su cronómetro ni su estado se tocan acá: simplemente se
// rechaza el pedido de una). Validación AUTORITATIVA — `TeacherPanel.jsx`
// ya deshabilita el botón mientras `activeQuestion` exista, esto cubre
// cualquier otro camino (mensaje WS a mano, una carrera entre el timer de
// vencimiento y el click).
async function handleEndClass(socket, meetingCode) {
  if (socket.role !== 'teacher') {
    console.warn(
      `[Sparkle][WS] Se ignoró "end_class" de un socket sin rol "teacher" (role=${socket.role}) ` +
        `para la reunión ${meetingCode}.`
    );
    return;
  }

  if (await questionService.getActiveQuestion(meetingCode)) {
    logWS(`"end_class" RECHAZADO — hay una pregunta activa en la reunión "${meetingCode}".`);
    return;
  }

  // Si había una finalización automática en curso (el docente se cayó,
  // volvió y apretó "Detener Clase" antes de que venciera la gracia), ya no
  // corresponde: esta finalización es MANUAL y queda registrada como tal.
  // Sin cancelar, el timer viejo dispararía después sobre una clase ya
  // cerrada — inofensivo, porque `finalizarPorDesconexionDelDocente`
  // revalida `state.active`, pero deja un log confuso.
  cancelarFinalizacionPendiente(meetingCode, 'el docente finalizó la clase a mano');

  await classService.endClassManual(meetingCode);
  attentionState.stopSnapshots(meetingCode);

  console.log(`[Sparkle][WS] Clase finalizada MANUALMENTE para la reunión "${meetingCode}".`);
  broadcast(meetingCode, { type: 'class_ended', meetingCode });
  sendToTeachers(meetingCode, { type: 'class_resumable', meetingCode });
  await sessionService.closeAllOpenSessions(meetingCode);
}

// Etapa 50 — se dispara cuando el ÚLTIMO socket con rol "teacher" de esta
// sala se desconecta (cualquier motivo: colgó, F5, cerró la pestaña, perdió
// la red) mientras la clase estaba activa. Mismo efecto que
// `handleEndClass`, pero con `type = 'automatic'`. No se exporta —
// solo la llama `handleClose()` de acá abajo, para el socket del docente.
//
// Nota — esto SOLO finaliza el estado pedagógico de "clase" (preguntas,
// atención). El bot de Vexa YA NO se para acá: puede haber alumnos
// todavía conectados (el docente se cayó pero la reunión sigue con gente),
// y la transcripción tiene que seguir corriendo para ellos. El bot recién
// sale cuando la sala completa queda vacía — ver el chequeo en
// `handleClose()` más abajo.
async function finalizarPorDesconexionDelDocente(meetingCode) {
  if (isTeacherConnected(meetingCode)) return; // otra conexión del docente sigue en pie, no finalizar

  const state = await classService.getClassState(meetingCode);
  if (!state || !state.active) return; // no había clase activa, nada que finalizar

  await classService.endClassAutomatic(meetingCode);
  attentionState.stopSnapshots(meetingCode);

  logWS(`Clase finalizada AUTOMÁTICAMENTE por desconexión del docente — meetingCode="${meetingCode}".`);
  broadcast(meetingCode, { type: 'class_ended', meetingCode });
  await sessionService.closeAllOpenSessions(meetingCode);
}

// Programa la finalización para dentro de `GRACIA_DESCONEXION_DOCENTE_MS`
// en vez de hacerla ya. Ver el comentario de esa constante para el porqué.
//
// Los dos chequeos que hacía la versión inmediata se repiten DENTRO del
// timer y no acá: entre que se programa y que dispara pasa minuto y medio,
// y en ese rato el docente puede haber vuelto (`isTeacherConnected`) o la
// clase puede haberse finalizado por otro camino (`state.active`). Mirar
// el estado al programar no diría nada sobre el estado al ejecutar.
function programarFinalizacionAutomatica(meetingCode) {
  // Si ya había uno pendiente (el docente se cayó, volvió y se volvió a
  // caer dentro de la misma ventana), se reemplaza: lo que vale es la
  // última desconexión, no la primera.
  cancelarFinalizacionPendiente(meetingCode, 'llegó una desconexión más nueva');

  logWS(
    `Docente desconectado de "${meetingCode}" — la clase se finalizará en ` +
      `${Math.round(GRACIA_DESCONEXION_DOCENTE_MS / 1000)} s si no vuelve.`
  );

  const timer = setTimeout(() => {
    finalizacionesPendientes.delete(meetingCode);
    finalizarPorDesconexionDelDocente(meetingCode).catch((err) =>
      console.error('[Sparkle][WS] Falló la finalización automática diferida:', err)
    );
  }, GRACIA_DESCONEXION_DOCENTE_MS);

  // Un timer pendiente no tiene que mantener vivo el proceso: sin esto, un
  // `node --test` que termina sus casos se queda colgado hasta que venza
  // el último período de gracia. `unref` existe en Node y no en el timer
  // del navegador, de ahí el chequeo.
  if (typeof timer.unref === 'function') timer.unref();

  finalizacionesPendientes.set(meetingCode, timer);
}

async function handleTeacherDisconnection(meetingCode) {
  if (isTeacherConnected(meetingCode)) return; // otra conexión del docente sigue en pie, no finalizar

  const state = await classService.getClassState(meetingCode);
  if (!state || !state.active) return; // no había clase activa, nada que programar

  programarFinalizacionAutomatica(meetingCode);
}

// Etapa 50 — el docente elige "Reanudar" en el prompt.
//
// Etapa 61 — mismo chequeo adicional que `handleStartClass()`: reanudar
// también "arranca" la clase, así que también revalida
// `otherTeacherExists()` antes de reactivarla.
async function handleResumeClass(socket, meetingCode) {
  if (socket.role !== 'teacher') {
    console.warn(
      `[Sparkle][WS] Se ignoró "resume_class" de un socket sin rol "teacher" (role=${socket.role}) ` +
        `para la reunión ${meetingCode}.`
    );
    return;
  }

  if (await roleService.otherTeacherExists(meetingCode, socket.email)) {
    logWS(
      `"resume_class" RECHAZADO — la reunión "${meetingCode}" ya tiene un profesor permanente distinto ` +
        `(email=${socket.email}).`
    );
    send(socket, { type: 'join_rejected', meetingCode, reason: 'teacher_exists' });
    await roleService.clearTeacherRoleIfApplicable(meetingCode, socket.email);
    return;
  }

  // `classService.resumeClass` ya revalida `isResumable()` en este
  // mismo instante (no solo cuando se mandó el prompt) — si pasó el umbral
  // entre que se mostró y que el docente hizo click, o si por alguna
  // carrera la clase ya se finalizó en el medio, devuelve `false` sin
  // tocar la base.
  const resumed = await classService.resumeClass(meetingCode);
  if (!resumed) {
    console.warn(
      `[Sparkle][WS] Se ignoró "resume_class": ya no hay una finalización automática reciente para ` +
        `la reunión "${meetingCode}".`
    );
    return;
  }

  // Vexa — mismo criterio que `handleStartClass`: se vuelve a pedir el bot,
  // que es justo el momento en que alguien lo querría de vuelta si se cayó.
  // Ver el comentario largo de allá para el porqué.
  vexaService.startPolling(meetingCode);
  vexaService.startBot(meetingCode).catch((err) => console.error('[Vexa] startBot on resume_class failed:', err));

  console.log(`[Sparkle][WS] Clase REANUDADA para la reunión "${meetingCode}".`);
  broadcast(meetingCode, { type: 'class_resumed', meetingCode });
  // Etapa 68, Cambio 3 — mismo criterio que `handleStartClass`: los
  // alumnos que ya estaban conectados esperando empiezan su sesión ahora.
  await openSessionsForConnectedStudents(meetingCode);
}

// El docente elige un modo de clase en el selector de la pantalla pre-clase
// (Por Defecto/Teórica/Práctica/Seminario/Repaso, ver
// `constants/attentionModes.js`) — persiste el id y le manda el preset
// COMPLETO (X/Y/K/Q/C del alumno + P/V_doc/Q_doc/C_doc del docente) a TODA
// la sala, no solo a los alumnos: el propio docente también recibe su
// eco (`broadcast`, no `sendToStudents`) porque su panel de ajuste rápido
// también tiene que reflejar/bloquear el modo vigente (pedido explícito).
//
// Solo el docente puede cambiarlo — mismo chequeo de rol que el resto de
// los comandos de esta sala. Se ignora (sin romper nada) si la clase YA
// está activa: la pantalla pre-clase donde vive el selector desaparece en
// cuanto la clase arranca (ver `screens/TeacherPanel.jsx`), así que en el
// camino normal esto nunca debería llegar con la clase en curso — este
// chequeo es la barrera AUTORITATIVA del lado del servidor, no confía en
// que el frontend de verdad haya ocultado el selector (mismo criterio que
// `handleStartClass` con el documento cargado).
async function handleSetAttentionMode(socket, meetingCode, payload) {
  if (socket.role !== 'teacher') {
    console.warn(
      `[Sparkle][WS] Se ignoró "set_attention_mode" de un socket sin rol "teacher" (role=${socket.role}) ` +
        `para la reunión ${meetingCode}.`
    );
    return;
  }

  if (!isValidAttentionMode(payload?.modeId)) {
    console.warn(
      `[Sparkle][WS] "set_attention_mode" con modeId inválido (${payload?.modeId}) para la reunión "${meetingCode}", se ignora.`
    );
    return;
  }

  const state = await classService.getClassState(meetingCode);
  if (state?.active) {
    console.warn(
      `[Sparkle][WS] Se ignoró "set_attention_mode" — la reunión "${meetingCode}" ya tiene la clase en curso.`
    );
    return;
  }

  const modeId = Number(payload.modeId);
  await classService.setAttentionMode(meetingCode, modeId);

  logWS(`Modo de atención cambiado a ${modeId} para la reunión "${meetingCode}".`);
  broadcast(meetingCode, {
    type: 'attention_mode_updated',
    meetingCode,
    ...resolveAttentionMode(modeId),
  });
}

// Desconexión — se dispara tanto para un cierre "prolijo" (el alumno cierra
// la pestaña) como para una desconexión ABRUPTA detectada por el heartbeat
// (`socket.terminate()` también dispara 'close'). En ambos casos hay que
// sacar al socket de la sala y, según el rol: si era un alumno, avisarle a
// la sala que la lista cambió; si era el docente (y no queda ningún otro
// socket "teacher" en la sala), finalizar la clase automáticamente —
// mismo mecanismo que ya se usaba para el alumno, reutilizado acá para el
// docente.
//
// `code`/`reason` (Etapa 56, diagnóstico): 1000 ("Normal Closure") es un
// cierre prolijo iniciado por alguna de las dos puntas; 1006 ("Abnormal
// Closure") es lo que deja un `terminate()` del heartbeat (Etapa 55) O una
// conexión que se cortó sola por la red.
async function handleClose(socket, code, reasonBuffer) {
  // Este socket ya fue reemplazado por un re-join del mismo docente sobre
  // OTRO socket físico (F5, wifi que cae y reconecta rápido — ver el
  // bloque de "reemplazo" en `handleJoin()`, que setea este flag). Ya se
  // sacó de la sala en ESE momento; este "close" es solo el eco tardío de
  // la conexión física vieja terminando de cerrarse del lado del navegador,
  // no representa que la reunión haya perdido un participante real. Se
  // retorna ACÁ, antes de tocar `rooms`/Vexa — de lo contrario, si este
  // "close" tardío cae justo en la ventana async de `handleJoin()` (entre
  // sacar al socket viejo y agregar al nuevo, hay un `await
  // roleService.otherTeacherExists(...)` de por medio) y no quedaba nadie
  // más en la sala, `rooms.has(meetingCode)` podría dar `false` por un
  // instante y pararía el bot de Vexa aunque el docente esté en pleno
  // proceso de volver a entrar, no de irse.
  if (socket.sparkleReplaced) {
    logWS(
      `Conexión física CERRADA (socket ya reemplazado por un re-join del mismo docente — ver handleJoin) — ` +
        `meetingCode="${socket.meetingCode || '(sin join)'}" role=${socket.role || '(ninguno)'} ` +
        `email=${socket.email || '(ninguno)'} code=${code} reason="${reasonBuffer?.toString() || ''}"`
    );
    return;
  }

  logWS(
    `Conexión física CERRADA — meetingCode="${socket.meetingCode || '(sin join)'}" ` +
      `role=${socket.role || '(ninguno)'} email=${socket.email || '(ninguno)'} ` +
      `code=${code} reason="${reasonBuffer?.toString() || ''}"`
  );
  if (!socket.meetingCode) return;
  const { meetingCode, role, email } = socket;
  removeFromRoom(meetingCode, socket);

  // Vexa — el bot sale de la reunión en cuanto la sala WS de Sparkle queda
  // COMPLETAMENTE vacía (ni docente ni alumnos), sin importar el rol de
  // quien se acaba de desconectar ni el estado de "clase" (activa/pausada/
  // nunca arrancada) — `removeFromRoom` borra la entrada del Map cuando su
  // Set llega a tamaño 0 (ver `ws/rooms.js`), así que `rooms.has(...)` en
  // `false` es exactamente "no queda nadie conectado a esta reunión".
  // Deliberadamente separado del `try` de abajo (que sí distingue por rol):
  // esto tiene que evaluarse siempre, incluso si algo más adelante lanza.
  if (!rooms.has(meetingCode)) {
    programarSalidaDelBot(meetingCode);
  }

  try {
    if (role === 'student') {
      broadcastStudentList(meetingCode);
      // Etapa 68, Cambio 3 — no-op si este alumno no tenía ninguna sesión
      // abierta (ej. se desconecta antes de que el docente arrancara la
      // clase).
      await sessionService.closeSession(meetingCode, email);

      // Monitoreo de atención — red de seguridad ante una desconexión
      // ABRUPTA (cierre de pestaña, pérdida de red, heartbeat vencido) sin
      // que el alumno haya llegado a mandar "attention_stopped" antes: sin
      // esto, su última concentración quedaba "congelada" en el roster del
      // docente para siempre, mostrando a alguien que ya no está ahí.
      // `socket.attentionAnonId` solo existe si este socket llegó a mandar
      // al menos un "attention_snapshot" (ver `handleAttentionSnapshot`);
      // si nunca prendió la cámara, no hay nada que limpiar.
      if (socket.attentionAnonId) {
        attentionState.removeState(meetingCode, socket.attentionAnonId);
        sendToTeachers(meetingCode, {
          type: 'attention_roster_updated',
          meetingCode,
          students: attentionState.getSnapshot(meetingCode),
        });
      }
    } else if (role === 'teacher') {
      await handleTeacherDisconnection(meetingCode);
    }
  } catch (err) {
    console.error(`[Sparkle][WS] Error manejando el cierre de un socket "${role}":`, err.message);
  }
}

// ─── Preguntas en tiempo real (estilo Kahoot) ───
//
// Mismo patrón que el resto de este archivo: cada handler valida el ROL del
// socket (nunca lo que declare el propio mensaje) y delega la regla de
// negocio en `services/questionService.js` — acá solo vive la plomería de
// sala (a quién broadcastear qué) y la traducción de la pregunta/las
// estadísticas a la forma que viaja por la red.

// Nunca incluye `correct_option`: mientras la pregunta está activa, la
// opción correcta no sale del servidor hacia NINGÚN cliente (ni siquiera el
// docente la necesita recibir por acá — ya la vio al armar/revisar la
// pregunta antes de enviarla, ver `GenerateQuestion.jsx`). `serverTime` es
// la marca de reloj del servidor en el momento de armar ESTE mensaje —
// junto con `startedAt`/`expiresAt` (también reloj de servidor), el cliente
// puede calcular el tiempo restante corrigiendo el desvío de su propio
// reloj, sin depender de un `setInterval` local como fuente de verdad.
function toPublicQuestion(question) {
  return {
    id: question.id,
    prompt: question.prompt,
    options: [question.option_a, question.option_b, question.option_c, question.option_d],
    durationSeconds: question.duration_seconds,
    startedAt: new Date(question.started_at).getTime(),
    expiresAt: new Date(question.expires_at).getTime(),
    serverTime: Date.now(),
  };
}

function msUntil(date) {
  return Math.max(0, new Date(date).getTime() - Date.now());
}

// Estadísticas agregadas para el panel del docente — nunca quién respondió
// qué (la distribución por opción de acá abajo es un AGREGADO — "tantos
// eligieron la B" — no un listado de personas). `connectedStudents` sale
// del estado EN MEMORIA de la sala (ver `ws/rooms.js`, igual que
// "students_updated"); `totalStudents` es el padrón completo registrado en
// la clase (ver `participationRepository.countStudentsForMeeting`) — son
// fuentes distintas a propósito (uno es "ahora mismo", el otro es "alguna
// vez se inscribió").
//
// `correctOptionIndex` SÍ viaja acá, a diferencia de `toPublicQuestion` —
// las tres llamadas a esta función (`sendQuestionStateCatchUp` rama
// "teacher", `handleSendQuestion`, `broadcastQuestionStats`) mandan su
// resultado EXCLUSIVAMENTE a sockets con rol "teacher" (`sendToTeachers` o
// el `send()` directo del catch-up del propio docente) — el docente ya vio
// la opción correcta al armar/revisar la pregunta, así que no hay nada que
// proteger acá.
async function buildQuestionStats(meetingCode, question) {
  const totalStudents = await questionService.countStudents(meetingCode);
  const connectedCount = getConnectedStudents(meetingCode).length;
  const { answeredCount, skippedCount } = await questionService.getAnswerCounts(question.id);
  const optionCountsByLetter = await questionService.getOptionCounts(question.id);
  const optionCounts = OPTION_LETTERS.map((letter) => optionCountsByLetter[letter] || 0);
  const pendingCount = Math.max(connectedCount - answeredCount - skippedCount, 0);
  const participationBase = connectedCount || totalStudents;
  const participationPercent =
    participationBase > 0 ? Math.round(((answeredCount + skippedCount) / participationBase) * 100) : 0;

  return {
    questionId: question.id,
    totalStudents,
    connectedStudents: connectedCount,
    answeredCount,
    skippedCount,
    pendingCount,
    participationPercent,
    optionCounts,
    correctOptionIndex: OPTION_LETTERS.indexOf(question.correct_option),
  };
}

// Catch-up de "¿hay una pregunta activa ahora mismo?" — se llama desde
// `handleJoin` para CUALQUIER rol, tanto en el primer join como en una
// reconexión. Un alumno recibe la pregunta (sin la opción correcta) más su
// propia respuesta si ya había contestado antes de perder la conexión; un
// docente recibe la pregunta más las estadísticas en vivo — así su panel
// también se recompone solo tras un F5, sin perder de vista la pregunta en
// curso.
async function sendQuestionStateCatchUp(socket, meetingCode) {
  const question = await questionService.getActiveQuestion(meetingCode);
  if (!question) {
    send(socket, { type: 'question_state', meetingCode, active: false });
    return;
  }

  const publicQuestion = toPublicQuestion(question);

  if (socket.role === 'teacher') {
    const stats = await buildQuestionStats(meetingCode, question);
    send(socket, { type: 'question_state', meetingCode, active: true, question: publicQuestion, stats });
  } else if (socket.role === 'student') {
    const myAnswer = await questionService.getAnswerState(question.id, socket.email);
    send(socket, { type: 'question_state', meetingCode, active: true, question: publicQuestion, myAnswer });
  }
}

// El docente presiona "Enviar pregunta". Antes de guardar/emitir nada se
// revalida (igual que `handleStartClass`) que este socket es de verdad el
// docente PERMANENTE de esta reunión — cubre el mismo caso borde que ahí:
// el `meetingCode` de este mensaje puntual podría no coincidir con el que
// tiene guardado `socket.meetingCode` si algo quedó desincronizado, así que
// se revalida contra la base con el `email` del socket (nunca con nada que
// mande el cliente en este mensaje).
async function handleSendQuestion(socket, meetingCode, payload) {
  if (socket.role !== 'teacher') {
    console.warn(`[Sparkle][WS] Se ignoró "send_question" de un socket sin rol "teacher" para la reunión ${meetingCode}.`);
    return;
  }

  if (await roleService.otherTeacherExists(meetingCode, socket.email)) {
    logWS(`"send_question" RECHAZADO — "${meetingCode}" ya tiene un profesor permanente distinto (email=${socket.email}).`);
    send(socket, {
      type: 'question_send_rejected',
      meetingCode,
      reason: 'not_authorized',
      message: 'No estás autorizado para enviar preguntas en esta clase.',
    });
    return;
  }

  try {
    const question = await questionService.createAndStartQuestion(meetingCode, {
      prompt: payload?.prompt,
      options: payload?.options,
      correctOptionIndex: payload?.correctOptionIndex,
      durationSeconds: payload?.durationSeconds,
    });

    questionTimers.schedule(question.id, msUntil(question.expires_at), () => autoFinishQuestion(meetingCode, question.id));

    const publicQuestion = toPublicQuestion(question);
    // Únicamente a los ALUMNOS de esta clase (Etapa: "emitirla por
    // WebSocket únicamente a los alumnos conectados a esa clase") — el
    // docente que la envió se entera por "question_stats_updated" de acá
    // abajo, que ya incluye la pregunta completa.
    sendToStudents(meetingCode, { type: 'question_started', meetingCode, question: publicQuestion });

    const stats = await buildQuestionStats(meetingCode, question);
    sendToTeachers(meetingCode, { type: 'question_stats_updated', meetingCode, question: publicQuestion, stats });

    console.log(`[Sparkle][WS] Pregunta ${question.id} enviada a la reunión "${meetingCode}".`);
  } catch (err) {
    logWS(`"send_question" rechazado para "${meetingCode}": ${err.message}`);
    send(socket, {
      type: 'question_send_rejected',
      meetingCode,
      reason: err.reason || (err.status === 409 ? 'active_question_exists' : 'invalid_question'),
      message: err.message,
    });
  }
}

// Finaliza una pregunta y avisa — la usan tanto el timer automático de
// vencimiento (`ws/questionTimers.js`) como `handleFinishQuestion` (el
// docente corta la pregunta a mano). `questionService.finishQuestion`
// devuelve `false` si esta pregunta YA estaba finalizada (una carrera entre
// ambos caminos) — en ese caso no se vuelve a broadcastear nada, evitando
// un "question_finished" duplicado.
async function autoFinishQuestion(meetingCode, questionId) {
  const changed = await questionService.finishQuestion(questionId);
  if (!changed) return;

  const question = await questionService.getQuestionById(questionId);
  const correctOptionIndex = question ? OPTION_LETTERS.indexOf(question.correct_option) : -1;

  // La opción correcta SÍ viaja acá — la pregunta ya terminó para todos,
  // así que revelarla ahora no permite hacer trampa (ver DOCUMENTACION del
  // feature: "puede enviarse después de finalizar"). La usa el historial de
  // "preguntas respondidas" del panel del alumno.
  broadcast(meetingCode, { type: 'question_finished', meetingCode, questionId, correctOptionIndex });
}

// El docente corta la pregunta antes de que venza. Se revalida rol +
// identidad igual que `handleSendQuestion`, y además que el `questionId`
// que manda el cliente sea de verdad la pregunta ACTIVA de esta reunión
// (nunca se finaliza una pregunta de otra clase, aunque alguien mande un id
// ajeno a mano).
async function handleFinishQuestion(socket, meetingCode, payload) {
  if (socket.role !== 'teacher') {
    console.warn(`[Sparkle][WS] Se ignoró "finish_question" de un socket sin rol "teacher" para la reunión ${meetingCode}.`);
    return;
  }
  if (await roleService.otherTeacherExists(meetingCode, socket.email)) return;

  const question = await questionService.getActiveQuestion(meetingCode);
  if (!question || question.id !== payload?.questionId) return;

  questionTimers.clear(question.id);
  await autoFinishQuestion(meetingCode, question.id);
}

// Recalcula y reenvía las estadísticas al docente tras cada respuesta/salto
// — `questionService.getActiveQuestion` ya revalida vencimiento, así que si
// la pregunta venció justo en el medio, esto simplemente no manda nada (no
// hay pregunta activa para armar estadísticas de una que ya cerró; el
// "question_finished" del timer se encarga de esa notificación).
async function broadcastQuestionStats(meetingCode, questionId) {
  const question = await questionService.getQuestionById(questionId);
  if (!question || question.status !== 'active') return;
  const publicQuestion = toPublicQuestion(question);
  const stats = await buildQuestionStats(meetingCode, question);
  sendToTeachers(meetingCode, { type: 'question_stats_updated', meetingCode, question: publicQuestion, stats });
}

// Un alumno responde. Toda la validación real (¿es alumno de esta clase?,
// ¿la pregunta sigue activa?, ¿ya había respondido?) vive en
// `questionService.submitAnswer` — acá solo se traduce el resultado a
// "answer_accepted"/"answer_rejected" y se le avisa al docente del cambio
// en las estadísticas.
async function handleAnswerQuestion(socket, meetingCode, payload) {
  if (socket.role !== 'student') {
    console.warn(`[Sparkle][WS] Se ignoró "answer_question" de un socket sin rol "student" para la reunión ${meetingCode}.`);
    return;
  }

  const questionId = payload?.questionId;
  try {
    const result = await questionService.submitAnswer(meetingCode, socket.email, questionId, payload?.selectedOptionIndex);
    // `correctOptionIndex` SÍ viaja acá — a diferencia de "question_started"/
    // "question_stats_updated" (broadcast a toda la sala, nunca la
    // incluyen), este mensaje es UNICAST al socket que acaba de mandar SU
    // PROPIA respuesta, ya persistida e inmutable (el índice único de
    // `question_answers` impide una segunda) — revelársela acá permite que
    // el panel del alumno muestre la tarjeta final (correcta/incorrecta +
    // respuesta correcta) desde el primer momento, sin estado intermedio.
    send(socket, {
      type: 'answer_accepted',
      meetingCode,
      questionId: result.questionId,
      isCorrect: result.isCorrect,
      skipped: false,
      correctOptionIndex: result.correctOptionIndex,
    });
    await broadcastQuestionStats(meetingCode, result.questionId);
  } catch (err) {
    send(socket, { type: 'answer_rejected', meetingCode, questionId, reason: err.message });
  }
}

// "Prefiero no responder", ya confirmado del lado del cliente (ver
// `StudentPanel.jsx` — el diálogo de confirmación es puramente de UI, acá
// solo llega la decisión ya tomada).
async function handleSkipQuestion(socket, meetingCode, payload) {
  if (socket.role !== 'student') {
    console.warn(`[Sparkle][WS] Se ignoró "skip_question" de un socket sin rol "student" para la reunión ${meetingCode}.`);
    return;
  }

  const questionId = payload?.questionId;
  try {
    const result = await questionService.skipAnswer(meetingCode, socket.email, questionId);
    // Mismo criterio que en `handleAnswerQuestion` — unicast, después de
    // que la decisión de saltear ya quedó grabada sin vuelta atrás.
    send(socket, {
      type: 'answer_accepted',
      meetingCode,
      questionId: result.questionId,
      isCorrect: null,
      skipped: true,
      correctOptionIndex: result.correctOptionIndex,
    });
    await broadcastQuestionStats(meetingCode, result.questionId);
  } catch (err) {
    send(socket, { type: 'answer_rejected', meetingCode, questionId, reason: err.message });
  }
}

// ─── Monitoreo de atención en vivo (panel del docente) ───
//
// La detección de atención en sí sigue corriendo 100% en el dispositivo del
// alumno (ver `hooks/useAttentionDetection.js` del frontend); lo único que
// cruza hacia acá es un snapshot periódico (tipo/concentración/desatento/
// fracción sin rostro/timestamp/nombre) identificado por un `anonId`
// generado del lado del CLIENTE (`crypto.randomUUID()`, ver
// `hooks/useAttentionBroadcast.js`).
//
// Corrección — pedido explícito posterior: ahora SÍ viaja `name` (el
// mismo que el alumno eligió al registrarse) — antes este handler
// deliberadamente lo excluía para que el docente nunca pudiera identificar
// la fila. `anonId` sigue siendo la clave interna del roster (no cumple más
// una función de anonimato, solo identidad estable entre snapshots del
// mismo alumno). Mismo patrón de validación que el resto del archivo: se
// revalida `socket.role` (nunca lo que declare el mensaje), y `name` se
// sanea (recortado, tope de longitud) antes de guardarse — nunca se confía
// en un string arbitrario del cliente.
//
// Corrección — pedido explícito posterior: antes este handler descartaba
// TODO snapshot sin `concentration` numérica, así que una ventana
// `no_face` (el alumno se movió fuera de cuadro, poca luz, etc. — ver
// `offscreen/detector.js#predict`) nunca llegaba al docente: ni el roster
// en vivo (`ConcentrationStats.jsx`) ni su log de debug
// (`TeacherDebugLog.jsx`) se enteraban. Ahora se distingue por `type`: solo
// una `'prediction'` sin `concentration` válida se descarta (dato corrupto);
// una `'no_face'` se acepta igual, sin esas dos salidas (el modelo nunca
// las calculó para esa ventana) pero CON `noFaceFraction` — mismo
// contrato que ya expone `AttentionDebugLog.jsx` del lado del alumno.
function handleAttentionSnapshot(socket, meetingCode, payload) {
  if (socket.role !== 'student') {
    console.warn(`[Sparkle][WS] Se ignoró "attention_snapshot" de un socket sin rol "student" para la reunión ${meetingCode}.`);
    return;
  }

  const anonId = typeof payload?.anonId === 'string' && payload.anonId.trim() ? payload.anonId.trim() : null;
  if (!anonId) return;

  // `payload.kind`, NO `payload.type` — el campo viaja como `kind` a
  // propósito desde `useAttentionBroadcast.js`: el mensaje WS real que
  // arma `wsClient.js#sendStudentCommand` es `{ type: 'attention_snapshot',
  // meetingCode, ...snapshot }`, así que si el snapshot tuviera su propio
  // campo `type` (como `tipo` en español antes del renombrado a inglés, sin
  // colisión), el spread lo pisaría con `'prediction'`/`'no_face'` — este
  // handler nunca vería `attention_snapshot` de vuelta en `message.type`
  // (`ws/index.js` la descartaría en silencio, sin matchear ningún branch).
  // La variable local se sigue llamando `type` acá abajo (y así queda
  // guardada en `attentionState`/expuesta en el roster) — es solo el
  // nombre del campo DE ENTRADA el que tiene que ser distinto del `type`
  // del sobre WS.
  const type = payload?.kind === 'no_face' ? 'no_face' : 'prediction';

  // `concentration` solo existe para una predicción real — una
  // `'prediction'` sin `concentration` numérica es un mensaje corrupto (se
  // descarta), mientras que `'no_face'` nunca la tuvo y no es un error.
  //
  // `inattentive` SIEMPRE termina siendo un booleano, nunca `null` — regla
  // global "sin rostro = desatento": para `'no_face'` se fuerza acá a
  // `true` (nunca se lee del payload del cliente para este caso — mismo
  // criterio de no confiar en el cliente que el resto de este archivo,
  // aunque `useAttentionBroadcast.js` ya lo mande así) para que el
  // resto de la cadena (roster del docente, `TeacherDebugLog.jsx`) nunca
  // tenga que tratar `no_face` como un tercer estado "N/A".
  let concentration = null;
  let inattentive;
  if (type === 'prediction') {
    concentration = Number(payload?.concentration);
    if (!Number.isFinite(concentration)) return;
    inattentive = Boolean(payload?.inattentive);
  } else {
    inattentive = true;
  }

  const rawNoFaceFraction = Number(payload?.noFaceFraction);
  const noFaceFraction = Number.isFinite(rawNoFaceFraction) ? rawNoFaceFraction : null;

  const ts = Number(payload?.ts) || Date.now();
  const name = typeof payload?.name === 'string' && payload.name.trim()
    ? payload.name.trim().slice(0, 100)
    : null;

  // Recordado en el socket (no solo en `attentionState`) para poder limpiar
  // su entrada si esta conexión se cae sin mandar "attention_stopped" antes
  // — ver `handleClose` más arriba.
  socket.attentionAnonId = anonId;

  attentionState.updateState(meetingCode, anonId, {
    type, concentration, inattentive, noFaceFraction, ts, name,
  });
  sendToTeachers(meetingCode, {
    type: 'attention_roster_updated',
    meetingCode,
    students: attentionState.getSnapshot(meetingCode),
  });
}

// El alumno apagó la cámara (switch, pausa de clase, salida de la llamada
// — cualquier motivo que ponga `cameraActive` en `false` del lado del
// frontend, ver `hooks/useAttentionBroadcast.js`) — se saca del roster en
// vez de dejarlo con un valor último "congelado" para siempre.
function handleAttentionStopped(socket, meetingCode, payload) {
  if (socket.role !== 'student') return;

  const anonId = typeof payload?.anonId === 'string' && payload.anonId.trim() ? payload.anonId.trim() : socket.attentionAnonId;
  if (!anonId) return;

  socket.attentionAnonId = null;
  attentionState.removeState(meetingCode, anonId);
  sendToTeachers(meetingCode, {
    type: 'attention_roster_updated',
    meetingCode,
    students: attentionState.getSnapshot(meetingCode),
  });
}

module.exports = {
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
};
