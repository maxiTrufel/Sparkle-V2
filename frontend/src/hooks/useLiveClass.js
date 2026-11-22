import { useEffect, useRef, useState } from 'react';
import { joinRoom, keepRoomAlive, leaveRoom } from '../services/backendMessaging';

// Etapa 53 — margen corto que se espera, tras recibir "class_status" con
// `active: false`, antes de asentarse en "no hay nada para reanudar". El
// servidor manda "class_status" y (si corresponde) "class_resumable" como
// parte de la MISMA respuesta a un "join" (ver `handleJoin` en
// `backend/src/ws/index.js`), uno atrás del otro sin ningún `await` en el
// medio — pero como cada uno viaja como un mensaje de `chrome.runtime`
// independiente (background → pestaña), pueden llegar en ticks separados.
// Sin este margen, la vista de "Comenzar Clase" se resuelve apenas llega
// "class_status" y se pisa un instante después si "class_resumable" llega
// justo a continuación — exactamente el parpadeo reportado. 500ms es de
// sobra para ese salto (son mensajes locales, sin round-trip de red de por
// medio) sin sumar una demora perceptible al caso común (nada para
// reanudar).
const RESOLVING_VIEW_GRACE_MS = 500;
// Tope de seguridad (Etapa 53): si por lo que sea nunca llega NINGUNA
// respuesta al "join" (backend caído, red cortada de verdad) el spinner no
// se queda colgado para siempre — se asienta en la vista normal, mismo
// criterio que usa `useInitialRoleResolution` para su propia resolución.
const RESOLVING_VIEW_MAX_MS = 6000;

