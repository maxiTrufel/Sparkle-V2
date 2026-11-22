import { useEffect, useState } from 'react';

// Modo de clase en vivo — hook APARTE, mismo patrón que
// `useLiveAttention.js`/`useLiveQuestions.js` (no se mezcla en
// `useLiveClass.js`): escucha `SPARKLE_WS_EVENT` y filtra por su propio
// `type` (`attention_mode_updated`) y por `meetingCode`.
//
// A diferencia de `useLiveAttention.js` (que solo le llega al docente), este
// evento le llega a AMBOS roles — el backend lo manda con `broadcast()`, no
// `sendToTeachers()` (ver `backend/src/ws/handlers.js`,
// `handleSetAttentionMode` y el catch-up de `handleJoin`): un alumno
// necesita el preset del alumno (X/Y/K/Q/C), el docente necesita el preset
// del docente (P/V_doc/Q_doc/C_doc) — y el docente TAMBIÉN recibe su propio
// eco al elegir un modo, porque su panel de ajuste rápido también tiene que
// reflejar/bloquear el modo vigente (pedido explícito).
//
// Arranca en `null` — antes de que llegue el primer mensaje (catch-up del
// "join", o el primer cambio real), no hay ningún modo conocido todavía;
// quien consuma esto (`App.jsx`) no debe aplicar nada hasta que deje de
// serlo.
export function useAttentionModeSync({ meetingCode }) {
  const [mode, setMode] = useState(null);

  useEffect(() => {
    setMode(null);
  }, [meetingCode]);

  useEffect(() => {
    const listener = (message) => {
      if (message?.type !== 'SPARKLE_WS_EVENT') return;
      const event = message.payload || {};
      if (event.meetingCode !== meetingCode || event.type !== 'attention_mode_updated') return;

      setMode({
        id: event.id,
        name: event.name,
        description: event.description,
        student: event.student,
        teacher: event.teacher,
      });
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [meetingCode]);

  return mode;
}
