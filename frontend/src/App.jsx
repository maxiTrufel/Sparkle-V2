import { useEffect, useRef, useState } from 'react';
import Header from './ui/Header';
import Welcome from './screens/Welcome';
import ConfirmTeacher from './screens/ConfirmTeacher';
import StudentName from './screens/StudentName';
import TeacherPanel from './screens/TeacherPanel';
import StudentPanel from './screens/StudentPanel';
import LobbyScreen from './screens/LobbyScreen';
import CallEndedScreen from './screens/CallEndedScreen';
import ToggleTab from './ui/ToggleTab';
import { CameraPreviewBox } from './ui/CameraPreviewBox';
import NewQuestionToast from './ui/NewQuestionToast';
import ClassResumeNotice from './ui/ClassResumeNotice';
import AnswerResultPopup from './ui/AnswerResultPopup';
import { FatigueAlert } from './ui/FatigueAlert';
import { GroupAttentionAlert } from './ui/GroupAttentionAlert';
import { NotificationStack } from './ui/NotificationStack';
import { CameraPositionNotice } from './ui/CameraPositionNotice';
import { getCameraNoticeShown, setCameraNoticeShown } from './utils/cameraNoticeStorage';
import { useCameraPreference } from './hooks/useCameraPreference';
import { useAttentionDetection } from './hooks/useAttentionDetection';
import { useFatigueAlert } from './hooks/useFatigueAlert';
import { useGroupAttentionAlert } from './hooks/useGroupAttentionAlert';
import { useAttentionBroadcast } from './hooks/useAttentionBroadcast';
import { useLiveAttention } from './hooks/useLiveAttention';
import { useAttentionHistory } from './hooks/useAttentionHistory';
import { useAttentionModeSync } from './hooks/useAttentionModeSync';
import { useCallStage } from './hooks/useCallStage';
import { useInitialRoleResolution, HAS_TEACHER_QUERY_TIMEOUT_MS } from './hooks/useInitialRoleResolution';
import { useLiveClass } from './hooks/useLiveClass';
import { useLiveQuestions } from './hooks/useLiveQuestions';
import { withTimeout } from './utils/withTimeout';
import { getHasTeacher, configureAttentionDetection, setAttentionMode } from './services/backendMessaging';
import { DEFAULT_ATTENTION_MODE } from './constants/attentionModes';
import { getMeetingCode } from './utils/meetContext';

