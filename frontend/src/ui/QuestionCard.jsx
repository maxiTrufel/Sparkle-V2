import { forwardRef, useEffect, useState } from 'react';
import { ClockIcon, CheckIcon } from './icons';
import TimerProgressBar from './TimerProgressBar';

// Tarjeta de una pregunta — ÚNICO diseño, tanto para una pregunta ya
// finalizada como para la que está en vivo ahora mismo (Corrección: antes
// existía un componente aparte, `LiveQuestionStats.jsx`, con un diseño
// distinto — métricas de alumnos, botón "Finalizar pregunta ahora" — que
// se eliminó a favor de reusar este mismo componente para los dos casos).
// Sigue siendo puramente presentacional: recibe todo resuelto por props,
// no consulta nada por su cuenta.
//
// `isLive` decide qué chip mostrar arriba a la derecha ("Quedan Xs" vs
// "Finalizada") y el texto del eyebrow ("Pregunta en vivo" vs "Pregunta
// {index}") — nada más cambia entre ambos casos: mismas clases CSS, mismo
// layout, misma lista de opciones con barra + porcentaje.
//
// Corrección de layout — el contador ("Quedan X segundos") pasó de
// compartir fila con el título (competía por ancho horizontal, y el
// título terminaba angosto) a su PROPIA fila, arriba, junto al eyebrow. El
// título de la pregunta ahora ocupa el ancho completo de la tarjeta en su
// propia fila, sin ningún elemento al lado que le saque espacio — así el
// ancho del texto de la pregunta no se mueve un pixel aunque el contador
// pase de "10" a "9" (ver `.sparkle-timer-badge`, `min-width` fijo, en
// `styles/panel.css`, para que ni el badge en sí salte de tamaño).
//
// Ajuste "experiencia docente" — barra de progreso horizontal grande
// (`totalSeconds`, junto a `remainingSeconds`, ambos ya calculados por
// `TeacherPanel.jsx` a partir del MISMO `useCountdown` que mueve el chip
// "Quedan Xs" — nunca un segundo timer independiente): refuerzo visual
// SOLO para la pregunta en vivo, ubicada debajo del título y antes del
// subtítulo de "respuestas recibidas". Es el componente COMPARTIDO
// `ui/TimerProgressBar.jsx` (misma lógica de umbrales/pulso que el lado
// del alumno, ver ese archivo) — acá solo se elige el tamaño "lg" (barra
// más alta que la del alumno) porque esta tarjeta convive con más
// contenido alrededor. `ref`/`highlighted` (forwardRef) le permiten a
// `TeacherPanel.jsx` hacer `scrollIntoView` sobre la tarjeta recién
// enviada y resaltarla brevemente, sin que este componente sepa nada de
// esa lógica — solo aplica la clase CSS que le llega por prop.
const QuestionCard = forwardRef(function QuestionCard(
  { index, prompt, isLive = false, remainingSeconds, totalSeconds, responseCount, optionDistribution, highlighted = false },
  ref
) {
  const eyebrow = isLive ? 'Pregunta en vivo' : `Pregunta ${index}`;
  const responsesLabel = `${responseCount} ${responseCount === 1 ? 'respuesta recibida' : 'respuestas recibidas'}`;

  // Corrección — salto visual al finalizar una pregunta: `TeacherPanel.jsx`
  // ahora reusa esta MISMA tarjeta (mismo nodo, sin desmontar) para pasar de
  // "en vivo" a "recién finalizada" (ver `topQuestionEntry`/
  // `optimisticFinished` ahí) — así que acá adentro `isLive` puede pasar de
  // `true` a `false` en un componente que sigue montado, en vez de
  // reemplazarse por una tarjeta nueva. Sin este estado, la barra de
  // progreso (`{isLive && <TimerProgressBar/>}` de antes) desaparecía de
  // golpe, encogiendo la tarjeta de un tirón. `showTimerSlot` sigue
  // montando el mismo espacio un instante más allá de `isLive` para que la
  // transición CSS (`.sparkle-question-card-timer-wrap`, ver `panel.css`)
  // tenga tiempo de animar el colapso — recién se saca del DOM del todo
  // cuando esa transición termina de verdad (`onTransitionEnd`), así que
  // una tarjeta histórica común (nunca estuvo en vivo en esta sesión) sigue
  // sin este elemento y sin el espacio extra que ocuparía.
  const [showTimerSlot, setShowTimerSlot] = useState(isLive);
  useEffect(() => {
    if (isLive) setShowTimerSlot(true);
  }, [isLive]);

  return (
    <div ref={ref} className={`sparkle-question-card ${highlighted ? 'sparkle-question-card--highlight' : ''}`}>
      <div className="sparkle-question-card-top-row">
        <span className="sparkle-question-card-eyebrow">{eyebrow}</span>
        {isLive ? (
          <span className="sparkle-timer-badge">
            <ClockIcon size={12} />
            Quedan {remainingSeconds} segundos
          </span>
        ) : (
          <span className="sparkle-status-chip-closed">
            <CheckIcon size={12} />
            Finalizada
          </span>
        )}
      </div>

      <h3 className="sparkle-question-card-title">{prompt}</h3>

      {showTimerSlot && (
        <div
          className={`sparkle-question-card-timer-wrap ${isLive ? 'sparkle-question-card-timer-wrap--expanded' : ''}`}
          aria-hidden={!isLive}
          onTransitionEnd={(event) => {
            if (event.propertyName === 'grid-template-rows' && !isLive) setShowTimerSlot(false);
          }}
        >
          <div className="sparkle-question-card-timer-inner">
            <TimerProgressBar
              remainingSeconds={isLive ? remainingSeconds : 0}
              totalSeconds={isLive ? totalSeconds : 0}
              size="lg"
              label={`Quedan ${Math.max(isLive ? remainingSeconds : 0, 0)} segundos`}
            />
          </div>
        </div>
      )}

      <p className="sparkle-question-card-subtitle">{responsesLabel}</p>

      <div className="sparkle-answer-list">
        {optionDistribution.map((option, i) => (
          <div className="sparkle-answer-row" key={option.label}>
            <div className="sparkle-answer-row-head">
              <span className="sparkle-answer-marker">{String.fromCharCode(65 + i)}</span>
              <span className="sparkle-answer-label">{option.label}</span>
              {option.correct && <span className="sparkle-badge-correct">Correcta</span>}
            </div>
            <div className="sparkle-answer-progress">
              <div className="sparkle-progress-track">
                <div
                  className={`sparkle-progress-fill ${option.correct ? 'sparkle-progress-fill--correct' : ''}`}
                  style={{ width: `${option.percent}%` }}
                />
              </div>
              <span className="sparkle-answer-percent">{option.percent}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

export default QuestionCard;
