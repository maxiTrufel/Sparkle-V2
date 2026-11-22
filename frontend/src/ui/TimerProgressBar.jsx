// Barra de progreso horizontal del temporizador de una pregunta en vivo —
// ÚNICA implementación compartida por el alumno (`StudentPanel.jsx`,
// `LiveQuestionModal`) y el docente (`QuestionCard.jsx`), para que ambas
// usen exactamente la misma lógica visual y los mismos umbrales (pedido
// explícito: evitar que cada lado tenga su propia versión, que con el
// tiempo terminan divergiendo). Puramente presentacional — nunca corre un
// timer propio: `remainingSeconds`/`totalSeconds` siempre vienen del MISMO
// `useCountdown`/`localExpiresAt` que ya mueve el anillo circular del
// alumno y el chip "Quedan Xs" del docente (ver esos archivos), así que
// los tres quedan sincronizados por construcción, nunca por coincidencia.
//
// `getTimerBarStage` está exportada aparte (no solo usada internamente)
// por si en el futuro hace falta el mismo cálculo de "en qué franja de
// color/pulso está el tiempo restante" sin renderizar esta barra en sí.
export function getTimerBarStage(remainingSeconds, totalSeconds) {
  const clampedRemaining = Math.max(remainingSeconds, 0);
  const fraction = totalSeconds > 0 ? Math.min(clampedRemaining / totalSeconds, 1) : 0;
  const percent = fraction * 100;

  // Umbrales pedidos: >50% color principal, 50%-25% amarillo/naranja,
  // <=25% rojo. El corte es por PORCENTAJE del tiempo total (no por
  // segundos absolutos) para que una pregunta de 10s y una de 60s pasen a
  // "alerta" en el mismo punto relativo de su propia duración.
  const stage = percent <= 25 ? 'danger' : percent <= 50 ? 'warning' : 'normal';

  // Pulso + intensidad extra SOLO en los últimos 5 segundos reales (no un
  // porcentaje) — independiente del `stage` de color: una pregunta muy
  // corta puede seguir en franja "normal" (>50%) y ya estar en sus
  // últimos 5 segundos. Nunca pulsa en 0 exacto (`clampedRemaining > 0`):
  // al llegar a cero la barra debe quedar vacía y sin ninguna animación
  // activa, no solo sin pulso — ver `fraction` arriba, que ya da 0.
  const pulsing = clampedRemaining > 0 && clampedRemaining <= 5;

  return { fraction, percent, stage, pulsing };
}

export default function TimerProgressBar({ remainingSeconds, totalSeconds, size = 'md', label }) {
  const { fraction, stage, pulsing } = getTimerBarStage(remainingSeconds, totalSeconds);
  const clampedRemaining = Math.max(remainingSeconds, 0);

  return (
    <div
      className={`sparkle-timer-progress-track sparkle-timer-progress-track--${size}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={totalSeconds}
      aria-valuenow={clampedRemaining}
      aria-label={label ?? `Quedan ${clampedRemaining} segundos`}
    >
      <div
        className={`sparkle-timer-progress-fill sparkle-timer-progress-fill--${stage} ${
          pulsing ? 'sparkle-timer-progress-fill--pulsing' : ''
        }`}
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  );
}
