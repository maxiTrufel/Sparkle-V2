import { useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, CheckIcon } from '../ui/icons';
import { generateQuestion as fetchGeneratedQuestion, sendQuestion } from '../services/backendMessaging';

// Reemplaza al viejo modal (Ajuste post-entrega: se pidió una pantalla propia
// que se navega, no un overlay) — mismo criterio de "screen swap" que ya usa
// `StudentHistory.jsx` dentro de `TeacherPanel.jsx`: mientras esta pantalla
// está montada, reemplaza por completo al resto del panel, con su propio
// "Volver" arriba de todo (mismo patrón/clase compartida que el resto del
// sistema, ver Ajuste 1 en `styles/panel.css`).
// Corrección — únicas duraciones que se pueden elegir: sin campo de
// duración a medida (eliminado). El backend valida el mismo conjunto exacto
// (`ALLOWED_DURATION_SECONDS` en `questionService.validateQuestionInput`),
// así que no hay forma de enviar una pregunta con otra duración aunque se
// manipule el mensaje WS a mano.
const TIME_PRESETS = [15, 30, 45, 60];
const DEFAULT_SECONDS = 30;
const TIMER_RADIUS = 16;
const TIMER_CIRCUMFERENCE = 2 * Math.PI * TIMER_RADIUS;
// Referencia para el llenado del anillo: el preset más largo (60s) llena el
// anillo por completo — como ya no hay ningún valor por encima de ese
// (los cuatro presets son las únicas duraciones posibles), el `Math.min(...,
// 1)` de `ringFraction` es un tope puramente defensivo, nunca se llega a
// activar en los hechos.
const MAX_RING_SECONDS = 60;

