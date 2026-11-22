import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CrossCircleIcon } from './icons';

// Cuánto queda visible antes de empezar a desaparecer — pedido explícito
// (2 segundos), no un valor arbitrario.
const VISIBLE_MS = 2000;
// Duración de la transición de salida — el nodo sigue montado este rato más
// (sin la clase `--visible`, ver `panel.css`) para que la animación llegue
// a correr antes de desmontarse del todo, mismo criterio que
// `ClassResumeNotice.jsx`. Tiene que coincidir con la duración de la
// transición CSS (`panel.css`, 220ms) para no desmontar a mitad de camino.
const LEAVE_TRANSITION_MS = 220;

// Feedback grande, centrado DENTRO del panel lateral, apenas el backend
// confirma el resultado de una respuesta — a diferencia de
// `NewQuestionToast`/`ClassResumeNotice` (hermanos de `.sparkle-panel` en
// `App.jsx`, para cubrir TODA la ventana), este se monta DESCENDIENTE de
// `.sparkle-panel` (ver `App.jsx`) a propósito: mismo posicionamiento que ya
// usa `.sparkle-confirm-backdrop` (los diálogos de confirmación) —
// `.sparkle-panel` ya es `position: fixed` (un ancestro "posicionado"), así
// que un `position: absolute; inset: 0` acá adentro (ver `panel.css`) queda
// acotado EXACTO a los límites del panel sin importar cuántos `<div>` sin
// posicionar haya en el medio — nunca tapa el resto de Google Meet, y no le
// importa el scroll de `.sparkle-content`. A diferencia de ese backdrop
// (que solo atenúa lo de atrás), acá el fondo es BLANCO y completamente
// OPACO mientras se muestra (`var(--sparkle-bg)`, ver `panel.css`): tapa
// del todo cualquier contenido anterior del panel, nunca se transparenta
// nada detrás de la tarjeta. Diseño reutilizado a propósito (mismos
// colores/bordes/sombras/radios que `.sparkle-paused-card`, ver
// `panel.css`) en vez de uno nuevo. Puramente informativo —
// `pointer-events: none` en todo momento, nunca bloquea un click sobre el
// panel por debajo, y se cierra solo — no hay ningún botón que dependa de
// que el usuario interactúe con él.
//
// `signal` es un contador (ver `hooks/useLiveQuestions.js`,
// `answerResultSignal`) que SOLO avanza con una confirmación NUEVA del
// servidor ("answer_accepted" en vivo, nunca el catch-up de una
// reconexión) — el mismo patrón que `newQuestionSignal` ya usa para el
// toast de "nueva pregunta en vivo". `lastSignalRef` es la guarda contra
// duplicados: el efecto de abajo solo dispara el popup cuando `signal`
// cambia a un valor que todavía no se procesó, nunca de nuevo para el
// mismo valor (un re-render de `App.jsx` sin un `answer_accepted` nuevo de
// por medio no reabre nada).
export default function AnswerResultPopup({ signal, isCorrect }) {
  const [phase, setPhase] = useState('hidden'); // 'hidden' | 'visible' | 'leaving'
  const [shownIsCorrect, setShownIsCorrect] = useState(null);
  const visibleTimeoutRef = useRef(null);
  const leaveTimeoutRef = useRef(null);
  const lastSignalRef = useRef(0);

  useEffect(() => {
    if (!signal || signal === lastSignalRef.current) return undefined;
    lastSignalRef.current = signal;

    clearTimeout(visibleTimeoutRef.current);
    clearTimeout(leaveTimeoutRef.current);
    setShownIsCorrect(isCorrect);
    setPhase('visible');

    visibleTimeoutRef.current = setTimeout(() => {
      setPhase('leaving');
      leaveTimeoutRef.current = setTimeout(() => setPhase('hidden'), LEAVE_TRANSITION_MS);
    }, VISIBLE_MS);

    return () => {
      clearTimeout(visibleTimeoutRef.current);
      clearTimeout(leaveTimeoutRef.current);
    };
  }, [signal, isCorrect]);

  if (phase === 'hidden') return null;

  const visible = phase === 'visible';

  return (
    <div
      className={`sparkle-answer-result ${visible ? 'sparkle-answer-result--visible' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div
        className={`sparkle-answer-result-card sparkle-answer-result-card--${shownIsCorrect ? 'correct' : 'incorrect'} ${
          visible ? 'sparkle-answer-result-card--visible' : ''
        }`}
      >
        <span className="sparkle-answer-result-icon">
          {shownIsCorrect ? <CheckIcon size={30} /> : <CrossCircleIcon size={30} />}
        </span>
        <p className="sparkle-answer-result-title">
          {shownIsCorrect ? '¡Respuesta correcta!' : 'Respuesta incorrecta'}
        </p>
      </div>
    </div>
  );
}
