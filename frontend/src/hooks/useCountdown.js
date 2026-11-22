import { useEffect, useState } from 'react';

// Cuenta regresiva puramente VISUAL — el servidor es la única fuente de
// verdad real de cuándo vence una pregunta (ver `hooks/useLiveQuestions.js`
// y `backend/src/ws/handlers.js`, `toPublicQuestion`): este hook solo
// recalcula, varias veces por segundo, cuánto falta para una marca de
// tiempo FIJA en el reloj LOCAL del cliente. Bloquear la UI al llegar a 0
// es sólo cosmético: el servidor rechaza igual cualquier respuesta tardía,
// aunque este contador se desincronice o el timer no llegue a correr (ej.
// la pestaña en segundo plano).
//
// IMPORTANTE — `expiresAt` tiene que ser una marca de tiempo FIJA, ya
// corregida a reloj local UNA SOLA VEZ (ver `hooks/useLiveQuestions.js`,
// `withLocalExpiry`), nunca recalculada en cada render con `Date.now()` —
// ese fue justamente el bug original: pasar algo como
// `Date.now() + offset` directo en el JSX recalcula un objetivo que se
// corre hacia adelante en cada render (el contador nunca bajaba de verdad,
// quedaba pegado cerca de la duración total). Acá adentro SÍ se usa
// `Date.now()` — pero solo para medir la distancia a esa marca fija, nunca
// para redefinirla.
export function useCountdown(expiresAt) {
  const [secondsLeft, setSecondsLeft] = useState(() => computeSecondsLeft(expiresAt));

  useEffect(() => {
    setSecondsLeft(computeSecondsLeft(expiresAt));
    if (!expiresAt) return undefined;
    const intervalId = setInterval(() => setSecondsLeft(computeSecondsLeft(expiresAt)), 250);
    return () => clearInterval(intervalId);
  }, [expiresAt]);

  return secondsLeft;
}

function computeSecondsLeft(expiresAt) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}