// Router raíz de la app: decide qué pantalla mostrar dentro del panel según
// el estado de la llamada (`useCallStage`), el rol resuelto para esta
// reunión (`useInitialRoleResolution`) y las transiciones de pantalla que
// controla directamente (confirmación de docente, registro de nombre de
// alumno). La plomería del WebSocket en vivo vive en `useLiveClass` — este
// componente solo consume lo que ese hook expone, no conoce los detalles de
// unión a la sala, keepalive ni el listener de eventos.
export default function App() {
  // Etapa 68, Cambio 1 — `true` mientras se muestra la pantalla de registro
  // de nombre (`screens/StudentName.jsx`), entre "eligió/reintentó ser
  // alumno" y "confirmó un nombre válido y único". Mientras esto sea `true`,
  // `role` sigue en `null` a propósito: NINGÚN rol queda asignado para esta
  // reunión hasta que `handleNameConfirmed` corre — ni siquiera se une a la
  // sala WS (`useLiveClass` depende de `role`, no de esto), así que tampoco
  // aparece todavía en el listado de conectados del docente.
  const [showingNameRegistration, setShowingNameRegistration] = useState(false);
  // Etapa 69, Cambio 1 — mismo criterio que `showingNameRegistration`, para
  // el lado del docente: `true` mientras se muestra
  // `screens/ConfirmTeacher.jsx`, entre "eligió Soy Docente" y "confirmó
  // que sí lo es". `role` sigue en `null` mientras tanto — el rol de
  // docente recién se registra dentro de `ConfirmTeacher.jsx`, al
  // confirmar.
  const [showingConfirmTeacher, setShowingConfirmTeacher] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  // Este componente solo existe dentro de una llamada activa: quien decide
  // montarlo o desmontarlo es content/main.jsx, según la URL (Etapa 17). Por
  // eso el meeting code se calcula una sola vez al montar en vez de seguir
  // observando cambios de contexto acá adentro — si el usuario deja la
  // llamada, este árbol entero se desmonta.
  const [meetingCode] = useState(() => getMeetingCode());

  const callStage = useCallStage(meetingCode);
  const { email, role, setRole, name, setName, hasTeacher, setHasTeacher, isBooting, ensureEmail } =
    useInitialRoleResolution({
      meetingCode,
      callStage,
    });
  const {
    classStarted,
    connectedStudents,
    endNotice,
    classResumable,
    joinRejected,
    setJoinRejected,
    wsConnected,
    resolvingTeacherView,
    startClassError,
    clearStartClassError,
    reportAvailable,
    classStartedSignal,
  } = useLiveClass({ meetingCode, role, email, callStage });
  const {
    activeQuestion,
    questionStats,
    myAnswerState,
    finishedQuestion,
    clearFinishedQuestion,
    questionSendError,
    clearQuestionSendError,
    answerError,
    clearAnswerError,
    newQuestionSignal,
    answerResultSignal,
    lastAnswerCorrect,
  } = useLiveQuestions({ meetingCode, role, email });

  // Monitoreo de atención en vivo (panel del docente) — hook APARTE, mismo
  // criterio que `useLiveQuestions` (no se mezcla en `useLiveClass`). Solo
  // le llega algo real al docente (ver `hooks/useLiveAttention.js`); para
  // el alumno, `attentionRoster` queda vacío para siempre — inofensivo.
  const { attentionRoster } = useLiveAttention({ meetingCode, role });

  // Modo de clase (Por Defecto/Teórica/Práctica/Seminario/Repaso) — hook
  // APARTE, mismo criterio que `useLiveAttention` de arriba. Le llega a
  // AMBOS roles (a diferencia de `useLiveAttention`, que solo le llega al
  // docente) — ver `hooks/useAttentionModeSync.js`. Se aplica más abajo,
  // junto con `attentionConfig`/`groupAlertConfig` (necesita que
  // `sendAttentionConfig` ya esté declarada).
  const attentionMode = useAttentionModeSync({ meetingCode });

  // El docente elige un modo en el selector de la pantalla pre-clase
  // (`ui/AttentionModeSelector.jsx`, montado dentro de `TeacherPanel`) — el
  // pedido viaja al backend, que persiste + hace `broadcast()` a TODA la
  // sala (el propio docente incluido) con el preset resuelto; el efecto que
  // aplica `attentionMode` (más abajo, junto a `attentionConfig`) hace el
  // trabajo real, nunca acá — no hay estado optimista local que pueda
  // desincronizarse del que el backend confirma.
  //
  // Bug real (auditoría del crash al clickear "Soy Docente") — esta
  // declaración vivía más abajo, después de `attentionConfig`/
  // `sendAttentionConfig`, pero `screen = <TeacherPanel
  // onAttentionModeChange={handleAttentionModeChange} .../>` se evalúa
  // ANTES que eso (apenas se conoce `role === 'teacher'`) — un `const`
  // referenciado antes de su propia línea de declaración es un
  // `ReferenceError` de temporal dead zone, no un valor `undefined`. Ese
  // error, sin ningún Error Boundary en el árbol, tira abajo TODO el
  // componente `App` — lo que se veía como "el plugin desaparece de la
  // página" era exactamente eso. Como el desmontaje corre el cleanup de
  // TODOS los efectos activos, incluido el de `useLiveClass.js` que llama
  // `leaveRoom()` en su cleanup, la conexión WS se cerraba (`.close()` sin
  // argumentos, de ahí el code=1005) como consecuencia del mismo crash, no
  // por un problema aparte del WebSocket. Se mueve acá arriba, junto a
  // `attentionMode` (de quien no depende funcionalmente, solo comparte
  // tema), para que ya exista para cuando `screen` se arma más abajo.
  const handleAttentionModeChange = (modeId) => {
    setAttentionMode(meetingCode, email, modeId).catch((err) => {
      console.log(`[Sparkle] Error cambiando el modo de atención: ${err.message}`);
    });
  };

  // Alerta grupal de atención (docente) — HERRAMIENTA DE PRUEBA, mismo
  // criterio que el panel X/Y/K/Q/C del alumno. P/`windowSecondsTeacher`/
  // `qThresholdTeacher`/C_doc son lógica pura de este cliente (nunca cruzan a
  // ningún lado, ni offscreen ni backend — se calculan enteramente sobre
  // `attentionRoster`, que ya recibe este docente). Ver
  // `ui/TeacherAttentionSettingsPanel.jsx` para el panel que los edita y
  // `hooks/useGroupAttentionAlert.js` para la lógica completa.
  //
  // Pedido explícito posterior — reemplazo de `N_doc` (racha de snapshots
  // grupales SEGUIDOS) por una ventana deslizante TEMPORAL:
  // `windowSecondsTeacher` (cuántos segundos de historial grupal se
  // analizan) + `qThresholdTeacher` (qué porcentaje de esos segundos tuvo que
  // ser "grupo desatento" para alertar) — ver `useGroupAttentionAlert.js`
  // para el cambio de diseño completo. A diferencia del reemplazo de `N` por
  // `K`/`Q` del lado del alumno (que además agregó recuperación
  // automática), acá `P` y `C_doc` siguen haciendo exactamente lo mismo
  // que antes, y la alerta SIGUE sin recuperación automática — solo el
  // mecanismo de disparo cambió de racha a ventana temporal.
  // Defaults — mismos valores que el preset del modo "Por Defecto"
  // (`backend/src/constants/attentionModes.js`), para cubrir la ventana
  // brevísima antes de que llegue el primer `attention_mode_updated` por
  // WebSocket (mismo criterio que `lastConfiguration` en
  // `background/attentionOffscreen.js`). P=45% (auditoría de 2026-08-11
  // contra la Tabla 2 de la tesis — P es la fracción ATENTA mínima, antes
  // representaba la fracción desatenta mínima), V_doc=120s, Q_doc=70%,
  // C_doc=120s.
  const [groupAlertConfig, setGroupAlertConfig] = useState({
    pThreshold: 0.45, windowSecondsTeacher: 120, qThresholdTeacher: 0.7, cooldownSecondsTeacher: 120,
  });

  // Historial de atención grupal (panel del docente, `ConcentrationStats.jsx`)
  // — hook APARTE, mismo criterio que `useLiveAttention` de arriba. Montado
  // ACÁ (no dentro de `ConcentrationStats.jsx`) — Corrección (pedido
  // explícito): así sobrevive a que el docente entre y salga de esa
  // pantalla (o detenga/reanude la clase) sin perder lo acumulado. Ver
  // `hooks/useAttentionHistory.js` para el ciclo de vida completo
  // (congela en "class_ended", sigue acumulando en "class_resumed", solo
  // se limpia con `classStartedSignal`, sobrevive un F5 vía
  // `chrome.storage.local`).
  const attentionHistory = useAttentionHistory({
    meetingCode, email, roster: attentionRoster, pThreshold: groupAlertConfig.pThreshold, classStartedSignal,
  });

  const groupAlert = useGroupAttentionAlert(attentionRoster, {
    pThreshold: groupAlertConfig.pThreshold,
    windowSecondsTeacher: groupAlertConfig.windowSecondsTeacher,
    qThresholdTeacher: groupAlertConfig.qThresholdTeacher,
    cooldownSeconds: groupAlertConfig.cooldownSecondsTeacher,
    classStarted,
    connected: wsConnected,
    hasActiveQuestion: Boolean(activeQuestion),
  });

  // Señal para "Lanzar pregunta" desde la alerta grupal — mismo criterio que
  // `newQuestionSignal` en `hooks/useLiveQuestions.js` (contador que SOLO
  // avanza ante una acción real, nunca en el render inicial): `TeacherPanel`
  // lo escucha para abrir la pantalla "Generar pregunta" sola, respetando
  // las mismas reglas que ya tiene ese botón (nunca si hay una pregunta
  // activa o la clase no está en curso — ver `generateQuestionDisabled` ahí).
  const [requestGenerateQuestionSignal, setRequestGenerateQuestionSignal] = useState(0);

  // Señal para "Recuperar contenido" (alumno, alerta de fatiga) — mismo
  // patrón que la de arriba, declarada acá (no junto al handler, más abajo
  // en este archivo) porque `StudentPanel` se monta ANTES que ese handler
  // en el cuerpo de esta función — ver `handleRecoverLostContent`
  // más abajo para el resto del criterio.
  const [requestRecoverySummarySignal, setRequestRecoverySummarySignal] = useState(0);

  const handleLaunchQuestionFromGroupAlert = () => {
    groupAlert.closeAlert();
    setIsOpen(true);
    setRequestGenerateQuestionSignal((s) => s + 1);
  };

  // Notificación flotante de "nueva pregunta en vivo" (fuera del panel, ver
  // el punto de montaje más abajo) — puramente de UI, no toca en nada la
  // lógica de preguntas en sí (`useLiveQuestions` ya resuelve todo eso).
  // Se muestra apenas `newQuestionSignal` avanza (una pregunta REAL recién
  // enviada por el docente, nunca el catch-up de una reconexión — ver el
  // comentario en `hooks/useLiveQuestions.js`) y solo para el alumno — Y
  // solo si el panel lateral está CERRADO en ese momento: con el panel ya
  // abierto, el alumno ya está viendo la interfaz de Sparkle (el modal de
  // la pregunta se abre solo, ver `StudentPanel.jsx`), así que la
  // notificación sería redundante. `isOpenRef` (en vez de meter `isOpen`
  // en las dependencias del efecto de abajo) es lo que evita que ABRIR o
  // CERRAR el panel por sí solo dispare este efecto de nuevo — sigue
  // atado únicamente a que llegue una señal de pregunta nueva de verdad,
  // leyendo el `isOpen` VIGENTE en ese instante exacto.
  const [questionToastVisible, setQuestionToastVisible] = useState(false);
  const questionToastTimeoutRef = useRef(null);
  const isOpenRef = useRef(isOpen);
  const QUESTION_TOAST_AUTO_HIDE_MS = 8000;

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (role !== 'student' || !newQuestionSignal || isOpenRef.current) return undefined;
    setQuestionToastVisible(true);
    clearTimeout(questionToastTimeoutRef.current);
    questionToastTimeoutRef.current = setTimeout(() => {
      setQuestionToastVisible(false);
    }, QUESTION_TOAST_AUTO_HIDE_MS);
    return () => clearTimeout(questionToastTimeoutRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newQuestionSignal, role]);

  // Misma fuente de verdad que ya usa `StudentPanel.jsx` para desmontar el
  // modal — si la pregunta deja de estar activa (venció el tiempo, el
  // docente la cerró) o este alumno ya respondió/saltó, la notificación no
  // tiene más sentido y se oculta de una, sin esperar el auto-hide.
  useEffect(() => {
    if (!activeQuestion || myAnswerState?.answered || myAnswerState?.skipped) {
      setQuestionToastVisible(false);
      clearTimeout(questionToastTimeoutRef.current);
    }
  }, [activeQuestion, myAnswerState]);

  // Si el alumno abre el panel manualmente (ToggleTab) mientras el toast
  // sigue visible, ya no tiene sentido dejarlo flotando: la pregunta pasa a
  // verse directamente en el panel.
  useEffect(() => {
    if (isOpen) {
      setQuestionToastVisible(false);
      clearTimeout(questionToastTimeoutRef.current);
    }
  }, [isOpen]);

  const handleRespondToQuestionNow = () => {
    setQuestionToastVisible(false);
    clearTimeout(questionToastTimeoutRef.current);
    setIsOpen(true);
  };

  const handleCloseQuestionToast = () => {
    setQuestionToastVisible(false);
    clearTimeout(questionToastTimeoutRef.current);
  };

  // Etapa 69, Cambio 1 — "docente" YA NO asigna `role` acá directo: pasa a
  // mostrar `ConfirmTeacher.jsx`, que es quien de verdad registra el rol
  // (al confirmar) y recién ahí llama a `handleTeacherConfirmed`. "alumno"
  // sigue igual que la Etapa 68 (Cambio 1): pasa a mostrar la pantalla de
  // registro de nombre, sin asignar `role` todavía.
  //
  // Etapa 71, Capa 2 (defensiva) — "docente" ahora hace un chequeo FRESCO
  // (no reutiliza el `hasTeacher` del boot, que puede haber quedado
  // desactualizado) justo antes de decidir qué mostrar: cubre la carrera en
  // que Welcome cargó sin ningún docente todavía, pero otra persona se
  // registró como docente en el ratito entre que cargó y que se hizo este
  // click. Si el chequeo confirma el conflicto, se salta el diálogo de
  // confirmación por completo — directo a `role: 'teacher'`, dejando que el
  // efecto de unión a la sala WS (`useLiveClass`) intente el join real y
  // sea rechazado por el mismo camino ya probado desde la Etapa 51
  // (`join_rejected` → `joinRejected`), en vez de reimplementar esa lógica
  // acá. Si el chequeo falla (red, timeout), se sigue el camino normal
  // (mostrar el diálogo) — la verificación FINAL y autoritativa sigue
  // siendo el WS al unirse, así que un fallo acá nunca deja a nadie con un
  // rol mal asignado, en el peor caso solo le muestra un diálogo de más.
  const handleSelectRole = async (selected) => {
    if (selected === 'student') {
      setShowingNameRegistration(true);
      return;
    }

    let hasTeacherNow = false;
    if (meetingCode && email) {
      try {
        const teacherStatus = await withTimeout(
          getHasTeacher(meetingCode, email),
          HAS_TEACHER_QUERY_TIMEOUT_MS,
          'Timeout consultando si ya hay un docente.'
        );
        hasTeacherNow = Boolean(teacherStatus?.hasTeacher);
      } catch (err) {
        console.log(`[Sparkle] Error en el chequeo fresco de "¿ya hay un docente?": ${err.message}`);
      }
    }

    if (hasTeacherNow) {
      setHasTeacher(true); // mantiene a Welcome consistente si se vuelve
      setRole('teacher'); // el WS-join existente detecta el conflicto y
      // dispara el mismo camino de rechazo de siempre (Etapa 51/61) — sin
      // mostrar el diálogo de confirmación.
      return;
    }

    setShowingConfirmTeacher(true);
  };

  // Le da una salida real a quien fue rechazado como "profesor" por ya haber
  // otro docente conectado (Fix 3): en vez de dejarlo trabado en la pantalla
  // de rechazo, lo manda a la misma pantalla de registro de nombre que "Soy
  // Alumno" en Welcome (Etapa 68) — ya no registra el rol acá directo, esa
  // responsabilidad es enteramente de `StudentName.jsx` ahora, sin importar
  // desde dónde se llegó a elegir "alumno".
  const handleJoinAsStudent = () => {
    setJoinRejected(false);
    setShowingNameRegistration(true);
  };

  // Se llama desde `StudentName.jsx` una vez que el backend confirmó el
  // registro (rol "alumno" + nombre, atómico — ver
  // `backend/src/routes/meetings.js`). Recién ACÁ `role` pasa a ser
  // "student" de verdad — `useLiveClass` reacciona solo al cambio y manda
  // el "join" con rol "alumno".
  const handleNameConfirmed = (confirmedName) => {
    setShowingNameRegistration(false);
    setName(confirmedName);
    setRole('student');
  };

  // Etapa 69, Cambio 2 — "Volver" desde `StudentName.jsx`: como el rol de
  // alumno recién se persiste al confirmar (arriba), no hay nada que
  // liberar en la base — solo se cierra la pantalla intermedia.
  //
  // Etapa 76 — bug real: cuando se llega a esta pantalla vía "Unirme como
  // alumno" desde la pantalla de rechazo (`TeacherPanel.jsx`), `role` ya
  // quedaba en 'teacher' desde el chequeo fresco de `handleSelectRole`
  // (Capa 2) — nunca se reseteaba acá. "Volver" cerraba la pantalla de
  // nombre pero dejaba `role === 'teacher'` intacto, así que la app volvía
  // a mostrar el panel del docente (con "Comenzar Clase"/"Cargar Archivo")
  // en vez de Welcome, como si esta persona SÍ fuera la docente — aunque la
  // reunión ya tuviera un docente confirmado distinto. Ahora se resetea
  // `role` a `null` explícitamente (no-op si se llegó acá desde "Soy
  // Alumno" en Welcome, donde `role` ya era `null`): vuelve a Welcome, que
  // con `hasTeacher` ya en `true` (seteado en el mismo chequeo de Capa 2)
  // muestra únicamente "Soy Alumno" — sin volver a ofrecer "Soy Docente".
  const handleBackFromName = () => {
    setShowingNameRegistration(false);
    setName(null);
    setRole(null);
  };

  // Etapa 69, Cambio 1 — se llama desde `ConfirmTeacher.jsx` una vez que
  // el backend confirmó el registro (best-effort). Recién ACÁ `role` pasa a
  // ser "teacher" de verdad.
  const handleTeacherConfirmed = () => {
    setShowingConfirmTeacher(false);
    setRole('teacher');
  };

  // "Volver" desde `ConfirmTeacher.jsx`: no se registró nada todavía (el
  // registro pasa DENTRO de esa pantalla, solo al confirmar) — alcanza con
  // cerrarla, sin tocar `role`.
  const handleCancelConfirmTeacher = () => {
    setShowingConfirmTeacher(false);
  };

  // Ajuste 2 (Etapa 70) — "Volver" desde la pantalla de rechazo
  // (`joinRejected`), alternativa neutra a "Unirme como alumno": vuelve a
  // Welcome sin elegir ningún rol. No hace falta liberar nada en la base —
  // un rol "profesor" rechazado nunca llega a persistirse (ver
  // `TeacherPanel.jsx`) — así que alcanza con resetear el estado local.
  // `hasTeacher` queda como estaba — Welcome sigue mostrando solo "Soy
  // Alumno" al volver, correctamente (Etapa 71).
  const handleBackFromRejection = () => {
    setJoinRejected(false);
    setRole(null);
  };

  const togglePanel = () => setIsOpen((prev) => !prev);
  const closePanel = () => setIsOpen(false);

  // Enrutamiento (Etapa 17 + Etapa 24): 'lobby' y 'salida' pisan el flujo
  // normal con una pantalla informativa fija, sin pedir rol ni mostrar
  // contenido de Docente/Alumno. 'en-llamada' y 'indeterminado' (señal
  // ambigua — fallback seguro) caen al flujo de siempre: sin rol para esta
  // reunión → Welcome, con rol → el panel correspondiente, sin ningún link
  // de "Cambiar de rol" (una vez elegido el rol para esta reunión puntual,
  // queda fijo).
  let screen;
  if (callStage === 'lobby') {
    screen = <LobbyScreen />;
  } else if (callStage === 'ended') {
    screen = <CallEndedScreen />;
  } else if (showingConfirmTeacher) {
    screen = (
      <ConfirmTeacher
        meetingCode={meetingCode}
        email={email}
        ensureEmail={ensureEmail}
        onConfirmed={handleTeacherConfirmed}
        onCancel={handleCancelConfirmTeacher}
      />
    );
  } else if (showingNameRegistration) {
    screen = (
      <StudentName
        meetingCode={meetingCode}
        email={email}
        ensureEmail={ensureEmail}
        onConfirmed={handleNameConfirmed}
        onBack={handleBackFromName}
      />
    );
  } else if (role === 'teacher' && resolvingTeacherView) {
    // Etapa 53 — mientras no se sepa todavía si corresponde la vista normal
    // o el prompt de "Reanudar clase", se muestra este spinner en vez de
    // dejar que `TeacherPanel` caiga a su vista por defecto ("Comenzar
    // Clase") y la pise un instante después. Se mantiene `Header` (no es el
    // mismo caso que `showBootLoader`, ahí ni siquiera se sabe el rol
    // todavía).
    screen = (
      <div className="sparkle-boot-loader">
        <span className="sparkle-spinner" aria-hidden="true" />
        <p className="sparkle-text">Cargando…</p>
      </div>
    );
  } else if (role === 'teacher') {
    screen = (
      <TeacherPanel
        meetingCode={meetingCode}
        email={email}
        classStarted={classStarted}
        connectedStudents={connectedStudents}
        classResumable={classResumable}
        joinRejected={joinRejected}
        wsConnected={wsConnected}
        onJoinAsStudent={handleJoinAsStudent}
        onBackFromRejection={handleBackFromRejection}
        activeQuestion={activeQuestion}
        questionStats={questionStats}
        finishedQuestion={finishedQuestion}
        clearFinishedQuestion={clearFinishedQuestion}
        questionSendError={questionSendError}
        clearQuestionSendError={clearQuestionSendError}
        startClassError={startClassError}
        clearStartClassError={clearStartClassError}
        reportAvailable={reportAvailable}
        attentionRoster={attentionRoster}
        attentionPThreshold={groupAlertConfig.pThreshold}
        attentionHistory={attentionHistory.history}
        attentionHistoryLoading={attentionHistory.loading}
        attentionWindowStartedAt={attentionHistory.windowStartedAt}
        requestGenerateQuestionSignal={requestGenerateQuestionSignal}
        attentionModeId={attentionMode?.id ?? DEFAULT_ATTENTION_MODE}
        onAttentionModeChange={handleAttentionModeChange}
      />
    );
  } else if (role === 'student') {
    screen = (
      <StudentPanel
        meetingCode={meetingCode}
        email={email}
        classStarted={classStarted}
        endNotice={endNotice}
        activeQuestion={activeQuestion}
        myAnswerState={myAnswerState}
        finishedQuestion={finishedQuestion}
        clearFinishedQuestion={clearFinishedQuestion}
        answerError={answerError}
        clearAnswerError={clearAnswerError}
        requestRecoverySummarySignal={requestRecoverySummarySignal}
      />
    );
  } else {
    screen = <Welcome onSelectRole={handleSelectRole} hasTeacher={hasTeacher} />;
  }

  // El spinner de boot (esperando email/rol) solo tiene sentido para el
  // flujo normal — en lobby/salida ya sabemos qué mostrar sin depender de
  // que esa resolución termine, así que no hace falta hacer esperar al
  // usuario para ver el mensaje correspondiente.
  const showBootLoader = isBooting && callStage !== 'lobby' && callStage !== 'ended';

  // Etapa 61 — el chip de rol del `Header` NO puede usar `role` tal cual:
  // esa variable es la que maneja el ENRUTAMIENTO (qué pantalla mostrar) y
  // se pone en 'teacher' apenas se elige el rol en Welcome o apenas se
  // resuelve el boot — MUCHO antes de que el WS confirme si esa persona
  // realmente puede ser profesor de esta reunión. Sin esta distinción,
  // alguien rechazado por "ya hay un profesor registrado" veía igual el
  // chip "Docente" en el header mientras la pantalla de rechazo estaba ahí
  // abajo — contradictorio. `confirmedRole` solo vale 'teacher' en el mismo
  // momento exacto en que se decide renderizar el `TeacherPanel` de verdad
  // (ni el spinner de `resolvingTeacherView` ni la pantalla de rechazo
  // cuentan) — para 'student' no hace falta ninguna condición extra porque
  // no existe un estado intermedio de "todavía no confirmado" en ese camino.
  const confirmedRole =
    role === 'teacher' && !resolvingTeacherView && !joinRejected
      ? 'teacher'
      : role === 'student'
        ? 'student'
        : null;

  // Etapa 64 — HERRAMIENTA DE PRUEBA (ver `hooks/useCameraPreference.js`),
  // llamada acá (no dentro de StudentPanel/Header) porque su recuadro de
  // preview tiene que renderizarse como HERMANO de `.sparkle-panel` (ver el
  // fragment de abajo) — `.sparkle-panel` anima con `transform`, y eso
  // convertiría a cualquier `position: fixed` DESCENDIENTE suyo en algo
  // posicionado relativo al panel en vez de a la ventana completa,
  // rompiendo el requisito de que el preview flote afuera del panel. El
  // switch (dentro de `Header`) sí puede vivir adentro del panel sin
  // problema — recibe el estado por props normales, como cualquier otro
  // dato de este componente. `inCall` (Etapa 65): sin esto, salir de la
  // llamada no apagaba el preview ni la cámara real, porque `classStarted`
  // nunca se resetea localmente y `<App/>` sigue montado (solo cambia de
  // pantalla dentro del mismo panel).
  const {
    enabled: cameraEnabled,
    error: cameraError,
    active: cameraActive,
    videoRef: cameraVideoRef,
    handleToggle: handleToggleCamera,
  } = useCameraPreference({
    active: role === 'student',
    meetingCode,
    email,
    classStarted,
    inCall: callStage === 'in-call',
  });

  // Detección de atención — se engancha a `cameraActive`, la MISMA condición
  // que enciende el preview (switch + clase activa + en llamada). No hay
  // ninguna vía por la que el modelo arranque sin que el alumno haya
  // habilitado la cámara a mano, y cualquier transición que apague ese switch
  // cierra el documento offscreen y suelta el stream, no solo deja de
  // predecir. Ver `hooks/useAttentionDetection.js`.
  const attention = useAttentionDetection({ active: cameraActive });

  // Panel de ajuste rápido X/Y/K/Q/C — HERRAMIENTA DE PRUEBA (ver
  // `ui/AttentionSettingsPanel.jsx`). `k`/`qThreshold`/`cooldownSeconds` son
  // lógica pura de este cliente (nunca cruzan hacia el offscreen);
  // `xSeconds`/`threshold` sí, vía `configureAttentionDetection` — ver
  // `handleAttentionConfigChange` más abajo.
  //
  // Defaults: X=2s (mismo default que `DEFAULT_PREDICTION_INTERVAL_MS`
  // en `offscreen/detector.js`), Y=0.5 (mismo default que `DEFAULT_THRESHOLD`
  // ahí — este Y es el ÚNICO que existe en el proyecto: el docente supo
  // tener una copia propia, pero se sacó por completo), K=90, Q=0.75, C=180s.
  //
  // Y bajó de 0,6 a 0,5 el 2026-08-01. NO es una preferencia: 0,5 es el punto
  // de operación en el que el modelo fue validado, y con 0,6 el sistema
  // marcaba como desatento al 70 % de los alumnos que sí estaban atendiendo
  // (señalaba desatención incluso cuando el propio modelo la creía MENOS
  // probable que la atención). Ver el comentario extenso de
  // `backend/src/constants/attentionModes.js`, que es la fuente de verdad.
  // K/Q reemplazan a la vieja `n` (racha de detecciones seguidas), ver
  // `hooks/useFatigueAlert.js` para el cambio de diseño completo (ventana
  // deslizante de las últimas `k` capturas, alerta si `qThreshold` o más de
  // esa ventana está desatenta). Estos cinco valores son, ahora, la
  // referencia contra la que se unificaron los defaults equivalentes del
  // docente (`groupAlertConfig` más abajo) — ver el comentario ahí para el
  // detalle de qué cambió de ese lado.
  //
  // Corrección (auditoría de fallbacks, 2026-08-11): K/Q/C estaban en 30/
  // 0.8/90s, un valor que no correspondía a NINGÚN preset real y que
  // encima violaba C=ventana (k·X=60s ≠ C=90s) — cubría solo la ventana
  // brevísima antes de que llegue el primer `attention_mode_updated` por
  // WS (ver `useAttentionModeSync.js`), pero mientras esa ventana dura, la
  // UI mostraba/usaba un modo inexistente. Ahora son EXACTAMENTE los
  // valores del preset "Por Defecto" (`ATTENTION_MODES[1].student` en
  // `backend/src/constants/attentionModes.js`). No se importa ese archivo
  // acá porque backend/frontend son paquetes npm separados sin build
  // compartido (backend es CommonJS/Node, frontend es un bundle de
  // extensión de Chrome vía Vite) — si el preset "Por Defecto" cambia en
  // attentionModes.js, estos cinco valores hay que actualizarlos a mano
  // ACÁ TAMBIÉN.
  const [attentionConfig, setAttentionConfig] = useState({
    xSeconds: 2, threshold: 0.5, k: 90, qThreshold: 0.75, cooldownSeconds: 180,
  });

  // Envía X/Y al detector y reconcilia el estado con lo que el detector
  // REALMENTE terminó aplicando — factorizado porque ahora hay DOS momentos
  // que necesitan mandar esto con la misma lógica: cuando el alumno mueve
  // un slider (`handleAttentionConfigChange`) y cuando arranca la detección
  // (efecto de `cameraActive`, más abajo — ver ese efecto para el porqué).
  //
  // Best-effort — mismo criterio que el resto de la persistencia liviana de
  // esta app (ej. `updateCameraEnabled` en `useCameraPreference.js`): si el
  // mensaje falla (documento offscreen no creado todavía, service worker
  // reiniciándose), no hay que bloquearse por eso — `attentionOffscreen.js`
  // guarda el valor igual y lo reaplica apenas exista el offscreen (ver
  // `configureDetection`).
  const sendAttentionConfig = (config) => {
    configureAttentionDetection({
      threshold: config.threshold,
      predictionIntervalMs: Math.round(config.xSeconds * 1000),
    }).then((response) => {
      // Reconciliación — Corrección (auditoría de Y): `config.threshold`/`xSeconds`
      // son lo que se PIDIÓ, no necesariamente lo que el detector terminó
      // aplicando — `detector.js#configure` rechaza en silencio un
      // `threshold` fuera de `(0, 1)` (ej. arrastrar el slider a un extremo
      // exacto, 0 o 1, ambos alcanzables con `min`/`max` del rango) y sigue
      // con el que ya tenía. Sin esto, el panel se quedaba mostrando un valor
      // que el modelo nunca llegó a usar. `response.configuration` solo
      // viene cuando el documento offscreen ya existía y respondió de verdad
      // (`appliedNow: true`); si no existe todavía, no hay nada que
      // reconciliar — la próxima vez que arranque reaplicará `config` tal cual.
      if (!response?.configuration) return;
      setAttentionConfig((prev) => ({
        ...prev,
        threshold: response.configuration.threshold,
        xSeconds: response.configuration.predictionIntervalMs / 1000,
      }));
    }).catch((err) => {
      console.log(`[Sparkle] Error configurando la detección de atención: ${err.message}`);
    });
  };

  // Modo de clase — aplica los 9 valores del preset apenas llega uno nuevo
  // (`attentionMode`, declarado arriba junto a `useLiveAttention`): el
  // docente lo eligió en la pantalla pre-clase, o este socket se acaba de
  // unir a una reunión que ya tenía un modo elegido (catch-up, ver
  // `backend/src/ws/handlers.js#handleJoin`). Le llega a AMBOS roles —
  // actualizar los dos estados (alumno Y docente) sin mirar `role` es
  // inofensivo: cada panel de ajuste rápido solo lee/muestra el que le
  // corresponde. `attentionConfig` además se empuja al detector, igual que
  // un cambio manual de slider (`sendAttentionConfig`) — sin esto,
  // el modo quedaría aplicado solo en la UI, nunca en el modelo real.
  useEffect(() => {
    if (!attentionMode) return;
    setAttentionConfig(attentionMode.student);
    sendAttentionConfig(attentionMode.student);
    setGroupAlertConfig(attentionMode.teacher);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attentionMode]);

  // Corrección (auditoría de inicialización) — bug real: X/Y solo se
  // mandaban al detector cuando el alumno tocaba un slider a mano
  // (`handleAttentionConfigChange`). Al arrancar, el offscreen corría con
  // lo que tuviera cacheado `lastConfiguration` en el service worker
  // (`background/attentionOffscreen.js`) — un valor DUPLICADO A MANO del
  // default de acá arriba, en un archivo distinto, sin ninguna fuente
  // única que garantizara que coincidieran (el propio comentario de
  // `lastConfiguration` ya lo advertía). Cuando por error quedaban
  // desincronizados, el detector arrancaba con un Y/X que la UI ya no
  // reflejaba, hasta que el alumno tocaba CUALQUIER slider — recién ahí se
  // autocorregía, porque eso sí manda el valor real.
  //
  // Ahora, cada vez que arranca la detección (`cameraActive` pasa a
  // `true`), se manda acá la config VIGENTE de `attentionConfig` — la
  // fuente de verdad pasa a ser SIEMPRE el estado de React de esta
  // pantalla, nunca la copia cacheada del service worker (que sigue
  // existiendo con el mismo criterio de antes, pero ahora es un colchón
  // para el primerísimo arranque del documento offscreen — antes de que
  // este efecto o cualquier slider le hayan mandado algo — no la única vía
  // real). Deps solo `[cameraActive]` a propósito: no hace falta reenviar
  // esto cada vez que `attentionConfig` cambia mientras la cámara ya está
  // activa — eso ya lo cubre `handleAttentionConfigChange` en el momento
  // exacto del cambio; este efecto es solo para el arranque.
  useEffect(() => {
    if (!cameraActive) return;
    sendAttentionConfig(attentionConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive]);

  // Aviso de encuadre de cámara (`ui/CameraPositionNotice.jsx`) — mismo
  // disparador que el efecto de arriba: cada vez que `cameraActive` pasa a
  // `true` (la MISMA señal que arranca `useAttentionDetection`, ver esa
  // llamada más abajo), se evalúa mostrar el aviso. Sin chequeo de rol:
  // igual que `useAttentionBroadcast` más abajo, `cameraActive` ya es
  // exclusivo de alumno (`useCameraPreference.js`), así que alcanza con
  // esta condición.
  //
  // Pedido explícito: UNA sola vez por reunión REAL (sobrevive un F5), no
  // "una vez por sesión de React" — un simple `useRef` no alcanza porque
  // se resetea con cualquier remount de `App` (recarga de la pestaña sin
  // salir de la llamada). La fuente de verdad durable es
  // `chrome.storage.local` (`utils/cameraNoticeStorage.js`), clave
  // `` `sparkle-camera-notice-shown-${meetingCode}` `` — mismo patrón que
  // `attentionHistoryStorage.js`, escopeado solo por `meetingCode` (sin
  // email/id de alumno), y por eso también se resetea solo al entrar a
  // OTRA reunión (`meetingCode` distinto), nunca dentro de la misma.
  //
  // `cameraPositionNoticeShownRef` sigue cumpliendo su rol de guard
  // SINCRÓNICO: evita que el efecto de abajo dispare más de una vez
  // mientras la lectura async de `chrome.storage.local` está en vuelo (si
  // `cameraActive` parpadea true/false/true antes de que resuelva). Arranca
  // en `false` y el primer efecto (lectura al montar) lo marca en `true` de
  // entrada si esta reunión ya tenía el aviso mostrado — así el segundo
  // efecto nunca llega a evaluar `cameraActive` con información vieja.
  //
  // `cameraNoticeStorageReadyRef` completa la sincronización: el segundo
  // efecto solo puede mostrar el aviso una vez que la lectura de storage
  // YA resolvió — sin este freno, si `cameraActive` ya es `true` en el
  // primer render (ej. la clase y la preferencia de cámara ya estaban
  // activas ANTES del F5), el efecto de `cameraActive` podría correr y
  // mostrar el aviso antes de que la lectura de storage tuviera chance de
  // marcar `cameraPositionNoticeShownRef` — mostrándolo de nuevo tras un
  // reload pese a haber sido visto antes. Es `useState` (no otro `ref`)
  // porque, a diferencia de las banderas de arriba, SÍ necesita disparar un
  // re-render/re-evaluación del efecto de `cameraActive` cuando la lectura
  // resuelve después de que `cameraActive` ya era `true`.
  const [cameraPositionNoticeVisible, setCameraPositionNoticeVisible] = useState(false);
  const [cameraNoticeStorageReady, setCameraNoticeStorageReady] = useState(false);
  const cameraPositionNoticeShownRef = useRef(false);

  useEffect(() => {
    if (!meetingCode) return undefined;
    let cancelled = false;
    getCameraNoticeShown(meetingCode).then((alreadyShown) => {
      if (cancelled) return;
      if (alreadyShown) cameraPositionNoticeShownRef.current = true;
      setCameraNoticeStorageReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [meetingCode]);

  useEffect(() => {
    if (!cameraActive || !cameraNoticeStorageReady || cameraPositionNoticeShownRef.current) return;
    cameraPositionNoticeShownRef.current = true;
    setCameraPositionNoticeVisible(true);
    setCameraNoticeShown(meetingCode);
  }, [cameraActive, cameraNoticeStorageReady, meetingCode]);

  // Ventana deslizante + alerta de fatiga (con cooldown de re-notificación)
  // — ver `hooks/useFatigueAlert.js` para el porqué de vivir en un hook
  // aparte de `useAttentionDetection`, y por qué el cooldown vive DENTRO de
  // ese hook y no acá.
  const fatigue = useFatigueAlert(attention, {
    threshold: attentionConfig.threshold,
    k: attentionConfig.k,
    qThreshold: attentionConfig.qThreshold,
    cooldownSeconds: attentionConfig.cooldownSeconds,
    classStarted,
    cameraActive,
  });

  // Monitoreo de atención en vivo (panel del docente) — le manda al backend
  // un snapshot de ESTE alumno mientras `cameraActive` sea `true`. Corrección
  // — pedido explícito: ahora incluye `name` (el mismo nombre que ya eligió
  // el alumno al registrarse, resuelto acá por `useInitialRoleResolution`)
  // para que el docente vea el nombre real en vez de un rótulo anónimo —
  // ver `hooks/useAttentionBroadcast.js` para el detalle completo. Solo
  // tiene efecto real para `role === 'student'` (`cameraActive` nunca es
  // `true` para un docente, ver `useCameraPreference.js`), así que no hace
  // falta ningún chequeo de rol acá — llamarlo siempre simplifica el hook
  // sin ningún costo real.
  useAttentionBroadcast({
    meetingCode, email, name, cameraActive, attention,
  });

  // `FatigueAlert` y `NewQuestionToast` son AMBAS exclusivas de alumno (a
  // diferencia de `ClassResumeNotice`/`GroupAttentionAlert`, solo docente) y
  // pueden competir entre sí — a diferencia del resto de las notificaciones
  // de esta app, que nunca coinciden entre sí por rol. Las cuatro viven
  // ahora dentro de `NotificationStack` (`ui/NotificationStack.jsx`, ver el
  // punto de montaje más abajo), que las apila con flexbox sin overlap para
  // CUALQUIER combinación que llegue a coincidir — reemplaza al viejo
  // mecanismo de `ResizeObserver` + offset manual, que solo cubría esta
  // combinación puntual.

  // "Recuperar contenido" — mismo criterio que
  // `handleLaunchQuestionFromGroupAlert` (docente): la acción principal
  // de una alerta flotante, fuera de `.sparkle-panel`, tiene que ABRIR el
  // panel en la pantalla correspondiente (`screens/RecoverySummary.jsx`,
  // montada dentro de `StudentPanel.jsx` vía `requestRecoverySummarySignal`,
  // declarada más arriba en este archivo), no quedarse flotando aparte.
  // Cerrar la alerta (`fatigue.closeAlert()`) es lo mismo que ya hacía el
  // CTA de `NewQuestionToast`: tomar la acción principal también la
  // descarta.
  const handleRecoverLostContent = () => {
    fatigue.closeAlert();
    setIsOpen(true);
    setRequestRecoverySummarySignal((s) => s + 1);
  };

  return (
    <>
      <ToggleTab isOpen={isOpen} onToggle={togglePanel} />
      <CameraPreviewBox
        active={cameraActive}
        error={cameraError}
        videoRef={cameraVideoRef}
        attention={attention}
        inattentiveInWindow={fatigue.inattentiveInWindow}
        k={fatigue.k}
        debugToolsVisible={false}
      />
      {/* Las cuatro notificaciones flotantes de la app comparten un único
          `NotificationStack` (`ui/NotificationStack.jsx`) — se apilan
          verticalmente sin overlap vía flexbox, cada una con su propio
          ciclo de vida/timer interno intacto. Orden en el DOM = orden
          visual cuando coinciden varias visibles: `NewQuestionToast` y
          `FatigueAlert` (ambas de alumno) son las únicas que hoy pueden
          coincidir de verdad, y quedan en ese orden (Toast arriba, Fatiga
          debajo) — `GroupAttentionAlert`/`ClassResumeNotice` (ambas de
          docente) nunca coinciden ni con esas dos ni entre sí, pero viven
          en el mismo stack para no necesitar un mecanismo aparte si eso
          cambia algún día. */}
      <NotificationStack>
        <NewQuestionToast
          visible={questionToastVisible}
          onRespond={handleRespondToQuestionNow}
          onClose={handleCloseQuestionToast}
        />
        <FatigueAlert
          visible={fatigue.alertVisible}
          onDismiss={fatigue.closeAlert}
          onRecoverContent={handleRecoverLostContent}
        />
        {confirmedRole === 'teacher' && (
          <GroupAttentionAlert
            visible={groupAlert.alertVisible}
            onLaunchQuestion={handleLaunchQuestionFromGroupAlert}
            onDismiss={groupAlert.closeAlert}
          />
        )}
        <ClassResumeNotice
          active={confirmedRole === 'teacher' && classResumable}
          meetingCode={meetingCode}
          email={email}
        />
        <CameraPositionNotice
          visible={cameraPositionNoticeVisible}
          onClose={() => setCameraPositionNoticeVisible(false)}
        />
      </NotificationStack>
      <div className={`sparkle-panel ${isOpen ? 'sparkle-panel--open' : 'sparkle-panel--closed'}`}>
        {showBootLoader ? (
          <div className="sparkle-boot-loader">
            <span className="sparkle-spinner" aria-hidden="true" />
            <p className="sparkle-text">Cargando…</p>
          </div>
        ) : (
          <>
            <Header
              role={confirmedRole}
              email={email}
              name={name}
              onClose={closePanel}
              cameraEnabled={cameraEnabled}
              onToggleCamera={handleToggleCamera}
            />
            <main className="sparkle-content">{screen}</main>
          </>
        )}
        {/* Corrección — feedback grande de "¡Respuesta correcta!"/"Respuesta
            incorrecta": a propósito DESCENDIENTE de `.sparkle-panel` (no
            hermano, a diferencia de `NewQuestionToast`/`ClassResumeNotice`
            de arriba, que sí necesitan cubrir TODA la ventana) — el mismo
            `transform` que `.sparkle-panel` usa para animar su apertura/
            cierre lo convierte en el "contenedor" de cualquier `position:
            fixed` de adentro (ver el comentario de `CameraPreviewBox` más
            abajo, mismo mecanismo pero al revés): así, `inset: 0` dentro de
            `AnswerResultPopup.jsx` queda acotado EXACTO a los límites del
            panel (320px × 100vh), nunca al resto de la ventana — sin
            importar el scroll de `.sparkle-content`/`.sparkle-scroll-area`
            (`position: fixed` ignora el scroll de cualquier ancestro que no
            sea el que define su contenedor). `answerResultSignal` solo
            avanza para un socket "student" de verdad (el servidor nunca
            manda "answer_accepted" a un "teacher", ver
            `backend/src/ws/handlers.js`), así que no hace falta ningún
            chequeo extra de `role` acá. */}
        <AnswerResultPopup signal={answerResultSignal} isCorrect={lastAnswerCorrect} />
      </div>
    </>
  );
}