// Preguntas en tiempo real — la pregunta que se muestra acá NUNCA es un
// mock hardcodeado: sale de `questionService.generatePreview` (banco fijo
// random, o generada con IA a partir del resumen del documento +
// transcripción si `ENABLE_AI_QUESTION_GENERATION` está activo — ver
// `backend/src/services/questionService.js`) vía `generateQuestion()`
// (REST, sin persistir — ver `services/api.js`). "Generar otra pregunta"
// vuelve a pedir una nueva; "Enviar pregunta" recién ahí la persiste y la
// emite por WebSocket (`sendQuestion`, ver `backend/src/ws/handlers.js`,
// `handleSendQuestion`).
//
// Ajuste post-entrega — "Generar pregunta" se puede abrir con la clase en
// curso O detenida (para preparar preguntas con anticipación), pero esta
// pantalla ya NO distingue entre ambos casos: mismo diseño y flujo siempre,
// sin avisos ni textos que cambien según el estado de la clase.
export default function GenerateQuestion({
  meetingCode,
  email,
  activeQuestion,
  questionSendError,
  clearQuestionSendError,
  onBack,
  onQuestionSent,
}) {
  const [seconds, setSeconds] = useState(DEFAULT_SECONDS);
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [previewError, setPreviewError] = useState(null);
  // 'idle' | 'sending' | 'error' — "enviada" no necesita un estado propio:
  // apenas el envío tiene éxito se vuelve automáticamente al panel del
  // docente (ver el efecto de abajo), donde ya se ve la pregunta en vivo
  // (`LiveQuestionStats.jsx`).
  const [sendStatus, setSendStatus] = useState('idle');
  // Evita procesar un "activeQuestion" que ya estaba activo ANTES de entrar
  // a esta pantalla (ej. el docente reabre "Generar pregunta" mientras una
  // pregunta anterior sigue en curso) como si fuera la confirmación del
  // envío que se acaba de hacer acá.
  const activeQuestionIdBeforeSendRef = useRef(activeQuestion?.id ?? null);
  // Error de CONEXIÓN (el mensaje nunca llegó a salir por el socket, ver
  // `services/wsClient.js`) — distinto de `questionSendError` (rechazo del
  // SERVIDOR, viene del hook `useLiveQuestions`), pero ambos se muestran
  // igual acá abajo.
  const [localSendError, setLocalSendError] = useState(null);
  // Evita dos problemas de limpieza (mismo criterio que
  // `useInitialRoleResolution.js`): (a) `setState` después de desmontar el
  // componente (ej. el docente aprieta "Volver" mientras el fetch sigue en
  // vuelo) y (b) una respuesta VIEJA pisando a una más nueva si "Generar
  // otra pregunta" se clickea rápido más de una vez — `requestIdRef` solo
  // aplica el resultado del pedido más reciente.
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  // Enunciados de los previews que YA se generaron y descartaron en esta
  // tanda (sin llegar a enviar ninguno) — se acumulan acá y se mandan en
  // cada pedido nuevo, para que el proveedor de IA no repita tema (ver
  // `backend/src/services/questionService.generatePreview`,
  // `discardedPrompts`). `getRecentPromptsForMeeting` en el backend solo
  // ve preguntas YA ENVIADAS: sin esto, pedir "otra pregunta" varias veces
  // seguidas sin enviar ninguna le mandaba a OpenAI el MISMO contexto cada
  // vez, y el modelo convergía en el mismo tema. Un `ref` (no `useState`)
  // porque no necesita disparar un re-render por sí solo — solo importa su
  // valor en el momento de armar el próximo pedido.
  const discardedPromptsRef = useRef([]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const loadPreview = () => {
    const requestId = (requestIdRef.current += 1);
    setLoadingPreview(true);
    setPreviewError(null);
    fetchGeneratedQuestion(meetingCode, email, discardedPromptsRef.current)
      .then((data) => {
        if (!mountedRef.current || requestIdRef.current !== requestId) return;
        // Antes de la generación con IA, este pedido nunca fallaba de
        // verdad (elegir una pregunta al azar de un banco fijo no tiene
        // ningún camino de error real) — con `OpenAIQuestionProvider` de
        // por medio (OpenAI caído, sin cuota, JSON con forma inválida),
        // sí puede llegar un `{ error }` en vez de una pregunta real; sin
        // este chequeo, `data.error` terminaba en `preview` y el render
        // de más abajo explotaba tratando de leer `preview.options` de
        // un objeto que nunca tuvo esa forma.
        if (data?.error) throw new Error(data.error);
        setPreview(data);
        // Recomendación del modelo (ver `suggestedDurationSeconds` en
        // `openAIQuestionProvider.js`) — SOLO la preselecciona si es de
        // verdad uno de los presets reales (con el flag de IA apagado,
        // el banco random ni siquiera manda este campo): el docente
        // sigue pudiendo cambiarla con un click, esto es una sugerencia,
        // nunca una imposición.
        if (TIME_PRESETS.includes(data.suggestedDurationSeconds)) {
          setSeconds(data.suggestedDurationSeconds);
        }
      })
      .catch((err) => {
        if (!mountedRef.current || requestIdRef.current !== requestId) return;
        setPreviewError(err.message);
      })
      .finally(() => {
        if (!mountedRef.current || requestIdRef.current !== requestId) return;
        setLoadingPreview(false);
      });
  };

  useEffect(() => {
    loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detecta el éxito del envío: mientras se está "sending", cualquier
  // `activeQuestion` NUEVO (distinto al que ya estaba activo antes de
  // entrar acá) es la confirmación de que el backend la persistió y la
  // emitió — no hace falta que el propio mensaje "vuelva" con un ack
  // dedicado (ver `hooks/useLiveQuestions.js`, "question_stats_updated").
  // `onQuestionSent` (opcional) se llama JUSTO acá, con el mismo id ya
  // confirmado — nunca en el `onClick` del botón ni en el `catch` de abajo
  // — así que `TeacherPanel.jsx` solo navega/resalta la tarjeta cuando el
  // envío realmente se persistió, nunca si falló.
  useEffect(() => {
    if (sendStatus !== 'sending') return;
    if (activeQuestion && activeQuestion.id !== activeQuestionIdBeforeSendRef.current) {
      onQuestionSent?.(activeQuestion.id);
      onBack();
    }
  }, [activeQuestion, sendStatus, onBack, onQuestionSent]);

  useEffect(() => {
    if (sendStatus === 'sending' && questionSendError) {
      setSendStatus('error');
    }
  }, [questionSendError, sendStatus]);

  const ringFraction = Math.min(seconds / MAX_RING_SECONDS, 1);
  const ringOffset = TIMER_CIRCUMFERENCE * (1 - ringFraction);

  const handlePresetClick = (value) => {
    setSeconds(value);
  };

  const handleGenerateAnother = () => {
    if (sendStatus === 'sending') return;
    // El preview ACTUAL queda descartado (nunca se envió) — se suma a la
    // lista antes de pedir el próximo, así el backend sabe evitarlo.
    if (preview) discardedPromptsRef.current = [...discardedPromptsRef.current, preview.prompt];
    loadPreview();
  };

  const handleSend = async () => {
    if (!preview || loadingPreview || sendStatus === 'sending' || !meetingCode) return;
    activeQuestionIdBeforeSendRef.current = activeQuestion?.id ?? null;
    clearQuestionSendError();
    setLocalSendError(null);
    setSendStatus('sending');
    try {
      await sendQuestion(meetingCode, email, {
        prompt: preview.prompt,
        options: preview.options,
        correctOptionIndex: preview.correctOptionIndex,
        durationSeconds: seconds,
      });
      // El envío del mensaje en sí salió bien — la confirmación DEFINITIVA
      // (persistida + emitida) llega por WS y la maneja el efecto de
      // arriba. Si la conexión está caída, `sendQuestion` ya rechaza acá
      // mismo (ver `services/wsClient.js`).
      // La lista de descartados es de ESTA TANDA — una vez que se envía
      // una pregunta de verdad, `getRecentPromptsForMeeting` en el
      // backend ya la ve (queda persistida), así que no hace falta seguir
      // arrastrándola acá para la próxima vez que se abra esta pantalla.
      discardedPromptsRef.current = [];
    } catch (err) {
      // No hay "question_send_rejected" para este caso (nunca llegó a
      // salir por el socket) — se muestra el mensaje local tal cual.
      setSendStatus('error');
      setLocalSendError(err.message);
    }
  };

  const displayedError = localSendError || questionSendError;

  const disableActions = loadingPreview || !preview || sendStatus === 'sending';

  return (
    <div className="sparkle-screen sparkle-screen--live">
      <div className="sparkle-panel-topbar">
        <button type="button" className="sparkle-back-link" onClick={onBack}>
          <ChevronLeftIcon size={15} />
          Volver
        </button>
      </div>

      <div className="sparkle-scroll-area">
        <div className="sparkle-tab-content">
          {loadingPreview && <p className="sparkle-text">Generando pregunta…</p>}
          {previewError && <p className="sparkle-text sparkle-text-error">No se pudo generar una pregunta: {previewError}</p>}

          {preview && (
            <>
              <div className="sparkle-generate-head">
                <div>
                  <span className="sparkle-question-card-eyebrow">Pregunta</span>
                  <h2 className="sparkle-generate-title">{preview.prompt}</h2>
                </div>

                <div className="sparkle-timer-ring" aria-label={`${seconds} segundos`}>
                  <svg viewBox="0 0 40 40">
                    <circle className="sparkle-timer-ring-track" cx="20" cy="20" r={TIMER_RADIUS} />
                    <circle
                      className="sparkle-timer-ring-progress"
                      cx="20"
                      cy="20"
                      r={TIMER_RADIUS}
                      style={{ strokeDasharray: TIMER_CIRCUMFERENCE, strokeDashoffset: ringOffset }}
                    />
                  </svg>
                  <span className="sparkle-timer-ring-label">{seconds}s</span>
                </div>
              </div>

              <div>
                <p className="sparkle-section-label">Tiempo para responder</p>
                <div className="sparkle-time-picker">
                  {TIME_PRESETS.map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={`sparkle-time-chip ${seconds === value ? 'sparkle-time-chip--active' : ''}`}
                      onClick={() => handlePresetClick(value)}
                      disabled={sendStatus === 'sending'}
                    >
                      {value}s
                    </button>
                  ))}
                </div>
              </div>

              <div className="sparkle-option-list">
                {preview.options.map((option, index) => {
                  const correct = index === preview.correctOptionIndex;
                  return (
                    <div key={option} className={`sparkle-option sparkle-option--static ${correct ? 'sparkle-option--correct' : ''}`}>
                      <span className="sparkle-option-marker">{correct ? <CheckIcon size={11} /> : String.fromCharCode(65 + index)}</span>
                      {option}
                      {correct && <span className="sparkle-badge-correct">Correcta</span>}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {displayedError && <p className="sparkle-text sparkle-text-error">{displayedError}</p>}
        </div>
      </div>

      <div className="sparkle-sticky-footer">
        <button type="button" className="sparkle-button sparkle-button-primary" onClick={handleSend} disabled={disableActions}>
          {sendStatus === 'sending' ? 'Enviando…' : 'Enviar pregunta'}
        </button>
        <button
          type="button"
          className="sparkle-button sparkle-button-secondary"
          onClick={handleGenerateAnother}
          disabled={sendStatus === 'sending' || loadingPreview}
        >
          Generar otra pregunta
        </button>
        <button type="button" className="sparkle-button sparkle-button-tertiary" onClick={onBack} disabled={sendStatus === 'sending'}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
