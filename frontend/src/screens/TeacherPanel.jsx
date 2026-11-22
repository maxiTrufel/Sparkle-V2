import { useEffect, useRef, useState } from 'react';
import {
  PlayIcon,
  StopIcon,
  StudentIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  QuestionIcon,
  ChartIcon,
  AlertTriangleIcon,
  InfoIcon,
  DownloadIcon,
} from '../ui/icons';
import {
  startClass,
  endClass,
  resumeClass,
  getHistory,
  getQuestionsHistory,
  getStudentStats,
} from '../services/backendMessaging';
import GenerateQuestion from './GenerateQuestion';
import ConcentrationStats from './ConcentrationStats';
import QuestionCard from '../ui/QuestionCard';
import ConnectedStudentsBadge from '../ui/ConnectedStudentsBadge';
import DocumentUploadBlock from '../ui/DocumentUploadBlock';
import { AttentionModeSelector } from '../ui/AttentionModeSelector';
import { useCountdown } from '../hooks/useCountdown';
import { useDocumentUpload } from '../hooks/useDocumentUpload';
import { withTimeout } from '../utils/withTimeout';
import { generateClassReport } from '../utils/generateClassReport';

// Corrección — mismo motivo que `ROLE_QUERY_TIMEOUT_MS` en
// `hooks/useInitialRoleResolution.js`: sin un límite propio, un pedido REST
// que se cuelga (conexión zombie del lado del backend, ver el comentario de
// `enableKeepAlive` en `backend/src/db.js`) dejaba `questionsHistoryLoading`/
// `studentStatsLoading` en `true` PARA SIEMPRE — el bug real detrás de
// "Cargando preguntas realizadas…" mostrado sin fin en vez del estado vacío
// o del contenido real. Con esto, cualquier pedido de esta pantalla termina
// su estado de carga como mucho a los `HISTORY_QUERY_TIMEOUT_MS`, mostrando
// un error en vez de quedarse colgado.
const HISTORY_QUERY_TIMEOUT_MS = 8000;

// Único estado real que puede derivarse hoy por alumno: si su email figura
// en `connectedStudents` (WS en vivo) está "En línea"; si no, "Desconectado".
// No existe en el backend un concepto de "Reconectando" por alumno (una
// conexión WS está arriba o no lo está — ver `backend/src/ws/index.js`), así
// que ese estado no se ofrece acá para no mostrar información inventada.
const ROSTER_STATUS_LABELS = {
  online: 'En línea',
  offline: 'Desconectado',
};

