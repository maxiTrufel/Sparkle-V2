import { useEffect, useRef, useState } from 'react';
import { ClockIcon, CheckIcon, NotesIcon, CloseIcon, AlertTriangleIcon, QuestionIcon } from '../ui/icons';
import ClassSummary from './ClassSummary';
import RecoverySummary from './RecoverySummary';
import FinalQuiz from './FinalQuiz';
import ClassPausedCard from '../ui/ClassPausedCard';
import TimerProgressBar from '../ui/TimerProgressBar';
import { answerQuestion, skipQuestion, getMyQuestionAnswers } from '../services/backendMessaging';
import { useCountdown } from '../hooks/useCountdown';
import { withTimeout } from '../utils/withTimeout';

// Corrección — mismo motivo que en `TeacherPanel.jsx`: sin un límite propio,
// un pedido REST que se cuelga (conexión zombie del lado del backend, ver
// el comentario de `enableKeepAlive` en `backend/src/db.js`) dejaba
// `answeredHistoryLoading` en `true` para siempre.
const HISTORY_QUERY_TIMEOUT_MS = 8000;

// Se muestra cuando el rol ya está resuelto para esta reunión puntual —
// sin link de "Cambiar de rol": una vez elegido el rol para esta reunión,
// queda fijo (ver DOCUMENTACION.md, Etapa 17).
//
// `classStarted` (Etapa 44) lo decide App.jsx a partir de dos eventos WS
// distintos, pero acá el componente no necesita saber cuál de los dos fue
// — solo se refleja el estado resultante (el badge "Clase en curso" de
// abajo). Con `classStarted=true` desde el primer render (el caso de "me
// uno y ya estaba activa"), este componente nunca llega a mostrar la
// tarjeta de espera.
//
// `endNotice` (Etapa 46): App.jsx pide mostrar el aviso de "clase
// detenida" EN EL PANEL — Ajuste UI: ese aviso y el de "todavía no vi
// ninguna clase" (más abajo, el branch `else`) se unificaron en un único
// componente, `ui/ClassPausedCard.jsx`. Etapa 60 — a propósito NO se apaga
// solo con un timer: queda fijo hasta que un evento REAL lo cambie (el
// docente inicia o reanuda la clase, ver App.jsx). Ajuste post-entrega:
// ya no va acompañado de ningún alert() nativo — este aviso EN EL PANEL es
// la única señal, sin ningún diálogo bloqueante aparte.
//
// Preguntas en tiempo real — `activeQuestion`/`myAnswerState` vienen de
// `hooks/useLiveQuestions.js` (vía App.jsx): reemplazan por completo al
// viejo botón "Simular pregunta" y su `SimulatedQuestionModal` con datos
// hardcodeados. El modal ahora se abre SOLO (sin ningún botón que lo
// dispare) apenas llega una pregunta real por WebSocket, y "Prefiero no
// responder" sigue pidiendo la misma confirmación que ya existía acá.
export default function StudentPanel({
  meetingCode,
  email,
  classStarted,
  endNotice,
  activeQuestion,
  myAnswerState,
  finishedQuestion,
  clearFinishedQuestion,
  answerError,
  clearAnswerError,
  requestRecoverySummarySignal = 0,
}) {
  const [showingSummary, setShowingSummary] = useState(false);
  // "Recuperar contenido" — mismo patrón de señal que
  // `requestGenerateQuestionSignal` en `TeacherPanel.jsx`: un contador que
  // SOLO avanza ante una acción real (acá, apretar "Recuperar contenido" en
  // `ui/FatigueAlert.jsx`, ver `handleRecuperarContenidosPerdidos` en
  // `App.jsx`), nunca en el render inicial — así este panel puede abrirse
  // DIRECTO en la pantalla de recuperación desde un botón que vive FUERA de
  // `.sparkle-panel` (la alerta flotante), sin que `App.jsx` tenga que
  // conocer el estado interno de este componente.
  const [showingRecoverySummary, setShowingRecoverySummary] = useState(false);

  useEffect(() => {
    if (!requestRecoverySummarySignal) return;
    setShowingRecoverySummary(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestRecoverySummarySignal]);

  // "Quiz final" — el estado del quiz vive ACÁ y no en `FinalQuiz.jsx`, para
  // que "Volver" y entrar de nuevo muestre el mismo quiz con lo ya respondido
  // (ver ese archivo). Nada se guarda en la base. Se descarta cuando arranca
  // una clase nueva: un quiz de la clase anterior ya no corresponde.
  const [showingFinalQuiz, setShowingFinalQuiz] = useState(false);
  const [finalQuizState, setFinalQuizState] = useState(null);

  useEffect(() => {
    if (!classStarted) return;
    setShowingFinalQuiz(false);
    setFinalQuizState(null);
  }, [classStarted]);

  // Historial REAL de preguntas respondidas — "Preguntas respondidas" (ver
  // `backend/src/services/questionService.getAnsweredQuestionsForStudent`).
  // Nada hardcodeado: se pide por REST al montar/cambiar de reunión, y de
  // nuevo cada vez que una pregunta termina (`finishedQuestion`) — la base
  // de datos sigue siendo la fuente de verdad. `requestIdRef` descarta una
  // respuesta vieja si un pedido más nuevo ya está en vuelo.
  //
  // Ese endpoint SOLO devuelve preguntas ya FINALIZADAS — así que, por sí
  // solo, deja a la respuesta recién dada por el alumno invisible hasta
  // que la pregunta termina. `optimisticEntry` (más abajo) es lo que cubre
  // ese hueco: una entrada LOCAL que aparece apenas llega
  // "answer_accepted" — Corrección: YA CON el diseño final (correcta/
  // incorrecta + respuesta correcta), nunca un estado "pendiente"
  // intermedio, porque el propio "answer_accepted" ya trae
  // `correctOptionIndex` (ver `hooks/useLiveQuestions.js` — se revela
  // recién DESPUÉS de que la respuesta de este alumno ya quedó grabada sin
  // vuelta atrás, nunca antes). Se descarta sola en cuanto la entrada
  // equivalente ya está en la lista real de `answeredQuestionsHistory`
  // (evita el duplicado); si llega "question_finished" mientras tanto, solo
  // reconcilia datos — visualmente la tarjeta no cambia.
  const [answeredQuestionsHistory, setAnsweredQuestionsHistory] = useState([]);
  const [answeredHistoryLoading, setAnsweredHistoryLoading] = useState(true);
  const [answeredHistoryError, setAnsweredHistoryError] = useState(null);
  const answeredHistoryRequestIdRef = useRef(0);

  function loadAnsweredHistoryNow() {
    // Corrección — mismo criterio que `TeacherPanel.jsx`: nunca deja
    // `answeredHistoryLoading` colgado en `true` si faltan datos.
    if (!meetingCode || !email) {
      setAnsweredHistoryLoading(false);
      return;
    }
    const requestId = (answeredHistoryRequestIdRef.current += 1);
    setAnsweredHistoryLoading(true);
    setAnsweredHistoryError(null);
    withTimeout(
      getMyQuestionAnswers(meetingCode, email),
      HISTORY_QUERY_TIMEOUT_MS,
      'Se agotó el tiempo de espera cargando las preguntas realizadas.'
    )
      .then((result) => {
        if (answeredHistoryRequestIdRef.current !== requestId) return;
        if (result?.error) throw new Error(result.error);
        setAnsweredQuestionsHistory(result?.answers || []);
      })
      .catch((err) => {
        if (answeredHistoryRequestIdRef.current !== requestId) return;
        setAnsweredHistoryError(`No se pudieron cargar tus preguntas respondidas: ${err.message}`);
      })
      .finally(() => {
        if (answeredHistoryRequestIdRef.current !== requestId) return;
        setAnsweredHistoryLoading(false);
      });
  }

  useEffect(() => {
    loadAnsweredHistoryNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingCode, email]);

  // Entrada LOCAL/optimista de la pregunta que este alumno está respondiendo
  // (o acaba de terminar de responder) — ver el comentario de arriba.
  // `myChoiceRef` guarda el índice elegido (el servidor nunca lo reenvía,
  // solo confirma correcta/incorrecta/saltada) — lo pone `LiveQuestionModal`
  // vía `onAnswered`, apenas el propio envío tiene éxito.
  const [optimisticEntry, setOptimisticEntry] = useState(null);
  const myChoiceRef = useRef(null);

  useEffect(() => {
    myChoiceRef.current = null;
  }, [activeQuestion?.id]);

  // Apenas el servidor confirma la respuesta/salto ("answer_accepted",
  // reflejado acá como `myAnswerState`), se arma la entrada YA FINAL —
  // `myAnswerState.correctOptionIndex` viaja desde ese mismo mensaje (ver
  // `hooks/useLiveQuestions.js`), así que no hace falta esperar a
  // "question_finished" para saber si acertó ni cuál era la correcta.
  useEffect(() => {
    if (!activeQuestion || !myAnswerState) return;
    if (!myAnswerState.answered && !myAnswerState.skipped) return;
    setOptimisticEntry({
      id: activeQuestion.id,
      prompt: activeQuestion.prompt,
      options: activeQuestion.options,
      selectedOptionIndex:
        myAnswerState.skipped || myChoiceRef.current?.questionId !== activeQuestion.id
          ? null
          : myChoiceRef.current.selectedIndex,
      skipped: myAnswerState.skipped,
      isCorrect: myAnswerState.isCorrect,
      correctOptionIndex: myAnswerState.correctOptionIndex,
    });
  }, [activeQuestion, myAnswerState]);

  // "question_finished" ya no cambia la tarjeta visualmente (la entrada
  // optimista ya estaba completa desde "answer_accepted") — solo dispara
  // el refetch real, que es quien de verdad reconcilia contra la base de
  // datos (fuente de verdad) y, de paso, hace que la copia optimista se
  // descarte sola apenas la fila real aparece (ver el efecto siguiente).
  useEffect(() => {
    if (!finishedQuestion) return;
    loadAnsweredHistoryNow();
    clearFinishedQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedQuestion]);

  // Apenas el refetch trae la versión REAL de esta pregunta, se descarta la
  // copia optimista — evita mostrar la misma pregunta dos veces.
  useEffect(() => {
    if (optimisticEntry && answeredQuestionsHistory.some((e) => e.id === optimisticEntry.id)) {
      setOptimisticEntry(null);
    }
  }, [answeredQuestionsHistory, optimisticEntry]);

  // Normaliza tanto la entrada optimista (local) como una fila real de la
  // base a la misma forma de render — un único componente
  // (`AnsweredQuestionCard`, más abajo) consume el resultado sin saber de
  // dónde vino cada una. Corrección — la fila REAL (REST) ya trae `status`
  // ('correct'/'incorrect'/'skipped'/'unanswered') resuelto server-side
  // (ver `questionService.toStudentHistoryEntry`, backend); la entrada
  // LOCAL/optimista nunca llega a ser 'unanswered' (solo se arma cuando el
  // propio alumno respondió o saltó, ver más arriba), así que para esa
  // sigue haciendo falta derivarlo de `isCorrect`/`skipped`.
  function toEntryView(entry) {
    const status = entry.status || (entry.skipped ? 'skipped' : entry.isCorrect ? 'correct' : 'incorrect');
    const selectedAnswer =
      status !== 'skipped' && status !== 'unanswered' && entry.selectedOptionIndex != null
        ? entry.options[entry.selectedOptionIndex]
        : null;
    const correctAnswer = entry.correctOptionIndex != null ? entry.options[entry.correctOptionIndex] : null;
    return { id: entry.id, prompt: entry.prompt, status, selectedAnswer, correctAnswer };
  }

  // El `.some(...)` de acá (no solo el efecto de arriba) evita una key de
  // React duplicada durante el único render en que ambas fuentes todavía
  // coexisten: el efecto que descarta `optimisticEntry` corre DESPUÉS de
  // este render, así que sin este chequeo acá mismo, por un instante la
  // lista tendría dos entradas con el mismo `id`.
  const historyEntries = [
    ...(optimisticEntry && !answeredQuestionsHistory.some((e) => e.id === optimisticEntry.id)
      ? [toEntryView(optimisticEntry)]
      : []),
    ...answeredQuestionsHistory.map(toEntryView),
  ];

  const answeredHistory = (
    <div>
      {/* Corrección — antes decía "Preguntas respondidas": ahora la lista
          trae TODAS las preguntas finalizadas de la clase (respondidas,
          salteadas o nunca respondidas — ver `toEntryView` arriba), así
          que ese título dejó de describir lo que muestra. */}
      <p className="sparkle-section-label">Preguntas realizadas</p>

      {answeredHistoryLoading && historyEntries.length === 0 && (
        <p className="sparkle-text">Cargando preguntas realizadas…</p>
      )}
      {!answeredHistoryLoading && answeredHistoryError && (
        <div className="sparkle-inline-error">
          <p className="sparkle-text sparkle-text-error">{answeredHistoryError}</p>
          <button
            type="button"
            className="sparkle-button sparkle-button-secondary sparkle-button-compact"
            onClick={loadAnsweredHistoryNow}
          >
            Reintentar
          </button>
        </div>
      )}

      {!answeredHistoryLoading && !answeredHistoryError && historyEntries.length === 0 && (
        <p className="sparkle-text">Todavía no se realizó ninguna pregunta en esta clase.</p>
      )}

      {historyEntries.length > 0 && (
        <div className="sparkle-answered-list">
          {historyEntries.map((entry) => (
            <AnsweredQuestionCard key={entry.id} {...entry} />
          ))}
        </div>
      )}
    </div>
  );

  if (showingRecoverySummary) {
    return (
      <RecoverySummary
        onBack={() => setShowingRecoverySummary(false)}
        meetingCode={meetingCode}
        email={email}
      />
    );
  }

  if (showingSummary) {
    return <ClassSummary onBack={() => setShowingSummary(false)} meetingCode={meetingCode} email={email} />;
  }

  if (showingFinalQuiz) {
    return (
      <FinalQuiz
        onBack={() => setShowingFinalQuiz(false)}
        meetingCode={meetingCode}
        email={email}
        quizState={finalQuizState}
        onQuizStateChange={setFinalQuizState}
      />
    );
  }

  // Corrección — la pregunta en vivo (modal, tarjeta de "ya respondiste",
  // historial) ya NO depende de `classStarted`/`endNotice`: antes vivían
  // ANIDADOS dentro de `if (classStarted) { ... }`, así que un alumno con
  // la clase "detenida" (`endNotice`, o incluso el estado idle de "nunca
  // vi una clase") no podía ver ni responder una pregunta que el docente
  // sí puede enviar en esos mismos estados (ver `backend/src/services/
  // questionService.createAndStartQuestion` — no valida el estado de la
  // clase a propósito). Acá abajo solo se arma `statusHeader` (lo único
  // que SÍ cambia según el estado de la clase); todo lo relacionado a la
  // pregunta en vivo se arma una sola vez, más abajo, y se agrega SIEMPRE
  // al final — la única condición real para mostrarlo es `activeQuestion`.
  let statusHeader;
  if (classStarted) {
    statusHeader = (
      <>
        <div className="sparkle-student-status-row">
          <span className="sparkle-class-status-badge sparkle-class-status-badge--active">
            <span className="sparkle-class-status-dot" />
            Clase en curso
          </span>
        </div>

        {/* Ajuste post-entrega — "Prestá atención" pasó de texto secundario
            junto al badge a esta alerta propia (solo visible con la clase
            en curso; desaparece con la clase detenida, donde ya no hay
            nada que atender). */}
        <div className="sparkle-attention-alert">
          <span className="sparkle-attention-alert-icon">
            <AlertTriangleIcon size={16} />
          </span>
          <div className="sparkle-attention-alert-text">
            <span className="sparkle-attention-alert-title">Prestá atención</span>
            <span className="sparkle-attention-alert-subtitle">El docente está explicando un tema.</span>
          </div>
        </div>
      </>
    );
  } else if (endNotice) {
    // Único caso con acción disponible — "Obtener resumen de la clase" solo
    // tiene sentido cuando realmente hubo una clase que se detuvo (nunca en
    // el branch `else`, donde no hubo ninguna clase todavía).
    statusHeader = (
      <ClassPausedCard>
        <button type="button" className="sparkle-button sparkle-button-primary" onClick={() => setShowingSummary(true)}>
          <NotesIcon size={17} />
          Obtener resumen de la clase
        </button>
        <button type="button" className="sparkle-button sparkle-button-secondary" onClick={() => setShowingFinalQuiz(true)}>
          <QuestionIcon size={17} />
          Realizar quiz final
        </button>
      </ClassPausedCard>
    );
  } else {
    statusHeader = <ClassPausedCard />;
  }

  return (
    <div className="sparkle-screen">
      {statusHeader}

      {/* Corrección — se eliminó el cartel "Ya respondiste esta pregunta.
          Esperá a que el docente la finalice." (y sus variantes de
          correcta/saltada), sin reemplazo. Ya no hace falta: apenas el
          alumno responde, `answeredHistory` (más abajo) muestra de una la
          tarjeta FINAL — correcta/incorrecta, con la respuesta correcta —
          así que ese cartel quedaba mostrando información redundante (y
          más pobre: sin la opción correcta) al lado de la tarjeta real. */}

      {answeredHistory}

      {activeQuestion && !(myAnswerState?.answered || myAnswerState?.skipped) && (
        <LiveQuestionModal
          meetingCode={meetingCode}
          email={email}
          question={activeQuestion}
          answerError={answerError}
          onClearAnswerError={clearAnswerError}
          onAnswered={(selectedIndex) => {
            myChoiceRef.current = { questionId: activeQuestion.id, selectedIndex };
          }}
        />
      )}
    </div>
  );
}

// Tarjeta de UNA pregunta realizada — ÚNICO componente, tanto para la
// entrada LOCAL/optimista (recién respondida, pregunta todavía activa)
// como para una fila real ya confirmada por la base de datos: ambas se
// normalizan a esta misma forma en `toEntryView`, más arriba, así que este
// componente no sabe ni le importa de cuál de las dos vino — nunca hay dos
// diseños distintos. `status` es 'correct' | 'incorrect' | 'skipped' |
// 'unanswered'. Corrección — se agregó 'unanswered' (el alumno nunca
// interactuó: venció el tiempo, o nunca llegó a abrirla): SOLO cambia qué
// badge/texto se muestra, nunca la estructura de la tarjeta en sí — mismo
// criterio que ya regía para 'skipped' vs. 'correct'/'incorrect'.
function AnsweredQuestionCard({ prompt, status, selectedAnswer, correctAnswer }) {
  return (
    <div className={`sparkle-answered-card sparkle-answered-card--${status}`}>
      <div className="sparkle-answered-card-head">
        <p className="sparkle-answered-card-prompt">{prompt}</p>
        {status === 'correct' && (
          <span className="sparkle-badge-correct">
            <CheckIcon size={11} />
            Correcta
          </span>
        )}
        {status === 'incorrect' && (
          <span className="sparkle-badge-incorrect">
            <CloseIcon size={10} />
            Incorrecta
          </span>
        )}
        {status === 'skipped' && (
          <span className="sparkle-badge-neutral">
            <ClockIcon size={11} />
            No respondió
          </span>
        )}
        {status === 'unanswered' && (
          <span className="sparkle-badge-neutral">
            <ClockIcon size={11} />
            Sin responder
          </span>
        )}
      </div>

      {status === 'correct' && (
        <p className="sparkle-answered-card-line">
          <span className="sparkle-answered-card-label">Tu respuesta:</span>
          <span className="sparkle-answered-card-value sparkle-answered-card-value--right">{selectedAnswer}</span>
        </p>
      )}

      {status === 'incorrect' && (
        <>
          <p className="sparkle-answered-card-line">
            <span className="sparkle-answered-card-label">Tu respuesta:</span>
            <span className="sparkle-answered-card-value sparkle-answered-card-value--wrong">{selectedAnswer}</span>
          </p>
          <p className="sparkle-answered-card-line">
            <span className="sparkle-answered-card-label">Respuesta correcta:</span>
            <span className="sparkle-answered-card-value sparkle-answered-card-value--right">{correctAnswer}</span>
          </p>
        </>
      )}

      {status === 'skipped' && (
        <>
          <p className="sparkle-answered-card-line">Elegiste no responder.</p>
          <p className="sparkle-answered-card-line">
            <span className="sparkle-answered-card-label">Respuesta correcta:</span>
            <span className="sparkle-answered-card-value sparkle-answered-card-value--right">{correctAnswer}</span>
          </p>
        </>
      )}

      {status === 'unanswered' && (
        <>
          <p className="sparkle-answered-card-line">No respondiste esta pregunta.</p>
          <p className="sparkle-answered-card-line">
            <span className="sparkle-answered-card-label">Respuesta correcta:</span>
            <span className="sparkle-answered-card-value sparkle-answered-card-value--right">{correctAnswer}</span>
          </p>
        </>
      )}
    </div>
  );
}

// Modal de pregunta en vivo — se abre automáticamente (nunca por un botón)
// apenas `activeQuestion` deja de ser `null` en el componente de arriba.
// `question.localExpiresAt` ya viene corregido a reloj LOCAL, calculado UNA
// SOLA VEZ por `hooks/useLiveQuestions.js` (`withLocalExpiry`) apenas llega
// cada mensaje — nunca se recalcula acá en cada render (ese era el bug: el
// contador no bajaba). La cuenta regresiva en sí es solo visual: el
// servidor rechaza cualquier respuesta tardía sin importar qué muestre este
// contador (ver `services/questionService.js`, `loadActiveQuestionForAnswer`).
function LiveQuestionModal({ meetingCode, email, question, answerError, onClearAnswerError, onAnswered }) {
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Error de CONEXIÓN (el mensaje nunca llegó a salir por el socket) —
  // distinto de `answerError` (rechazo del SERVIDOR, viene del hook
  // `useLiveQuestions` vía el padre), pero ambos se muestran igual acá
  // abajo y ambos permiten reintentar.
  const [localError, setLocalError] = useState(null);

  const secondsLeft = useCountdown(question.localExpiresAt);
  const timedOut = secondsLeft <= 0;
  // Corrección — ya NO existe un estado "submitted" separado: antes se
  // marcaba `true` de forma OPTIMISTA apenas el mensaje salía por el
  // socket, sin importar qué contestara el servidor después. Si el
  // servidor terminaba rechazando la respuesta (`answer_rejected` —
  // ej. alguien ya había respondido antes, o venció justo en el medio),
  // el modal quedaba mostrando "Respuesta enviada." para siempre, sin
  // ninguna forma de reintentar. Ahora el único estado real es
  // `submitting` (en vuelo); el ÉXITO lo señala el componente PADRE
  // desmontando este modal apenas `myAnswerState` confirma del lado del
  // servidor — mientras eso no pase, el intento sigue siendo reintentable.
  const locked = timedOut || submitting;

  // Un rechazo del servidor reactiva el intento — nunca deja al alumno
  // "trabado" sin poder volver a mandar la respuesta mientras la pregunta
  // siga activa.
  useEffect(() => {
    if (answerError) setSubmitting(false);
  }, [answerError]);

  const handleSubmit = async () => {
    if (locked) return;
    // Nunca se manda una opción null/undefined/inexistente — el botón ya
    // queda deshabilitado sin una selección válida (ver más abajo), pero
    // se revalida acá explícitamente antes de tocar la red.
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= question.options.length) return;
    setSubmitting(true);
    setLocalError(null);
    onClearAnswerError();
    try {
      await answerQuestion(meetingCode, email, question.id, selectedIndex);
      onAnswered(selectedIndex);
      // No se toca `submitting` acá: sigue en `true` (botón deshabilitado,
      // "Enviando…") hasta que el padre desmonte este modal al confirmar
      // `myAnswerState`, o hasta que llegue un rechazo (ver el efecto de
      // arriba, que sí lo apaga).
    } catch (err) {
      setSubmitting(false);
      setLocalError(err.message);
    }
  };

  const handleConfirmSkip = async () => {
    setConfirmingSkip(false);
    setSubmitting(true);
    setLocalError(null);
    onClearAnswerError();
    try {
      await skipQuestion(meetingCode, email, question.id);
      // idem arriba — el padre desmonta el modal apenas confirma.
    } catch (err) {
      setSubmitting(false);
      setLocalError(err.message);
    }
  };

  const displayedError = answerError || localError;

  return (
    <>
      <div className="sparkle-confirm-backdrop">
        <div className="sparkle-simulated-question-dialog" role="dialog" aria-modal="true">
          <span className="sparkle-question-card-eyebrow">Pregunta en vivo</span>

          <div className="sparkle-generate-head">
            <h2 className="sparkle-generate-title">{question.prompt}</h2>
            <div className="sparkle-timer-ring" aria-label={`${secondsLeft} segundos restantes`}>
              <svg viewBox="0 0 40 40">
                <circle className="sparkle-timer-ring-track" cx="20" cy="20" r="16" />
                <circle
                  className="sparkle-timer-ring-progress"
                  cx="20"
                  cy="20"
                  r="16"
                  style={{
                    strokeDasharray: 2 * Math.PI * 16,
                    strokeDashoffset: 2 * Math.PI * 16 * (1 - Math.min(secondsLeft / question.durationSeconds, 1)),
                  }}
                />
              </svg>
              <span className="sparkle-timer-ring-label">{secondsLeft}s</span>
            </div>
          </div>

          {/* Refuerzo visual del mismo conteo del anillo (mismo
              `secondsLeft`/`question.durationSeconds`, nunca un segundo
              timer) — componente COMPARTIDO con la tarjeta del docente
              (`ui/TimerProgressBar.jsx`): misma lógica de umbrales de color
              y pulso en los dos lados, un solo lugar para mantenerla. */}
          <TimerProgressBar
            remainingSeconds={secondsLeft}
            totalSeconds={question.durationSeconds}
            size="md"
            label={`${secondsLeft} segundos restantes`}
          />

          <div className="sparkle-option-list">
            {question.options.map((option, index) => (
              <button
                type="button"
                key={option}
                className={`sparkle-option ${selectedIndex === index ? 'sparkle-option--picked' : ''}`}
                onClick={() => setSelectedIndex(index)}
                disabled={locked}
              >
                <span className="sparkle-option-marker">{String.fromCharCode(65 + index)}</span>
                {option}
              </button>
            ))}
          </div>

          {displayedError && <p className="sparkle-text sparkle-text-error">{displayedError}</p>}

          {timedOut ? (
            <p className="sparkle-text">Se acabó el tiempo para responder.</p>
          ) : (
            <>
              {/* Deshabilitado sin ninguna opción elegida (estado inicial),
                  se habilita al seleccionar y sigue habilitado si cambia
                  de opción (ambos casos: `selectedIndex !== null`); se
                  deshabilita de nuevo mientras se envía o si venció el
                  tiempo (`locked`). Un rechazo del servidor apaga
                  `submitting` (ver el efecto más arriba) y reactiva el
                  botón para reintentar, sin perder la opción ya elegida. */}
              <button
                type="button"
                className="sparkle-button sparkle-button-primary"
                disabled={selectedIndex === null || locked}
                onClick={handleSubmit}
              >
                {submitting ? 'Enviando…' : 'Enviar respuesta'}
              </button>
              <button
                type="button"
                className="sparkle-button sparkle-button-secondary"
                disabled={locked}
                onClick={() => setConfirmingSkip(true)}
              >
                Prefiero no responder
              </button>
            </>
          )}
        </div>
      </div>

      {confirmingSkip && (
        <div className="sparkle-confirm-backdrop">
          <div className="sparkle-confirm-dialog" role="alertdialog" aria-modal="true">
            <h2 className="sparkle-confirm-title">No responder</h2>
            <p className="sparkle-confirm-text">¿Estás seguro de que no querés responder esta pregunta?</p>
            <div className="sparkle-confirm-actions">
              <button type="button" className="sparkle-button sparkle-button-primary" onClick={handleConfirmSkip}>
                No responder
              </button>
              <button
                type="button"
                className="sparkle-button sparkle-button-secondary"
                onClick={() => setConfirmingSkip(false)}
              >
                Volver a la pregunta
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
