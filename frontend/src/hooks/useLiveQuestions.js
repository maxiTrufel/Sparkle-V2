import { useEffect, useRef, useState } from 'react';

// `question.expiresAt`/`question.serverTime` viajan en el reloj del
// SERVIDOR (ver `toPublicQuestion` en el backend). Acá se corrigen a una
// marca de tiempo FIJA en el reloj LOCAL, UNA SOLA VEZ, en el instante en
// que el mensaje llega — nunca en cada render de un componente (ese fue el
// bug real: `Date.now()` evaluado en cada render corre el objetivo hacia
// adelante todo el tiempo, y el contador nunca baja). `useCountdown.js`
// solo mide la distancia a esta marca ya fija, ver `hooks/useCountdown.js`.
function withLocalExpiry(question) {
  if (!question) return question;
  return { ...question, localExpiresAt: Date.now() + (question.expiresAt - question.serverTime) };
}

// Estado en vivo de las preguntas en tiempo real (estilo Kahoot) — mismo
// patrón que `useLiveClass.js`: el WebSocket físico vive en el service
// worker de background, acá solo se escuchan los eventos que ya reenvía
// (`SPARKLE_WS_EVENT`, ver `services/wsClient.js`, `TYPES_TO_FORWARD`). Es
// un hook APARTE de `useLiveClass` (no se mezcla ahí) para no tocar ese
// archivo, ya maduro y bien probado, por una feature nueva y sin relación
// con el ciclo de vida de la clase en sí — ambos hooks conviven sin
// pisarse: cada uno filtra los mensajes por su propio conjunto de `type`.
export function useLiveQuestions({ meetingCode, role, email }) {
  // Pregunta activa AHORA MISMO para esta clase, tal cual la manda el
  // servidor — nunca incluye la opción correcta mientras está activa (ver
  // `backend/src/ws/handlers.js`, `toPublicQuestion`). `null` si no hay
  // ninguna.
  const [activeQuestion, setActiveQuestion] = useState(null);
  // Solo tiene sentido para el DOCENTE — contadores en vivo
  // ("question_stats_updated"), nunca quién respondió qué.
  const [questionStats, setQuestionStats] = useState(null);
  // Solo tiene sentido para el ALUMNO — si esta persona ya respondió/saltó
  // la pregunta activa: llega como catch-up en "question_state" al unirse
  // o reconectar, o se completa apenas el propio alumno responde/saltea.
  const [myAnswerState, setMyAnswerState] = useState(null);
  // Snapshot de la ÚLTIMA pregunta que terminó, con la opción correcta ya
  // revelada (`correctOptionIndex`, solo válido después de finalizar — ver
  // "question_finished" más abajo) y, para el docente, las estadísticas
  // FINALES (`stats`, con la distribución por opción ya cerrada) — lo
  // consumen `StudentPanel.jsx` (historial de "preguntas respondidas" del
  // alumno) y `TeacherPanel.jsx` (mueve la tarjeta en vivo a "Preguntas
  // realizadas", con el mismo `ui/QuestionCard.jsx`). Se limpia con
  // `clearFinishedQuestion` apenas se usa, para no reusarlo por error con
  // la pregunta siguiente.
  const [finishedQuestion, setFinishedQuestion] = useState(null);
  // Error del último intento de "Enviar pregunta" ("question_send_rejected")
  // — `GenerateQuestion.jsx` lo muestra en el panel (nunca un alert nativo)
  // y lo limpia con `clearQuestionSendError` antes de cada intento nuevo.
  const [questionSendError, setQuestionSendError] = useState(null);
  // Error del último intento de responder/saltear ("answer_rejected") —
  // lo consume el modal de pregunta en vivo del alumno.
  const [answerError, setAnswerError] = useState(null);
  // Contador que solo avanza con "question_started" (nunca con el catch-up
  // de "question_state" al unirse/reconectar) — lo consume `App.jsx` para
  // disparar la notificación flotante de "nueva pregunta en vivo" SOLO
  // cuando el docente la manda de verdad en vivo, no cada vez que un alumno
  // entra a una pregunta que ya estaba activa.
  const [newQuestionSignal, setNewQuestionSignal] = useState(0);
  // Mismo criterio que `newQuestionSignal` — contador que SOLO avanza con
  // un "answer_accepted" en vivo (nunca con el catch-up de "question_state"
  // al reconectar, que también puede traer un `myAnswer` ya resuelto de
  // antes): lo consume `App.jsx` para disparar el popup grande de
  // "¡Respuesta correcta!"/"Respuesta incorrecta" (`ui/AnswerResultPopup.jsx`)
  // solo la primera vez que el propio alumno recibe la confirmación del
  // servidor, nunca de nuevo al reabrir el panel o reconectarse. No avanza
  // para "Prefiero no responder" (`event.skipped`) — no hay nada correcto/
  // incorrecto que anunciar en ese caso.
  const [answerResultSignal, setAnswerResultSignal] = useState(0);
  // Resultado que corresponde al `answerResultSignal` más reciente —
  // siempre se actualiza EN EL MISMO tick que el contador (mismo handler,
  // ver más abajo), así que un consumidor que reaccione a un cambio de
  // `answerResultSignal` ya encuentra acá el valor correcto, nunca uno
  // desactualizado de la respuesta anterior.
  const [lastAnswerCorrect, setLastAnswerCorrect] = useState(null);

  // Espejo síncrono de `activeQuestion` — el handler de "question_finished"
  // necesita el valor VIGENTE en el momento exacto en que llega ese
  // mensaje para armar el snapshot de `finishedQuestion` (con el prompt/
  // opciones de la pregunta que se acaba de cerrar), y un closure sobre el
  // `activeQuestion` del render en que se registró el listener quedaría
  // desactualizado.
  const activeQuestionRef = useRef(null);
  useEffect(() => {
    activeQuestionRef.current = activeQuestion;
  }, [activeQuestion]);

  // Mismo criterio que `activeQuestionRef` — el handler de
  // "question_finished" necesita las ÚLTIMAS estadísticas conocidas (las
  // del tick justo antes de finalizar) para armar el snapshot completo del
  // docente; el servidor no reenvía las estadísticas junto con
  // "question_finished" (ver `ws/handlers.js`, `autoFinishQuestion`), así
  // que se usa la última que ya se tenía.
  const questionStatsRef = useRef(null);
  useEffect(() => {
    questionStatsRef.current = questionStats;
  }, [questionStats]);

  // Etapa 84 — el listener de abajo escribe `activeQuestion`/`questionStats`
  // a través de estas dos funciones, que además actualizan el espejo EN EL
  // MISMO momento. Con solo los `useEffect` de arriba, el espejo se ponía al
  // día recién después del render: un "question_finished" que llegaba en ese
  // hueco (máquina cargada, o dos avisos casi juntos al reconectarse)
  // encontraba `activeQuestionRef.current` en `null`, se ignoraba, y la
  // pregunta quedaba abierta con la cuenta regresiva corriendo. Es lo que
  // hacía fallar a veces `App.botonDocenteYSinResponder.test.js` en el CI.
  // Los `useEffect` quedan como red para cualquier otra escritura.
  function applyActiveQuestion(question) {
    activeQuestionRef.current = question;
    setActiveQuestion(question);
  }
  function applyQuestionStats(stats) {
    questionStatsRef.current = stats;
    setQuestionStats(stats);
  }

  // Se resetea todo el estado de preguntas cada vez que cambia de reunión/
  // rol (mismo criterio que `classStarted`/etc. en `useLiveClass`) — evita
  // arrastrar el estado de una clase anterior a esta.
  useEffect(() => {
    setActiveQuestion(null);
    setQuestionStats(null);
    setMyAnswerState(null);
    setFinishedQuestion(null);
    setQuestionSendError(null);
    setAnswerError(null);
  }, [meetingCode, role]);

  useEffect(() => {
    const listener = (message) => {
      if (message?.type !== 'SPARKLE_WS_EVENT') return;
      const event = message.payload || {};
      if (event.meetingCode !== meetingCode) return;

      if (event.type === 'question_state') {
        // Catch-up al unirse/reconectar (docente o alumno) — ver
        // `sendQuestionStateCatchUp` en el backend.
        if (event.active) {
          applyActiveQuestion(withLocalExpiry(event.question));
          if (role === 'teacher') applyQuestionStats(event.stats || null);
          if (role === 'student') setMyAnswerState(event.myAnswer || null);
        } else {
          applyActiveQuestion(null);
          applyQuestionStats(null);
          setMyAnswerState(null);
        }
      } else if (event.type === 'question_started') {
        // Broadcast SOLO a alumnos (ver `sendToStudents` en
        // `backend/src/ws/rooms.js`) — llega automáticamente, sin que el
        // alumno haga nada, y abre el modal de responder (ver
        // `StudentPanel.jsx`).
        applyActiveQuestion(withLocalExpiry(event.question));
        setMyAnswerState(null);
        setAnswerError(null);
        setNewQuestionSignal((n) => n + 1);
      } else if (event.type === 'question_stats_updated') {
        // Le llega SOLO al docente — cumple doble función: confirma que el
        // propio "send_question" tuvo éxito (trae la pregunta completa,
        // ver `handleSendQuestion` en el backend) y mantiene los
        // contadores en vivo tras cada respuesta/salto. Se recalcula
        // `localExpiresAt` en CADA mensaje (no solo el primero): cada tick
        // trae la `expiresAt`/`serverTime` reales del servidor, así que
        // esto también RE-CORRIGE cualquier desvío de reloj acumulado, sin
        // reiniciar la cuenta regresiva (el `expiresAt` de origen no
        // cambia entre mensajes de la misma pregunta).
        applyActiveQuestion(withLocalExpiry(event.question));
        applyQuestionStats(event.stats);
        setQuestionSendError(null);
      } else if (event.type === 'question_finished') {
        const current = activeQuestionRef.current;
        if (current && current.id === event.questionId) {
          setFinishedQuestion({
            ...current,
            correctOptionIndex: event.correctOptionIndex,
            stats: questionStatsRef.current,
          });
          applyActiveQuestion(null);
        }
        applyQuestionStats(null);
      } else if (event.type === 'question_send_rejected') {
        setQuestionSendError(event.message || 'No se pudo enviar la pregunta.');
      } else if (event.type === 'answer_accepted') {
        // `correctOptionIndex` viaja acá — unicast, solo a este socket,
        // recién DESPUÉS de que su propia respuesta ya quedó grabada sin
        // vuelta atrás (ver `backend/src/ws/handlers.js`,
        // `handleAnswerQuestion`/`handleSkipQuestion`) — es lo que le
        // permite a `StudentPanel.jsx` mostrar la tarjeta FINAL
        // (correcta/incorrecta + respuesta correcta) desde el primer
        // momento, sin ningún estado "pendiente" intermedio.
        setMyAnswerState({
          answered: !event.skipped,
          skipped: Boolean(event.skipped),
          isCorrect: event.isCorrect ?? null,
          correctOptionIndex: event.correctOptionIndex ?? null,
        });
        setAnswerError(null);
        if (!event.skipped) {
          setLastAnswerCorrect(Boolean(event.isCorrect));
          setAnswerResultSignal((n) => n + 1);
        }
      } else if (event.type === 'answer_rejected') {
        setAnswerError(event.reason || 'No se pudo enviar la respuesta.');
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [meetingCode, role]);

  return {
    activeQuestion,
    questionStats,
    myAnswerState,
    finishedQuestion,
    clearFinishedQuestion: () => setFinishedQuestion(null),
    questionSendError,
    clearQuestionSendError: () => setQuestionSendError(null),
    answerError,
    clearAnswerError: () => setAnswerError(null),
    newQuestionSignal,
    answerResultSignal,
    lastAnswerCorrect,
  };
}