function getInitials(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

// Se muestra cuando el rol ya está resuelto para esta reunión puntual —
// sin link de "Cambiar de rol": una vez elegido el rol para esta reunión,
// queda fijo (ver DOCUMENTACION.md, Etapa 17).
//
// `classStarted` (Etapa 44) llega de App.jsx: puede ser `true` porque este
// mismo docente ya apretó "Comenzar Clase", o porque se reconectó/recargó
// el panel y el backend le informó que la clase de esta reunión ya estaba
// activa (persistida en `meetings.active`). Desde la Etapa 45 controla
// además QUÉ VISTA se muestra: con clase activa, la pantalla completa
// cambia a las herramientas de clase en vivo (en vez de solo deshabilitar
// el botón) — vuelve a la vista original apenas llega "class_ended"
// (`App.jsx` la vuelve a poner en `false`, ver ese archivo).
//
// `connectedStudents` (Etapa 46) es el listado REAL que arma el backend a
// partir de las conexiones WS activas de rol "alumno" (ya no un
// placeholder hardcodeado) — un array de `{ email, name }` (Etapa 68:
// `name` se agregó al Cambio 2), actualizado en vivo vía el evento
// "students_updated" (altas, bajas prolijas Y
// desconexiones abruptas, ver `backend/src/ws/index.js`).
//
// `classResumable` (Etapa 50): `true` cuando la última clase de esta reunión
// se cortó (por cualquier motivo — colgó, F5, cerró la pestaña, O apretó
// "Detener Clase" a propósito: desde la Etapa 52 ya no se distingue, ver
// `isResumable()` en `backend/src/ws/index.js`) y este docente se reconecta
// dentro de la ventana de "reanudar" (5 minutos — ver DOCUMENTACION.md).
// Ajuste post-entrega — unificación clase en curso/detenida: antes esto
// disparaba una TERCERA vista aparte (solo un botón "Reanudar clase", sin
// tabs ni estadísticas). Ahora `classStarted` y `classResumable` comparten
// la MISMA vista ("clase detenida" es, ni más ni menos, `classResumable`
// con clase activa en `false`) — lo único que cambia es el badge de estado
// de arriba y las acciones de pie (ver `isActive` más abajo, en el branch
// unificado). Deliberadamente sigue sin haber forma de "saltar" este estado
// hacia "Comenzar Clase" mientras la ventana de 5 minutos siga vigente — una
// vez que pasa, el flujo normal cae solo a esa vista idle.
//
// `joinRejected` (Etapa 51): `true` cuando el servidor rechazó el intento
// de unirse como "profesor" porque YA hay otra persona conectada con ese
// rol en esta reunión (ver `backend/src/ws/index.js`) — solo puede haber un
// profesor por sala a la vez. Bloquea CUALQUIER otra vista: no tiene
// sentido mostrar "Comenzar Clase" ni nada más si este socket ni siquiera
// llegó a unirse de verdad. `onJoinAsStudent` le da a esta persona una
// salida real en vez de dejarla sin ninguna acción posible: reintenta la
// unión a esta misma reunión, pero con rol "alumno" (ver App.jsx).
// `onBackFromRejection` (Ajuste 2, Etapa 70) es la alternativa neutra:
// volver a Welcome sin elegir ningún rol.
//
// `wsConnected` (Etapa 52): refleja en vivo si la conexión FÍSICA del
// background a esta sala está arriba ahora mismo (ver "SPARKLE_WS_CONNECTION"
// en App.jsx/services/wsClient.js) — deshabilita los tres botones que
// dependen de ella mientras esté en `false`, además del reintento
// automático que ya hace el propio comando (ver `sendTeacherCommand` en
// wsClient.js): esto es el complemento de UI ("mostrale al usuario que no
// puede todavía"), no un reemplazo de esa robustez del lado del background.
//
// Etapa 71 — el rol de docente pasa a asignarse de forma DEFINITIVA al
// confirmar en `ConfirmTeacher.jsx`: ya NO existe ningún link "Volver" en
// la vista idle (la que arma "Cargar Archivo"/"Comenzar Clase") — antes de
// esta etapa lo había (Etapa 69, Cambio 3) y liberaba el rol en la base;
// ver DOCUMENTACION.md para la explicación completa de por qué se sacó.
export default function TeacherPanel({
  meetingCode,
  email,
  classStarted,
  connectedStudents = [],
  classResumable,
  joinRejected,
  wsConnected = false,
  onJoinAsStudent,
  onBackFromRejection,
  activeQuestion,
  questionStats,
  finishedQuestion,
  clearFinishedQuestion,
  questionSendError,
  clearQuestionSendError,
  startClassError,
  clearStartClassError,
  reportAvailable = false,
  attentionRoster = [],
  attentionPThreshold,
  attentionHistory = [],
  attentionHistoryLoading = false,
  attentionWindowStartedAt = null,
  requestGenerateQuestionSignal = 0,
  attentionModeId,
  onAttentionModeChange,
}) {
  const [submitting, setSubmitting] = useState(false);
  // Reporte PDF de fin de clase — "Descargar reporte" (topbar, visible
  // mientras `reportAvailable` sea `true`, ver `hooks/useLiveClass.js`).
  // `downloadingReport` cubre el tiempo real que tarda armar el PDF (varios
  // pedidos REST en paralelo + la llamada a IA de la Sección 5, que puede
  // tardar unos segundos) — deshabilita el botón para evitar un doble click
  // que dispare dos descargas/dos llamadas a IA a la vez.
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [reportError, setReportError] = useState(null);
  // Auto-descarte del error (pedido explícito): desaparece solo a los pocos
  // segundos, o antes si el docente reintenta la descarga (`handleDownloadReport`
  // limpia cualquier timer pendiente al arrancar un intento nuevo, para que
  // un reintento rápido no se pise con el auto-descarte del intento anterior).
  const reportErrorTimeoutRef = useRef(null);
  useEffect(() => () => clearTimeout(reportErrorTimeoutRef.current), []);

  const REPORT_ERROR_AUTO_DISMISS_MS = 6000;

  async function handleDownloadReport() {
    if (!meetingCode || !email || downloadingReport) return;
    clearTimeout(reportErrorTimeoutRef.current);
    setDownloadingReport(true);
    setReportError(null);
    try {
      await generateClassReport({ meetingCode, email });
    } catch (err) {
      // "INSUFFICIENT_DATA" (ver `utils/generateClassReport.js`) ya trae un
      // mensaje completo y autocontenido — se muestra TAL CUAL, sin el
      // prefijo genérico que sí antepone cualquier otro error real (de red,
      // de autorización, o de un servicio upstream fallando).
      const message = err.code === 'INSUFFICIENT_DATA' ? err.message : `No se pudo generar el reporte: ${err.message}`;
      setReportError(message);
      reportErrorTimeoutRef.current = setTimeout(() => setReportError(null), REPORT_ERROR_AUTO_DISMISS_MS);
    } finally {
      setDownloadingReport(false);
    }
  }

  // Botón compartido entre la vista "clase en curso/detenida" y la
  // pantalla previa a "Comenzar Clase" — mismo elemento en ambos lugares
  // (siempre como ÚLTIMO elemento del `sparkle-sticky-footer` respectivo),
  // así que se arma una sola vez acá en vez de duplicar el JSX. Pedido
  // explícito: tiene que destacarse claramente del resto del panel — ancho
  // completo, color primario sólido (mismo tratamiento que "Comenzar
  // Clase"/"Generar pregunta", nunca un botón secundario chico como antes).
  const reportDownloadButton = reportAvailable ? (
    <>
      {reportError && <p className="sparkle-text sparkle-text-error">{reportError}</p>}
      <button
        type="button"
        className="sparkle-button sparkle-button-primary sparkle-report-download-button"
        onClick={handleDownloadReport}
        disabled={downloadingReport}
        aria-disabled={downloadingReport}
      >
        <DownloadIcon size={19} />
        {downloadingReport ? 'Generando reporte…' : 'Descargar reporte'}
      </button>
    </>
  ) : null;
  // Ajuste post-entrega — "Generar pregunta" pasó de modal a pantalla
  // propia, así que se navega así (reemplaza al resto del panel, con su
  // "Volver").
  const [generatingQuestion, setGeneratingQuestion] = useState(false);
  // Mismo patrón — "Ver estadísticas de concentración" pasó de modal a
  // pantalla propia.
  const [viewingConcentration, setViewingConcentration] = useState(false);
  // Material de la clase (PDF) — a diferencia de "Generar pregunta"/
  // "Ver estadísticas", este bloque NO navega a una pantalla propia: vive
  // INLINE en la pantalla previa a "Comenzar Clase" (ver
  // `ui/DocumentUploadBlock.jsx`), junto con el resto de los controles.
  // `hasValidDocument`/`loadingCurrent` deciden si "Comenzar Clase" puede
  // habilitarse (requisito de producto: no se puede arrancar la clase sin
  // material cargado — la validación AUTORITATIVA vive en el backend, ver
  // `backend/src/ws/handlers.js`, `handleStartClass`).
  const documentUpload = useDocumentUpload({ meetingCode, email });
  // Requisito de producto (pedido explícito) — el modo de clase pasa a ser
  // OBLIGATORIO: "Comenzar Clase" queda deshabilitado hasta que el docente
  // elija una opción real del `<select>` de `AttentionModeSelector` (nunca
  // el placeholder "Seleccioná el modo de clase..."), sin importar que ya
  // haya llegado un modo por defecto vía el catch-up del "join" (ver el
  // comentario de `chosen` en `ui/AttentionModeSelector.jsx`). Estado
  // puramente local de UI — nunca reemplaza a `attentionModeId`/
  // `attentionMode` (App.jsx) como fuente de verdad del modo en sí, solo
  // gatea si YA se puede arrancar.
  const [attentionModeChosenManually, setAttentionModeChosenManually] = useState(false);
  const handleAttentionModeSelectChange = (modeId) => {
    setAttentionModeChosenManually(true);
    onAttentionModeChange(modeId);
  };
  // Ajuste post-entrega — "Detener Clase" ya no llama a `handleEndClass`
  // directo: primero abre este modal de confirmación (`sparkle-confirm-*`
  // más abajo) y solo se detiene la clase de verdad si el docente confirma
  // ahí. `handleConfirmEndClass` es quien efectivamente llama a
  // `handleEndClass`.
  const [confirmingStop, setConfirmingStop] = useState(false);
  // Tab activa dentro de la vista de clase en curso — solo estado visual
  // local (qué contenido se muestra), sin lógica de negocio detrás.
  const [activeTab, setActiveTab] = useState('general');

  // Navegación automática a la pregunta recién enviada (Ajuste "experiencia
  // docente") — `handleQuestionSent` (más abajo) la llama desde
  // `GenerateQuestion.jsx` JUSTO cuando el envío ya se confirmó (nunca antes,
  // nunca si falló). `pendingHighlightIdRef` guarda el id a la espera de que
  // la tarjeta correspondiente exista de verdad en el DOM (recién ahí tiene
  // sentido hacer `scrollIntoView`) — el efecto de más abajo, que corre
  // después de cada commit, es quien detecta ese momento.
  const [highlightedQuestionId, setHighlightedQuestionId] = useState(null);
  const liveQuestionCardRef = useRef(null);
  const pendingHighlightIdRef = useRef(null);

  // Padrón completo de la tab "Alumnos" (Ajuste post-entrega: antes era un
  // mock, ahora sale de datos reales): `getHistory` trae a TODOS los que
  // alguna vez se conectaron a esta reunión (estén o no conectados ahora), y
  // se re-arma
  // cada vez que cambia `connectedStudents` — no es un timer propio, es una
  // reacción al mismo evento WS real ("students_updated") que ya mantiene
  // vivo ese listado, así que un alumno que se desconecta pasa a verse como
  // "Desconectado" (en vez de simplemente desaparecer) sin agregar ningún
  // polling nuevo.
  const [roster, setRoster] = useState([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState(null);

  // Historial REAL de preguntas finalizadas — "Preguntas realizadas" (ver
  // `backend/src/services/questionService.getFinishedQuestionsForMeeting`).
  // Nada hardcodeado: se pide por REST al montar/cambiar de reunión, y de
  // nuevo cada vez que una pregunta termina (`finishedQuestion`, ver
  // `hooks/useLiveQuestions.js`) — el WebSocket solo avisa CUÁNDO recargar,
  // el contenido en sí siempre sale de la base de datos (fuente de verdad),
  // nunca del propio mensaje WS. `requestIdRef` descarta una respuesta
  // vieja si un pedido más nuevo ya está en vuelo (ej. dos preguntas
  // terminan una atrás de la otra).
  const [questionsHistory, setQuestionsHistory] = useState([]);
  const [questionsHistoryLoading, setQuestionsHistoryLoading] = useState(true);
  const [questionsHistoryError, setQuestionsHistoryError] = useState(null);
  const questionsHistoryRequestIdRef = useRef(0);

  function loadQuestionsHistoryNow() {
    // Corrección — antes este guard dejaba `questionsHistoryLoading` en
    // `true` PARA SIEMPRE si corría sin `email` todavía resuelto (el bug
    // real detrás de "Cargando preguntas realizadas…" sin fin en el primer
    // ingreso tras varios días sin usar la extensión — ver
    // `ConfirmTeacher.jsx`/`hooks/useInitialRoleResolution.js` para la
    // causa raíz completa: el rol nunca llegaba a confirmarse con un email
    // real, así que este componente ni siquiera debería llegar a montarse
    // en ese estado). Se deja como red de seguridad, no como el fix
    // principal: si de verdad faltan datos, el estado de carga SIEMPRE
    // termina (nunca colgado) y el efecto de abajo reintenta solo apenas
    // `meetingCode`/`email` estén disponibles (están en sus dependencias).
    if (!meetingCode || !email) {
      console.log(
        `[Sparkle][DIAG] loadQuestionsHistoryNow(): faltan datos (meetingCode=${meetingCode || '(sin dato)'} ` +
          `email=${email || '(sin dato)'}) — no se pide el historial todavía.`
      );
      setQuestionsHistoryLoading(false);
      return;
    }
    const requestId = (questionsHistoryRequestIdRef.current += 1);
    setQuestionsHistoryLoading(true);
    setQuestionsHistoryError(null);
    withTimeout(
      getQuestionsHistory(meetingCode, email),
      HISTORY_QUERY_TIMEOUT_MS,
      'Se agotó el tiempo de espera cargando las preguntas realizadas.'
    )
      .then((result) => {
        if (questionsHistoryRequestIdRef.current !== requestId) return;
        if (result?.error) throw new Error(result.error);
        setQuestionsHistory(result?.questions || []);
      })
      .catch((err) => {
        if (questionsHistoryRequestIdRef.current !== requestId) return;
        setQuestionsHistoryError(`No se pudieron cargar las preguntas realizadas: ${err.message}`);
      })
      .finally(() => {
        if (questionsHistoryRequestIdRef.current !== requestId) return;
        setQuestionsHistoryLoading(false);
      });
  }

  useEffect(() => {
    loadQuestionsHistoryNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingCode, email]);

  // Corrección — salto visual al finalizar una pregunta: el momento en que
  // `activeQuestion` pasa a `null` (WS, instantáneo) y el momento en que el
  // historial REST se recarga con esa misma pregunta ya incluida (round-trip
  // a la base, asincrónico) NO son el mismo instante — sin este puente, la
  // tarjeta en vivo desaparecía de una y la tarjeta final recién aparecía un
  // rato después, dejando un hueco vacío (o corriendo el resto de la lista)
  // en el medio: el "salto" reportado. `finishedQuestion` (ver
  // `hooks/useLiveQuestions.js`) ya trae todo lo necesario — la opción
  // correcta y las últimas estadísticas conocidas — para armar, LOCALMENTE,
  // el mismo snapshot final que el REST va a traer un instante después
  // (mismo criterio que `optimisticEntry` en `StudentPanel.jsx`). Vive en su
  // PROPIO estado (no en `finishedQuestion` en sí, que se limpia de una —
  // ver el efecto de acá abajo): tiene que sobrevivir hasta que la fila
  // REAL llegue, no solo hasta el próximo render.
  const [optimisticFinished, setOptimisticFinished] = useState(null);

  useEffect(() => {
    if (!finishedQuestion) return;
    setOptimisticFinished(finishedQuestion);
    loadQuestionsHistoryNow();
    clearFinishedQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedQuestion]);

  // Descarta el snapshot local apenas la fila REAL ya está en
  // `questionsHistory` (el fetch de arriba resolvió) — nunca antes: si se
  // limpiara junto con `finishedQuestion` (arriba), volvería a abrirse el
  // mismo hueco que este puente existe para evitar.
  useEffect(() => {
    if (optimisticFinished && questionsHistory.some((q) => q.id === optimisticFinished.id)) {
      setOptimisticFinished(null);
    }
  }, [questionsHistory, optimisticFinished]);

  // Estadísticas agregadas POR ALUMNO — "X/Y respuestas correctas" en la
  // tab "Alumnos" (ver `backend/src/services/questionService.
  // getStudentStatsForMeeting`). Mismo patrón que `questionsHistory` de
  // arriba: se pide por REST al montar/cambiar de reunión y de nuevo cada
  // vez que una pregunta termina — nunca un valor inventado, ni siquiera
  // como fallback ante un error (ver el render más abajo: si falla, no se
  // muestra ningún número).
  const [studentStats, setStudentStats] = useState([]);
  const [studentStatsLoading, setStudentStatsLoading] = useState(true);
  const [studentStatsError, setStudentStatsError] = useState(null);
  const studentStatsRequestIdRef = useRef(0);

  function loadStudentStatsNow() {
    // Corrección — mismo criterio que `loadQuestionsHistoryNow`: nunca
    // deja `studentStatsLoading` colgado en `true`.
    if (!meetingCode || !email) {
      setStudentStatsLoading(false);
      return;
    }
    const requestId = (studentStatsRequestIdRef.current += 1);
    setStudentStatsLoading(true);
    setStudentStatsError(null);
    withTimeout(
      getStudentStats(meetingCode, email),
      HISTORY_QUERY_TIMEOUT_MS,
      'Se agotó el tiempo de espera cargando las estadísticas de los alumnos.'
    )
      .then((result) => {
        if (studentStatsRequestIdRef.current !== requestId) return;
        if (result?.error) throw new Error(result.error);
        setStudentStats(result?.students || []);
      })
      .catch((err) => {
        if (studentStatsRequestIdRef.current !== requestId) return;
        setStudentStatsError(`No se pudieron cargar las estadísticas de los alumnos: ${err.message}`);
      })
      .finally(() => {
        if (studentStatsRequestIdRef.current !== requestId) return;
        setStudentStatsLoading(false);
      });
  }

  useEffect(() => {
    loadStudentStatsNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingCode, email]);

  useEffect(() => {
    if (!finishedQuestion) return;
    loadStudentStatsNow();
    // No se llama `clearFinishedQuestion()` acá de nuevo — el efecto de
    // `questionsHistory` de arriba ya lo hace en la misma tanda de efectos
    // de este render; llamarlo dos veces sería inofensivo (es idempotente)
    // pero redundante.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedQuestion]);

  // Corrección — el "X/Y" ya contaba TODAS las preguntas de la clase (el
  // backend no filtra por cuándo entró cada alumno), pero la lista solo se
  // refrescaba al montar y al terminar cada pregunta. Dos huecos que se
  // cierran acá:
  //   1. Al detener la clase no se volvía a pedir — se refresca en la
  //      transición de "en curso" a "detenida".
  //   2. Un alumno que entraba DESPUÉS de la última pregunta aparecía sin
  //      su línea de "X/Y" (no estaba en la última respuesta). Se vuelve a
  //      pedir cuando hay un conectado sin estadísticas. La dependencia es la
  //      lista de emails y no el array, para no repetir el pedido en cada
  //      mensaje del WebSocket.
  const wasClassStartedRef = useRef(classStarted);
  useEffect(() => {
    if (wasClassStartedRef.current && !classStarted) loadStudentStatsNow();
    wasClassStartedRef.current = classStarted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classStarted]);

  const connectedEmailsKey = connectedStudents
    .map((s) => s.email)
    .sort()
    .join('|');
  useEffect(() => {
    if (studentStatsLoading) return;
    const withStats = new Set(studentStats.map((s) => s.email));
    if (connectedStudents.some((s) => !withStats.has(s.email))) loadStudentStatsNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedEmailsKey]);

  // Cuenta regresiva de la pregunta EN VIVO (si la hay) — `question.
  // localExpiresAt` ya viene corregido a reloj local, calculado una sola
  // vez por `hooks/useLiveQuestions.js` (ver ese archivo para el detalle
  // del bug que corrige no recalcularlo en cada render).
  const liveSecondsLeft = useCountdown(activeQuestion?.localExpiresAt);
  const liveQuestionEntry =
    activeQuestion && questionStats
      ? {
          id: `live-${activeQuestion.id}`,
          isLive: true,
          prompt: activeQuestion.prompt,
          remainingSeconds: liveSecondsLeft,
          totalSeconds: activeQuestion.durationSeconds,
          responseCount: questionStats.answeredCount,
          optionDistribution: activeQuestion.options.map((label, i) => ({
            label,
            percent:
              questionStats.answeredCount > 0
                ? Math.round(((questionStats.optionCounts?.[i] ?? 0) / questionStats.answeredCount) * 100)
                : 0,
            correct: i === questionStats.correctOptionIndex,
          })),
        }
      : null;

  // Misma forma que `liveQuestionEntry`/una fila real de `questionsHistory`
  // (`QuestionCard` no distingue de dónde vino cada una) — arma el
  // snapshot final a partir de `optimisticFinished` mientras el REST
  // todavía no confirmó lo mismo. `isLive` NO se incluye acá (a diferencia
  // de `liveQuestionEntry`): se decide una sola vez, afuera, según cuál de
  // las dos entradas es la que se está mostrando.
  const optimisticFinishedEntry = optimisticFinished
    ? {
        id: optimisticFinished.id,
        prompt: optimisticFinished.prompt,
        responseCount: optimisticFinished.stats?.answeredCount ?? 0,
        optionDistribution: optimisticFinished.options.map((label, i) => ({
          label,
          percent:
            optimisticFinished.stats?.answeredCount > 0
              ? Math.round(
                  ((optimisticFinished.stats.optionCounts?.[i] ?? 0) / optimisticFinished.stats.answeredCount) * 100
                )
              : 0,
          correct: i === optimisticFinished.correctOptionIndex,
        })),
      }
    : null;

  // La tarjeta "de arriba" — en vivo si todavía hay una pregunta activa, o
  // el snapshot optimista apenas terminó (ver el comentario de
  // `optimisticFinished` más arriba). Nunca las dos a la vez:
  // `liveQuestionEntry` requiere `activeQuestion`, que ya es `null` para
  // cuando `finishedQuestion`/`optimisticFinished` existen.
  const topQuestionEntry = liveQuestionEntry || optimisticFinishedEntry;
  // Mientras el snapshot optimista siga vigente, se excluye esa misma
  // pregunta de `questionsHistory` — evita una key de React duplicada (y
  // una tarjeta repetida) en el único instante en que ambas fuentes
  // podrían coexistir (el fetch real resolvió, pero el efecto que limpia
  // `optimisticFinished` todavía no corrió).
  const visibleQuestionsHistory = optimisticFinished
    ? questionsHistory.filter((q) => q.id !== optimisticFinished.id)
    : questionsHistory;

  // Se llama desde `GenerateQuestion.jsx` (`onQuestionSent`) apenas el envío
  // ya se confirmó de verdad (`activeQuestion` cambió a la pregunta nueva) —
  // fuerza la tab "General" (la única que muestra la tarjeta en vivo; si el
  // docente estaba en "Alumnos" al enviar, sin esto volvería a esa tab y la
  // pregunta quedaría invisible) y deja pendiente el scroll+resalte para el
  // efecto de abajo, que espera a que la tarjeta exista de verdad en el DOM.
  function handleQuestionSent(questionId) {
    setActiveTab('general');
    pendingHighlightIdRef.current = questionId;
  }

  // Corre después de cada commit — comprueba si ya estamos de vuelta en la
  // vista/tab correctas Y la tarjeta en vivo (`liveQuestionCardRef`) ya está
  // montada con el id pendiente: recién ahí tiene sentido `scrollIntoView`
  // (antes, el nodo no existe o todavía muestra la pregunta VIEJA). `block:
  // 'nearest'` + que la única caja con `overflow-y: auto` en toda esta rama
  // sea `.sparkle-scroll-area` (ver `styles/panel.css`) es lo que garantiza
  // que se desplaza ESE contenedor y no la página de Meet por detrás — un
  // elemento `position: fixed` como `.sparkle-panel` nunca necesita que el
  // documento se mueva para "traerlo a la vista". El resalte se saca solo
  // (`setTimeout`) después de que la animación CSS ya terminó de desvanecerse
  // (ver `.sparkle-question-card--highlight`, `panel.css`).
  useEffect(() => {
    if (!pendingHighlightIdRef.current) return undefined;
    if (generatingQuestion) return undefined;
    if (activeTab !== 'general') return undefined;
    if (!activeQuestion || activeQuestion.id !== pendingHighlightIdRef.current) return undefined;
    if (!liveQuestionCardRef.current) return undefined;

    const questionId = pendingHighlightIdRef.current;
    pendingHighlightIdRef.current = null;

    liveQuestionCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setHighlightedQuestionId(questionId);
    const timeoutId = setTimeout(() => {
      setHighlightedQuestionId((current) => (current === questionId ? null : current));
    }, 1600);
    return () => clearTimeout(timeoutId);
  }, [generatingQuestion, activeTab, activeQuestion]);

  // Nombrada (en vez de la lambda inline de antes) para que el botón
  // "Reintentar" del padrón (ver el render de la tab "Alumnos") pueda
  // volver a dispararla a mano, además del efecto automático de abajo.
  function loadRosterNow(meetingCodeToLoad) {
    if (!meetingCodeToLoad) {
      setRosterLoading(false);
      return () => {};
    }

    let cancelled = false;
    setRosterLoading(true);
    withTimeout(
      getHistory(meetingCodeToLoad),
      HISTORY_QUERY_TIMEOUT_MS,
      'Se agotó el tiempo de espera cargando el listado de alumnos.'
    )
      .then((result) => {
        if (cancelled) return;
        setRoster(result?.students || []);
        setRosterError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setRosterError(`No se pudo cargar el listado de alumnos: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setRosterLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }

  useEffect(() => {
    return loadRosterNow(meetingCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingCode, connectedStudents]);

  // Combina el historial (`roster`) con quienes están conectados AHORA
  // (`connectedStudents`): un alumno recién unido puede no estar todavía en
  // el historial (esa consulta es asincrónica), así que ambas fuentes se
  // mezclan por email para no perder a nadie. El estado de cada uno sale
  // pura y únicamente de si su email está en `connectedStudents` — no hay
  // ningún dato inventado.
  const connectedEmails = new Set(connectedStudents.map((s) => s.email));
  const rosterByEmail = new Map();
  roster.forEach((s) => rosterByEmail.set(s.email, { email: s.email, name: s.name }));
  connectedStudents.forEach((s) => rosterByEmail.set(s.email, { email: s.email, name: s.name }));
  // "X/Y respuestas correctas" — REAL, desde `studentStats` (ver
  // `backend/src/services/questionService.getStudentStatsForMeeting`), no
  // un mock: `correctAnswers`/`totalFinishedQuestions` salen tal cual del
  // backend, para un alumno específico. Si `studentStats` todavía no
  // cargó (o no encuentra a este alumno — no debería pasar para un
  // alumno con fila real en `participations`, pero por las dudas), la
  // línea de progreso simplemente no se renderiza (ver más abajo) en vez
  // de mostrar un número inventado.
  const studentStatsByEmail = new Map(studentStats.map((s) => [s.email, s]));
  const fullRoster = Array.from(rosterByEmail.values())
    .map((s) => ({
      ...s,
      status: connectedEmails.has(s.email) ? 'online' : 'offline',
      stats: studentStatsByEmail.get(s.email) || null,
    }))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
      return (a.name || a.email).localeCompare(b.name || b.email);
    });

  // Corrección — no se puede comenzar la clase sin material cargado
  // (requisito de producto): la guarda de acá abajo (`!documentUpload.
  // hasValidDocument`) es la barrera del lado del CLIENTE — el botón ya
  // queda `disabled` para el caso común (ver el render de la vista idle,
  // más abajo), esto cubre cualquier otro camino de llegar a esta función.
  // La barrera AUTORITATIVA es del lado del servidor (`backend/src/ws/
  // handlers.js`, `handleStartClass` — responde "class_start_rejected" si
  // se la evita igual, ver `startClassError` en `hooks/useLiveClass.js`).
  const handleStartClass = async () => {
    if (!meetingCode || submitting || classStarted || !documentUpload.hasValidDocument) return;
    setSubmitting(true);
    clearStartClassError();
    try {
      await startClass(meetingCode, email);
    } catch (err) {
      console.log(`[Sparkle] Error iniciando la clase: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // Guarda defensiva explícita — mismo criterio que
  // `handleGenerateQuestionClick`: además de `disabled` en el botón (que ya
  // bloquea click/Enter nativos), esta función es el único camino real
  // hacia el pedido real de "Detener Clase" — así que sigue impidiéndolo
  // aunque algo dispare `handleConfirmEndClass` por otra vía. El backend
  // (`ws/handlers.js`, `handleEndClass`) revalida lo mismo del lado del
  // servidor, la barrera autoritativa.
  const handleEndClass = async () => {
    if (!meetingCode || submitting || activeQuestion) return;
    setSubmitting(true);
    try {
      await endClass(meetingCode, email);
    } catch (err) {
      console.log(`[Sparkle] Error deteniendo la clase: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmEndClass = () => {
    setConfirmingStop(false);
    handleEndClass();
  };

  const handleResumeClass = async () => {
    if (!meetingCode || submitting) return;
    setSubmitting(true);
    try {
      await resumeClass(meetingCode, email);
    } catch (err) {
      console.log(`[Sparkle] Error reanudando la clase: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // Corrección — el docente solo puede generar una pregunta con la clase EN
  // CURSO: mientras esté detenida (`classResumable`, `classStarted ===
  // false`), no tiene sentido armar una — no existe ningún mecanismo de
  // "pregunta pendiente" que se dispare sola al reanudar (ver
  // `backend/src/services/questionService.createAndStartQuestion`, que
  // ahora rechaza el intento del lado del servidor también). Además,
  // mientras haya una pregunta activa, el docente no puede generar otra (el
  // `QuestionProvider`/`activeQuestion` ya lo impedía del lado del
  // servidor, pero el botón solo se veía "atenuado" — ver el CSS
  // `:disabled` común en `panel.css`).
  const generateQuestionDisabled = Boolean(activeQuestion) || !classStarted;

  // Guarda defensiva explícita — además de `disabled` (que ya bloquea click
  // y foco/Enter nativos del propio `<button>`), esta función es la única
  // vía real hacia `setGeneratingQuestion(true)`: si algún flujo futuro
  // llegara a invocarla por otro camino (atajo de teclado, remount, etc.)
  // sin pasar por el atributo `disabled` del DOM, esta comprobación sigue
  // impidiendo abrir la pantalla de generación mientras haya una pregunta
  // activa.
  function handleGenerateQuestionClick() {
    if (generateQuestionDisabled) return;
    setGeneratingQuestion(true);
  }

  // "Lanzar pregunta" desde la alerta grupal de atención (`App.jsx`,
  // `ui/GroupAttentionAlert.jsx`) — señal externa (contador que solo avanza
  // ante un click real, arranca en 0 y nunca dispara nada al montar, mismo
  // criterio que `newQuestionSignal` en `hooks/useLiveQuestions.js`). Pasa
  // por las MISMAS reglas que el botón de más abajo
  // (`generateQuestionDisabled`) — si ya hay una pregunta activa o la clase
  // no está en curso, la alerta ya se cerró (eso lo hace `App.jsx`) pero
  // esta pantalla no se abre sola.
  useEffect(() => {
    if (!requestGenerateQuestionSignal) return;
    if (generateQuestionDisabled) return;
    setActiveTab('general');
    setGeneratingQuestion(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestGenerateQuestionSignal]);

  if (generatingQuestion) {
    return (
      <GenerateQuestion
        meetingCode={meetingCode}
        email={email}
        activeQuestion={activeQuestion}
        questionSendError={questionSendError}
        clearQuestionSendError={clearQuestionSendError}
        onBack={() => setGeneratingQuestion(false)}
        onQuestionSent={handleQuestionSent}
      />
    );
  }

  if (viewingConcentration) {
    return (
      <ConcentrationStats
        onBack={() => setViewingConcentration(false)}
        roster={attentionRoster}
        pThreshold={attentionPThreshold}
        classStarted={classStarted}
        history={attentionHistory}
        historyLoading={attentionHistoryLoading}
        windowStartedAt={attentionWindowStartedAt}
      />
    );
  }

  if (joinRejected) {
    return (
      <div className="sparkle-screen">
        <div className="sparkle-screen-head">
          {/* Ajuste 2 (Etapa 70) — alternativa neutra a "Unirme como
              alumno": vuelve a Welcome sin elegir ningún rol. */}
          <button type="button" className="sparkle-back-link" onClick={onBackFromRejection}>
            <ChevronLeftIcon size={15} />
            Volver
          </button>
          <h1 className="sparkle-title">Sparkle V2</h1>
          <p className="sparkle-subtitle">Ya hay un docente asignado para esta reunión.</p>
        </div>
        {/* Etapa 65 — sin la vieja sugerencia de "esperar a que se desconecte y
            recargar": desde la Etapa 61 la restricción de "un solo docente" es
            PERMANENTE (no depende de si sigue conectado), así que ese consejo
            ya no era cierto — nadie más puede convertirse en docente de esta
            reunión aunque el original se desconecte. */}
        <p className="sparkle-text">
          Solo puede haber un docente por reunión. Te recomendamos ingresar como alumno.
        </p>
        <div className="sparkle-actions">
          <button className="sparkle-button sparkle-button-primary" onClick={onJoinAsStudent}>
            <StudentIcon size={17} />
            Unirme como alumno
          </button>
        </div>
      </div>
    );
  }

  if (classStarted || classResumable) {
    // Ajuste post-entrega — unifica "clase en curso" y "clase detenida" en UNA
    // sola vista: antes `classResumable` reemplazaba TODO el contenido por una
    // pantalla vacía con un único botón "Reanudar clase" (perdiendo tabs,
    // estadísticas y padrón). Ahora es la MISMA vista, con el badge de estado
    // arriba y las acciones de pie adaptadas — nada de contenido central
    // cambia entre ambos estados.
    const isActive = classStarted;

    return (
      <div className="sparkle-screen sparkle-screen--live">
        <div className="sparkle-panel-topbar">
          <div className="sparkle-topbar-badges">
            <ConnectedStudentsBadge students={connectedStudents} />
            <span className={`sparkle-class-status-badge sparkle-class-status-badge--${isActive ? 'active' : 'paused'}`}>
              <span className="sparkle-class-status-dot" />
              {isActive ? 'Clase en curso' : 'Clase detenida'}
            </span>
          </div>

          <div className="sparkle-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'general'}
              className={`sparkle-tab ${activeTab === 'general' ? 'sparkle-tab--active' : ''}`}
              onClick={() => setActiveTab('general')}
            >
              General
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'alumnos'}
              className={`sparkle-tab ${activeTab === 'alumnos' ? 'sparkle-tab--active' : ''}`}
              onClick={() => setActiveTab('alumnos')}
            >
              Alumnos
            </button>
          </div>
        </div>

        <div className="sparkle-scroll-area">
          {activeTab === 'general' && (
            <div className="sparkle-tab-content">
              {/* Corrección — visible tanto con la clase EN CURSO
                  (`classStarted`) como DETENIDA (`classResumable`, esperando
                  que el docente la reanude): en ambos casos ya hubo una
                  clase con datos reales de atención para mostrar. Solo NO
                  aparece en la pantalla previa a "Comenzar Clase" (el
                  return final de este componente, fuera de esta rama) —
                  ahí todavía no hubo ninguna clase. */}
              {(classStarted || classResumable) && (
                <button
                  type="button"
                  className="sparkle-insight-button"
                  onClick={() => setViewingConcentration(true)}
                >
                  <span className="sparkle-insight-icon">
                    <ChartIcon size={18} />
                  </span>
                  <span className="sparkle-insight-text">
                    <span className="sparkle-insight-title">Ver estadísticas de atención de los alumnos</span>
                    <span className="sparkle-insight-helper">Atención en tiempo real durante la clase</span>
                  </span>
                  <ChevronRightIcon size={16} className="sparkle-insight-arrow" />
                </button>
              )}

              <div>
                <p className="sparkle-section-label">Preguntas realizadas</p>

                {/* Corrección — la tarjeta "de arriba" (`topQuestionEntry`)
                    ya NO depende de `questionsHistoryLoading`: antes estaba
                    anidada dentro de `!questionsHistoryLoading`, así que si
                    el historial de preguntas FINALIZADAS tardaba en cargar
                    (o directamente se quedaba colgado — el bug real detrás
                    de "Cargando preguntas realizadas…" sin fin), la pregunta
                    EN VIVO tampoco se mostraba, aunque ya hubiera llegado
                    por WebSocket. Ahora se muestra sola, incondicional.
                    Corrección (salto visual al finalizar) — la MISMA
                    tarjeta pasa de `liveQuestionEntry` a
                    `optimisticFinishedEntry` sin desmontarse (React reusa el
                    nodo: mismo lugar en el árbol, mismo `key` implícito de
                    posición), así que `panel.css` puede animar el cambio de
                    `isLive` con una transición CSS en vez de un salto — ver
                    `.sparkle-question-card-timer-wrap` ahí. */}
                {topQuestionEntry && (
                  <div className="sparkle-question-list">
                    <QuestionCard
                      ref={liveQuestionCardRef}
                      {...topQuestionEntry}
                      isLive={Boolean(liveQuestionEntry)}
                      highlighted={Boolean(liveQuestionEntry) && highlightedQuestionId === activeQuestion?.id}
                    />
                  </div>
                )}

                {questionsHistoryLoading && <p className="sparkle-text">Cargando preguntas realizadas…</p>}

                {!questionsHistoryLoading && questionsHistoryError && (
                  <div className="sparkle-inline-error">
                    <p className="sparkle-text sparkle-text-error">{questionsHistoryError}</p>
                    <button
                      type="button"
                      className="sparkle-button sparkle-button-secondary sparkle-button-compact"
                      onClick={loadQuestionsHistoryNow}
                    >
                      Reintentar
                    </button>
                  </div>
                )}

                {!questionsHistoryLoading &&
                  !questionsHistoryError &&
                  !topQuestionEntry &&
                  visibleQuestionsHistory.length === 0 && (
                    <p className="sparkle-text">Todavía no se realizó ninguna pregunta en esta clase.</p>
                  )}

                {!questionsHistoryLoading && !questionsHistoryError && visibleQuestionsHistory.length > 0 && (
                  <div className="sparkle-question-list">
                    {visibleQuestionsHistory.map((question, i) => (
                      <QuestionCard key={question.id} {...question} index={visibleQuestionsHistory.length - i} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'alumnos' && (
            <div className="sparkle-tab-content">
              {rosterLoading && <p className="sparkle-text">Cargando alumnos…</p>}
              {!rosterLoading && rosterError && (
                <div className="sparkle-inline-error">
                  <p className="sparkle-text sparkle-text-error">{rosterError}</p>
                  <button
                    type="button"
                    className="sparkle-button sparkle-button-secondary sparkle-button-compact"
                    onClick={() => loadRosterNow(meetingCode)}
                  >
                    Reintentar
                  </button>
                </div>
              )}
              {/* "X/Y respuestas correctas" — error de carga aparte del
                  roster en sí: el padrón puede haber cargado bien aunque
                  las estadísticas hayan fallado (son dos pedidos
                  independientes), así que se avisa por separado en vez de
                  tapar todo el roster por un fallo de una sola línea. */}
              {!studentStatsLoading && studentStatsError && (
                <div className="sparkle-inline-error">
                  <p className="sparkle-text sparkle-text-error">{studentStatsError}</p>
                  <button
                    type="button"
                    className="sparkle-button sparkle-button-secondary sparkle-button-compact"
                    onClick={loadStudentStatsNow}
                  >
                    Reintentar
                  </button>
                </div>
              )}

              {!rosterLoading && !rosterError && fullRoster.length === 0 && (
                <p className="sparkle-text">Todavía no se conectó ningún alumno a esta clase.</p>
              )}

              {!rosterLoading && !rosterError && fullRoster.length > 0 && (
                <div className="sparkle-roster-list">
                  {fullRoster.map((student) => (
                    <div className="sparkle-roster-item" key={student.email}>
                      <span className="sparkle-roster-avatar">{getInitials(student.name || student.email)}</span>
                      <div className="sparkle-roster-info">
                        <span className="sparkle-roster-name">{student.name || student.email}</span>
                        <span className={`sparkle-roster-status sparkle-roster-status--${student.status}`}>
                          <span className="sparkle-roster-status-dot" />
                          {ROSTER_STATUS_LABELS[student.status]}
                        </span>
                        {/* Sin datos ficticios como fallback: mientras
                            `studentStats` está cargando, o si falló, esta
                            línea simplemente no se muestra (el error ya se
                            avisa una sola vez arriba, no por alumno). */}
                        {!studentStatsLoading && !studentStatsError && student.stats && (
                          <span className="sparkle-roster-progress">
                            {student.stats.correctAnswers}/{student.stats.totalFinishedQuestions} respuestas correctas
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="sparkle-sticky-footer">
          {/* Corrección — "Generar pregunta" ahora solo está disponible con
              la clase EN CURSO: `classResumable` (clase detenida) deshabilita
              el botón igual que `activeQuestion`, con su propio tooltip. A
              propósito NO existe un botón equivalente en la pantalla PREVIA
              a "Comenzar Clase" (el return final de este componente): ese
              acceso se sacó de ahí, queda solo acá. */}
          {activeTab === 'general' && (
            <button
              type="button"
              className="sparkle-button sparkle-button-primary"
              onClick={handleGenerateQuestionClick}
              disabled={generateQuestionDisabled}
              aria-disabled={generateQuestionDisabled}
              title={
                !classStarted
                  ? 'Reanudá la clase para generar una pregunta'
                  : activeQuestion
                    ? 'Ya hay una pregunta activa — esperá a que termine.'
                    : undefined
              }
            >
              <QuestionIcon size={17} />
              {activeQuestion ? `Esperá ${Math.max(liveSecondsLeft, 0)} segundos` : 'Generar pregunta'}
            </button>
          )}
          {isActive ? (
            <button
              className="sparkle-button sparkle-button-danger"
              onClick={() => setConfirmingStop(true)}
              disabled={submitting || !wsConnected || Boolean(activeQuestion)}
              aria-disabled={submitting || !wsConnected || Boolean(activeQuestion)}
              title={activeQuestion ? 'Esperá a que finalice la pregunta para detener la clase' : undefined}
            >
              <StopIcon size={17} />
              Detener Clase
            </button>
          ) : (
            <button
              className="sparkle-button sparkle-button-primary"
              onClick={handleResumeClass}
              disabled={submitting || !wsConnected}
            >
              <PlayIcon size={17} />
              Reanudar clase
            </button>
          )}
          {reportDownloadButton}
        </div>

        {confirmingStop && (
          <div className="sparkle-confirm-backdrop">
            <div className="sparkle-confirm-dialog" role="alertdialog" aria-modal="true">
              <h2 className="sparkle-confirm-title">¿Estás seguro de que querés detener la clase?</h2>
              <p className="sparkle-confirm-text">
                Las estadísticas dejarán de actualizarse hasta que la clase sea reanudada.
              </p>
              <div className="sparkle-confirm-actions">
                <button
                  type="button"
                  className="sparkle-button sparkle-button-danger"
                  onClick={handleConfirmEndClass}
                  disabled={submitting || !wsConnected || Boolean(activeQuestion)}
                  aria-disabled={submitting || !wsConnected || Boolean(activeQuestion)}
                  title={activeQuestion ? 'Esperá a que finalice la pregunta para detener la clase' : undefined}
                >
                  <StopIcon size={17} />
                  Detener clase
                </button>
                <button
                  type="button"
                  className="sparkle-button sparkle-button-tertiary"
                  onClick={() => setConfirmingStop(false)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    );
  }

  // Requisito de producto — no se puede comenzar la clase sin material
  // cargado Y analizado OK. Mientras `loadingCurrent` no resolvió todavía,
  // el botón queda deshabilitado igual (no se sabe con certeza el estado
  // real) en vez de arrancar habilitado y deshabilitarse un instante
  // después. Esta es solo la barrera de UI — la AUTORITATIVA es
  // `backend/src/ws/handlers.js#handleStartClass`, que revalida lo mismo
  // (`documentService.isDocumentReadyForMeeting`) sin importar qué haga
  // este botón.
  const startClassDisabled =
    submitting ||
    !wsConnected ||
    !attentionModeChosenManually ||
    documentUpload.loadingCurrent ||
    !documentUpload.hasValidDocument;

  // Motivos distintos por los que "Comenzar Clase" puede seguir
  // deshabilitado — se distinguen para que el docente sepa exactamente qué
  // esperar (nunca el mismo texto genérico para todos). El modo de clase se
  // chequea PRIMERO (pedido explícito — es el primer paso de la pantalla,
  // arriba de subir el material): si todavía no se eligió, ni siquiera hace
  // falta mirar el estado del documento.
  let startClassBlockedMessage = null;
  if (!attentionModeChosenManually) {
    startClassBlockedMessage = 'Elegí un modo de clase para poder empezar.';
  } else if (!documentUpload.loadingCurrent && !documentUpload.hasValidDocument) {
    const analysisStatus = documentUpload.currentDocument?.analysisStatus;
    if (!documentUpload.currentDocument) {
      startClassBlockedMessage = 'Subí el material de la clase para poder empezar.';
    } else if (analysisStatus === 'failed') {
      startClassBlockedMessage = 'El análisis del material falló — reemplazalo para volver a intentar.';
    } else {
      startClassBlockedMessage = 'Esperando a que termine de procesarse el documento.';
    }
  }

  // Aviso DISTINTO del de arriba — nunca bloquea nada, el botón ya está
  // habilitado en este caso: `hasValidDocument` solo exige
  // `analysisStatus === 'processed'` (ver `hooks/useDocumentUpload.js`),
  // no que el resumen con IA haya encontrado temas. Un documento
  // procesado sin `mainTopics` (flag de IA apagado, o falló la llamada a
  // OpenAI — ver el `catch` dedicado en `documentAnalysisService.
  // analyzeDocument`, que igual persiste el texto extraído) es un estado
  // VÁLIDO para arrancar — se avisa de entrada para que no sea una
  // sorpresa, con el mismo tono neutral que `sparkle-text` (sin
  // `-warning`/`-error`): no es un problema de la app.
  const missingSummaryNotice =
    documentUpload.hasValidDocument && !documentUpload.currentDocument?.analysis?.mainTopics?.length
      ? 'Vas a arrancar la clase sin los temas identificados del material — el resumen no está disponible para este documento.'
      : null;

  return (
    // Rediseño (pedido explícito) — mismo shell de 3 franjas que ya usa la
    // vista de "clase en curso"/`ConcentrationStats.jsx`/`GenerateQuestion.jsx`
    // (`sparkle-screen--live`, ver `styles/panel.css`): topbar fija arriba,
    // contenido con scroll propio en el medio, "Comenzar Clase" fijo abajo
    // — así el botón queda SIEMPRE visible sin importar cuánto crezca el
    // selector de modo o el bloque de material, en vez del `.sparkle-screen`
    // de una sola columna que scrollea entero (el nombre de la clase
    // modificadora es histórico — ya se reutiliza en varias pantallas que no
    // representan "clase en curso").
    <div className="sparkle-screen sparkle-screen--live">
      <div className="sparkle-panel-topbar">
        <div className="sparkle-screen-head">
          <h1 className="sparkle-title">Sparkle V2</h1>
          <p className="sparkle-subtitle">Preparé el material y arrancá la clase cuando quieras.</p>
        </div>
      </div>

      <div className="sparkle-scroll-area">
        {/* Corrección — "Ver estadísticas de atención" ya NO vive en esta
            pantalla previa a "Comenzar Clase": solo tiene sentido con la
            clase REALMENTE activa (`classStarted`), ver el botón equivalente
            (condicionado a `isActive`) dentro de la vista `classStarted ||
            classResumable`, más arriba. */}
        {/* Elegí el modo de clase ANTES de "Comenzar Clase" (pedido
            explícito) — arriba de subir el material, primero lo primero, y
            ahora OBLIGATORIO (ver `attentionModeChosenManually` más arriba). Una
            vez que la clase arranca, esta pantalla entera desaparece (ver
            la vista `classStarted || classResumable`, más arriba) — no hace
            falta bloquear el `<select>` en sí, deja de existir. */}
        <AttentionModeSelector
          modeId={attentionModeId}
          chosen={attentionModeChosenManually}
          onChange={handleAttentionModeSelectChange}
        />

        {/* Corrección — "Generar pregunta" NO va acá: esta es la pantalla
            previa a arrancar la clase (antes de "Comenzar Clase"). Solo
            queda disponible una vez que el docente ya está en el panel
            principal de la clase — en curso o detenida (ver el botón
            equivalente en el `sparkle-sticky-footer` de la vista
            `classStarted || classResumable`, más arriba) — nunca acá. */}
        <DocumentUploadBlock
          currentDocument={documentUpload.currentDocument}
          loadingCurrent={documentUpload.loadingCurrent}
          loadError={documentUpload.loadError}
          selectedFile={documentUpload.selectedFile}
          validationError={documentUpload.validationError}
          status={documentUpload.status}
          uploadError={documentUpload.uploadError}
          onSelectFile={documentUpload.selectFile}
          onCancelSelection={documentUpload.cancelSelection}
          onConfirmUpload={documentUpload.confirmUpload}
        />
      </div>

      <div className="sparkle-sticky-footer">
        {startClassBlockedMessage && (
          <p className="sparkle-text sparkle-text-warning">
            <AlertTriangleIcon size={14} /> {startClassBlockedMessage}
          </p>
        )}
        {missingSummaryNotice && (
          <p className="sparkle-text">
            <InfoIcon size={14} /> {missingSummaryNotice}
          </p>
        )}
        {startClassError && (
          <p className="sparkle-text sparkle-text-error">
            <AlertTriangleIcon size={14} /> {startClassError}
          </p>
        )}
        <button
          className="sparkle-button sparkle-button-primary"
          onClick={handleStartClass}
          disabled={startClassDisabled}
          aria-disabled={startClassDisabled}
          title={startClassBlockedMessage || undefined}
        >
          <PlayIcon size={17} />
          Comenzar Clase
        </button>
        {reportDownloadButton}
      </div>
    </div>
  );
}