// Toda la plomería en vivo de la sala WebSocket de esta reunión: unirse/
// salir según `callStage`, el keepalive periódico, la salida de emergencia
// al recargar/cerrar la pestaña, y el procesamiento de los eventos que
// llegan del servidor. Los cuatro efectos de acá comparten refs y estado
// entre sí (por eso viven juntos en un solo hook, no separados) — solo le
// interesan a `App.jsx` cuando ya se conoce `meetingCode` + `role`.
export function useLiveClass({ meetingCode, role, email, callStage }) {
  // Estado de la clase (Etapa 44), en sincronía con `meetings.active` en el
  // backend — nunca se pone en `false` desde el frontend: solo se prende,
  // vía "class_status" (al unirse, si ya estaba activa) o "class_started"
  // (evento en vivo, ver el listener más abajo).
  const [classStarted, setClassStarted] = useState(false);
  // Listado real de alumnos conectados a la sala (Etapa 46) — lo arma y
  // mantiene el backend (`obtenerAlumnosConectados()`, `backend/src/ws`);
  // acá solo se refleja el último snapshot que llegó por WS.
  const [connectedStudents, setConnectedStudents] = useState([]);
  // Aviso de "clase detenida" (`ui/ClassPausedCard.jsx`) que ve el alumno
  // en el PANEL — Ajuste post-entrega: antes iba acompañado de un alert()
  // nativo (Etapa 46), eliminado a favor de dejar que la propia interfaz
  // refleje el estado, sin ningún diálogo bloqueante. Etapa 60 — a propósito
  // ya NO se apaga solo con un timer: queda fijo hasta que ocurra un evento
  // REAL (el docente vuelve a iniciar o reanudar la clase la apaga
  // explícitamente más abajo; `classStarted` además tiene prioridad de
  // render sobre esto en `StudentPanel.jsx`).
  const [endNotice, setEndNotice] = useState(false);
  // Prompt de "¿Reanudar la clase anterior?" (Etapa 50) — solo el docente lo
  // ve (el servidor solo manda "class_resumable" a sockets con rol
  // "profesor", ver backend/src/ws), cuando su clase se cortó por una
  // desconexión (no un "Detener Clase" a propósito) hace poco tiempo.
  const [classResumable, setClassResumable] = useState(false);
  // Etapa 51: el servidor rechazó el "join" de este socket como "profesor"
  // porque otra persona ya está conectada con ese rol en esta reunión (solo
  // puede haber un docente conectado por vez, ver `backend/src/ws/index.js`).
  const [joinRejected, setJoinRejected] = useState(false);
  // Etapa 52 — si la conexión FÍSICA del background a esta sala está arriba
  // AHORA MISMO (evento local "SPARKLE_WS_CONNECTION" que manda el
  // background en el 'open'/'close' de su socket, ver
  // `services/wsClient.js` — no es algo que reenvíe el servidor). Solo
  // `TeacherPanel.jsx` lo usa, para deshabilitar sus botones mientras no
  // esté confirmada la conexión.
  const [wsConnected, setWsConnected] = useState(false);
  // Etapa 53 — `true` mientras el docente todavía no sabe si, al unirse a
  // esta sala, corresponde mostrar la vista normal ("Comenzar Clase") o el
  // prompt de "Reanudar clase" (`classResumable`). Mientras esto sea
  // `true`, `App.jsx` muestra un spinner en vez de `TeacherPanel`. Arranca
  // en `true` a propósito (no en `false`): así cubre también el render
  // intermedio entre que `role` ya es `'teacher'` y que el efecto de unión
  // de acá abajo llega a correr — sin eso, se cuela un parpadeo de
  // "Comenzar Clase" antes de asentarse en la vista real (ver
  // DOCUMENTACION.md, Etapa 53, para el diagnóstico completo).
  const [resolvingTeacherView, setResolvingTeacherView] = useState(true);
  // Error del último intento de "Comenzar Clase" rechazado por el servidor
  // ("class_start_rejected", ver `backend/src/ws/handlers.js`,
  // `handleStartClass`) — hoy el único motivo es "falta cargar el material
  // de la clase" (`reason: 'missing_document'`). `TeacherPanel.jsx` ya
  // deshabilita el botón sin un documento cargado (chequeo del lado del
  // cliente, vía `useDocumentUpload`); esto es la red de seguridad para
  // cualquier otro camino (un mensaje WS a mano, o una carrera donde el
  // documento se borró justo entre que se habilitó el botón y el click).
  const [startClassError, setStartClassError] = useState(null);
  // Reporte PDF de fin de clase — botón "Descargar reporte" (docente,
  // `TeacherPanel.jsx`). Puramente en memoria de esta conexión: se prende
  // con el evento en vivo "class_ended" y se apaga con "class_started"/
  // "class_resumed" — un F5/reapertura del panel lo resetea a `false` (no
  // se deriva de "class_status"/"class_resumable", que sí sobreviven una
  // reconexión). A propósito no distingue "clase que YA se puede
  // reportar" de "clase que corresponde reanudar": el docente decide ver
  // eso él mismo con el propio botón.
  const [reportAvailable, setReportAvailable] = useState(false);
  // Señal de "clase NUEVA de cero" (`hooks/useAttentionHistory.js`) — mismo
  // patrón que `newQuestionSignal`/`requestGenerateQuestionSignal` en el
  // resto de la app: un contador que SOLO avanza ante un "class_started"
  // real (nunca en el render inicial, nunca en "class_resumed"). Es lo que
  // le permite a `useAttentionHistory` distinguir "el docente arrancó una
  // clase genuinamente nueva" (ahí sí corresponde limpiar el historial de
  // atención acumulado) de "se reanudó la misma clase" o "se recargó la
  // página a mitad de una clase en curso" (ninguno de los dos pasa por acá
  // — un F5 resuelve el estado vía "class_status" en el join, nunca vía
  // "class_started" — así que el historial sobrevive intacto en ambos
  // casos).
  const [classStartedSignal, setClassStartedSignal] = useState(0);
  // Ref, no estado: el handler de "pagehide" (Etapa 48, ver más abajo) solo
  // necesita LEER el valor más reciente en el instante en que el navegador
  // empieza a destruir la página — no necesita disparar ningún re-render.
  const joinedRoomRef = useRef(false);
  // Timers del mecanismo de `resolvingTeacherView` (Etapa 53):
  // `resolvingViewGraceRef` es el margen corto tras un "class_status" con
  // `active: false`; `resolvingViewMaxRef` es el tope de seguridad de todo
  // el join. Viven en refs (no en el cleanup normal de un solo efecto)
  // porque hace falta poder cancelarlos desde los dos efectos de abajo: el
  // que inicia el join y el que escucha los eventos WS.
  const resolvingViewGraceRef = useRef(null);
  const resolvingViewMaxRef = useRef(null);

  // Red de seguridad para `resolvingTeacherView`, INDEPENDIENTE del efecto
  // de unión a la sala de más abajo (que solo llega a correr si
  // `callStage === 'en-llamada'`). Cubre el caso límite en que el rol se
  // resuelve como docente pero la llamada nunca llega a ponerse
  // genuinamente `'en-llamada'` — sin esto, el spinner de "resolviendo
  // vista" quedaría prendido para siempre. Se dispara una sola vez por cada
  // vez que `role` pasa a ser `'teacher'` (no se re-arma con cada
  // reconexión — eso ya lo cubre el propio efecto de unión, con su propio
  // timer, mientras SÍ llega a correr).
  useEffect(() => {
    if (role !== 'teacher') return;
    const timeoutId = setTimeout(() => setResolvingTeacherView(false), RESOLVING_VIEW_MAX_MS);
    return () => clearTimeout(timeoutId);
  }, [role]);

  // Une la sala WS de esta reunión apenas se conocen meetingCode + rol, Y
  // ADEMÁS el estado de contexto real sea genuinamente 'en-llamada' (Etapa
  // 47) — el WebSocket en sí vive en el background (`services/wsClient.js`);
  // acá solo se le avisa cuándo empezar y cuándo cortar. `role` es
  // 'teacher'/'student' (nomenclatura de este hook, ya alineada 1:1 con la
  // del backend desde la Etapa 4). Si
  // `callStage` no es genuinamente 'en-llamada' ('lobby', 'salida', o
  // 'indeterminado' como fallback ambiguo), no se une — evita que alguien
  // en el lobby o la pantalla de salida aparezca como "conectado" en el
  // listado del docente (Etapa 46/47).
  useEffect(() => {
    if (!meetingCode || !role || callStage !== 'in-call') return;

    // Arranca (o reinicia) el spinner de "resolviendo vista" cada vez que
    // este efecto vuelve a unirse a la sala (montaje inicial, o una
    // reconexión real), no en la re-unión periódica de más abajo (esa es un
    // catch-up silencioso, no debería parpadear la UI cada 15s).
    if (role === 'teacher') {
      setResolvingTeacherView(true);
      clearTimeout(resolvingViewGraceRef.current);
      clearTimeout(resolvingViewMaxRef.current);
      resolvingViewMaxRef.current = setTimeout(() => setResolvingTeacherView(false), RESOLVING_VIEW_MAX_MS);
    }

    joinRoom(meetingCode, role, email).catch((err) => {
      console.log(`[Sparkle] Error uniéndose a la sala WS: ${err.message}`);
    });
    joinedRoomRef.current = true;

    // Etapa 52, ampliado en la Etapa 57 — keepalive periódico para AMBOS
    // roles. Un service worker de Manifest V3 se suspende tras ~30s SIN
    // NINGÚN evento de la extensión — un WebSocket abierto pero en silencio
    // no cuenta por sí solo como esa actividad. Cada mensaje de
    // `chrome.runtime` que recibe el service worker (sea cual sea) resetea
    // ese timer de inactividad, así que este tick cumple dos roles a la
    // vez: mantiene despierto al service worker MIENTRAS la pestaña siga en
    // la llamada, y de paso verifica/repara la conexión física si hace
    // falta (ver `keepRoomAlive()` en `services/wsClient.js`). Usa
    // `keepRoomAlive` (más liviana que `joinRoom`) en vez de un "join"
    // completo en cada tick — si mandara un "join" completo cada 15s,
    // multiplicado por potencialmente decenas de alumnos en una clase
    // grande, dispararía igual cantidad de broadcasts de
    // `students_updated` a toda la sala sin necesidad. 15s: bastante
    // más seguido que los ~30s de inactividad que tolera un service worker,
    // con margen para el jitter normal de `setInterval` y el throttling que
    // Chrome puede aplicarle a una pestaña en segundo plano (ver
    // DOCUMENTACION.md, Etapa 57, sobre `chrome.alarms` como red de
    // seguridad independiente de este timer).
    const intervalId = setInterval(() => {
      keepRoomAlive(meetingCode, role, email).catch(() => {
        // Fire-and-forget, igual que el intento inicial de arriba: si
        // falla, el próximo tick de este mismo intervalo lo vuelve a
        // intentar solo.
      });
    }, 15000);

    return () => {
      joinedRoomRef.current = false;
      clearInterval(intervalId);
      clearTimeout(resolvingViewGraceRef.current);
      clearTimeout(resolvingViewMaxRef.current);
      leaveRoom(meetingCode).catch((err) => {
        console.log(`[Sparkle] Error saliendo de la sala WS: ${err.message}`);
      });
    };
  }, [meetingCode, role, email, callStage]);

  // Etapa 48 — bug de F5: la conexión física WS vive en el SERVICE WORKER de
  // background, no en esta pestaña. Un F5 destruye de un golpe el realm de
  // JS de la página (sin darle tiempo a React de correr el cleanup del
  // efecto de arriba) — pero el background nunca se entera, porque no es
  // parte de lo que se destruye. El fix: un listener de `pagehide` (se
  // dispara al recargar, navegar fuera o cerrar la pestaña — a diferencia
  // de `beforeunload`, no bloquea el bfcache y es el reemplazo recomendado
  // para este caso) que manda `leaveRoom` a mano ANTES de que el reload
  // termine de destruir la página. No hace falta esperar la respuesta (ni
  // podría: para cuando llegara, este realm de JS ya puede no existir) —
  // alcanza con que el mensaje quede encolado hacia el service worker, un
  // contexto SEPARADO que no se destruye junto con esta pestaña.
  // `joinedRoomRef` evita mandar un "salir" de una sala a la que nunca se
  // llegó a unir (ej. F5 estando en el lobby).
  useEffect(() => {
    const notifyLeaveIfNeeded = () => {
      if (joinedRoomRef.current && meetingCode) {
        leaveRoom(meetingCode).catch(() => {
          // Fire-and-forget: la pestaña puede estar a mitad de destruirse,
          // no hay nada útil que hacer con un error acá.
        });
      }
    };

    window.addEventListener('pagehide', notifyLeaveIfNeeded);
    return () => window.removeEventListener('pagehide', notifyLeaveIfNeeded);
  }, [meetingCode]);

  // Eventos push que reenvía el background cuando llegan por WS (Etapa 44).
  // La distinción entre "ya estaba activa al unirme" y "se activó/finalizó
  // en vivo mientras miraba el panel" la marca el TIPO de evento, no un
  // chequeo de estado acá: "class_status" es la respuesta al join;
  // "class_started"/"class_ended" son broadcasts que el servidor solo emite
  // cuando el docente aprieta el botón correspondiente con la sala ya
  // abierta. El broadcast llega a TODOS los sockets de la sala, incluido el
  // del propio docente que apretó el botón. Ajuste post-entrega: ya no
  // dispara ningún alert() nativo en ninguno de estos casos — la propia
  // interfaz (badge de estado, `ui/ClassPausedCard.jsx`) ya refleja cada
  // transición, así que un diálogo bloqueante aparte era redundante.
  useEffect(() => {
    const listener = (message) => {
      // Etapa 52 — no es un evento reenviado del servidor (no viaja envuelto
      // en "SPARKLE_WS_EVENT"): es el aviso LOCAL del background sobre el
      // estado de la conexión física de esta sala puntual, ver
      // `notifyConnection()` en `services/wsClient.js`.
      if (message?.type === 'SPARKLE_WS_CONNECTION') {
        if (message.meetingCode === meetingCode) setWsConnected(Boolean(message.connected));
        return;
      }

      if (message?.type !== 'SPARKLE_WS_EVENT') return;
      const event = message.payload || {};
      if (event.meetingCode !== meetingCode) return;

      // Resuelve (apaga) el spinner de "resolviendo vista" del docente:
      // cancela el margen de gracia y el tope de seguridad. Se llama desde
      // cada rama de abajo que ya sabe con certeza qué vista corresponde.
      const resolveTeacherView = () => {
        clearTimeout(resolvingViewGraceRef.current);
        clearTimeout(resolvingViewMaxRef.current);
        setResolvingTeacherView(false);
      };

      if (event.type === 'class_status') {
        // Llega como respuesta directa a un "join" ACEPTADO — si este
        // socket había quedado marcado como rechazado por un intento
        // anterior, un "class_status" nuevo confirma que ahora sí se unió
        // de verdad (Etapa 51).
        setJoinRejected(false);
        if (event.active) {
          setClassStarted(true);
          setClassResumable(false);
          // Caso definitivo: hay clase activa, no hace falta esperar un
          // posible "class_resumable" (el servidor nunca lo manda si la
          // clase ya está activa — ver `isResumable()`).
          resolveTeacherView();
        } else {
          // El servidor dice que NO hay clase activa, y eso es autoritativo:
          // hay que bajar la bandera, no solo resolver la vista.
          //
          // ANTES ESTA RAMA NO LA BAJABA, y el efecto era visible: si el
          // docente se desconecta con la clase activa, el backend la finaliza
          // automáticamente ("Clase finalizada AUTOMÁTICAMENTE por
          // desconexión del docente") y le manda `class_ended` a la sala —
          // pero el docente NO lo recibe, porque justamente estaba
          // desconectado. Al reconectar, su único aviso es este
          // `class_status` con `active: false`, que se ignoraba: el panel
          // seguía mostrando "Clase en curso" mientras el alumno ya veía
          // "La clase está detenida". Las dos pantallas en desacuerdo, y la
          // que tenía razón era la del alumno.
          //
          // En el primer join de una reunión sin clase esto es un no-op
          // (`classStarted` ya viene en `false`).
          setClassStarted(false);
          // Todavía no se sabe si viene un "class_resumable" a
          // continuación (mismo "join") — se da ese margen antes de
          // asentarse en "no hay nada para reanudar".
          clearTimeout(resolvingViewGraceRef.current);
          resolvingViewGraceRef.current = setTimeout(resolveTeacherView, RESOLVING_VIEW_GRACE_MS);
        }
      } else if (event.type === 'join_rejected') {
        // Etapa 51: el servidor no dejó unirse a este socket como
        // "profesor" porque ya hay otra persona conectada con ese rol en
        // esta reunión — solo puede haber un docente a la vez.
        if (event.reason === 'teacher_exists') setJoinRejected(true);
        resolveTeacherView();
      } else if (event.type === 'class_started') {
        setClassStarted(true);
        setClassResumable(false);
        // Apaga cualquier aviso de detención que hubiera quedado fijo de
        // una clase anterior (Etapa 60).
        setEndNotice(false);
        setStartClassError(null);
        // El reporte era de la clase que acaba de terminar — una clase
        // NUEVA no tiene reporte propio todavía (ver
        // `classReportCache.invalidate`, del lado del backend, mismo
        // motivo).
        setReportAvailable(false);
        setClassStartedSignal((n) => n + 1);
        resolveTeacherView();
      } else if (event.type === 'class_start_rejected') {
        // Ver el comentario de `startClassError` más arriba — hoy el único
        // motivo real es "falta cargar el material de la clase".
        setStartClassError(event.message || 'No se pudo comenzar la clase.');
      } else if (event.type === 'class_ended') {
        setClassStarted(false);
        if (role === 'student') setEndNotice(true);
        // Reporte PDF de fin de clase — solo tiene sentido para el
        // docente (`TeacherPanel.jsx` es el único que renderiza el botón),
        // pero no hace falta condicionar el estado acá: un alumno nunca ve
        // el botón, sin importar este valor.
        setReportAvailable(true);
      } else if (event.type === 'class_resumable') {
        // Etapa 50: solo le llega al docente — dispara el prompt de
        // "¿Reanudar la clase anterior?" en `TeacherPanel.jsx`.
        setClassResumable(true);
        resolveTeacherView();
      } else if (event.type === 'class_resumed') {
        setClassStarted(true);
        setClassResumable(false);
        setEndNotice(false);
        // Misma clase, pero reanudada — sigue acumulando preguntas/
        // respuestas hasta que se vuelva a finalizar, así que el reporte
        // de la finalización anterior ya no corresponde (mismo criterio
        // que "class_started" arriba).
        setReportAvailable(false);
        resolveTeacherView();
      } else if (event.type === 'students_updated') {
        setConnectedStudents(event.students || []);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [meetingCode, role]);

  return {
    classStarted,
    connectedStudents,
    endNotice,
    classResumable,
    joinRejected,
    setJoinRejected,
    wsConnected,
    resolvingTeacherView,
    startClassError,
    clearStartClassError: () => setStartClassError(null),
    reportAvailable,
    classStartedSignal,
  };
}
