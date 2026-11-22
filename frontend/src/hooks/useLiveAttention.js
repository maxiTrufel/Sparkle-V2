import { useEffect, useRef, useState } from 'react';

// Estado en vivo del roster de atención (panel del docente,
// `screens/ConcentrationStats.jsx`) — mismo patrón que
// `hooks/useLiveQuestions.js`: hook APARTE de `useLiveClass` (no se mezcla
// ahí), escucha `SPARKLE_WS_EVENT` y filtra por su propio `type` y por
// `meetingCode`. Solo el DOCENTE recibe algo acá — el servidor únicamente
// manda "attention_roster_updated" a sockets con rol "teacher" (ver
// `sendToTeachers` en `backend/src/ws/handlers.js`); para un alumno, este
// hook simplemente nunca actualiza su estado inicial (vacío).
//
// Confirmado — pedido explícito posterior: `attentionRoster` (acá abajo)
// solo puede contener alumnos con la cámara de atención ACTIVA — el
// servidor arma "attention_roster_updated" a partir de
// `attentionState.obtenerSnapshot()`, que nunca tiene una entrada para un
// alumno que no mandó ningún `attention_snapshot` (cámara apagada). Un
// "alumno sin cámara" nunca aparece en este roster, así que ningún consumo
// de `attentionRoster` (acá, en `ConcentrationStats.jsx`, en
// `useGroupAttentionAlert.js`) puede contarlo por accidente como atento ni
// desatento — para saber CUÁNTOS alumnos están sin cámara hace falta un
// universo más amplio (`connectedStudents`, todos los unidos a la sala vía
// WS, independiente de si mandan atención) y restarle este roster, ver
// `screens/ConcentrationStats.jsx`.
//
// Corrección — pedido explícito posterior: este hook ANTES también
// trackeaba `statsSesion` (pico mínimo/máximo de concentración grupal +
// segundos con mayoría desatenta), tres agregados calculados 100% en
// memoria que se perdían con cualquier F5. Se sacaron de acá — la sección
// "En esta sesión" de `ConcentrationStats.jsx` ahora deriva sus métricas
// de los snapshots YA PERSISTIDOS (`attention_snapshots`, vía
// `hooks/useAttentionHistory.js`), que sí sobreviven una recarga.
export function useLiveAttention({ meetingCode, role }) {
  const [attentionRoster, setAttentionRoster] = useState([]);

  // Etiqueta a mostrar — Corrección (pedido explícito posterior): ahora es
  // el NOMBRE REAL del alumno (`student.name`, viaja en el snapshot
  // desde `useAttentionBroadcast.js`), ya no un rótulo anónimo. Se mantiene
  // un fallback a "Alumno N" (asignado de forma estable por `anonId`, igual
  // que antes) SOLO para el caso borde de un snapshot sin nombre resuelto
  // todavía (ej. llega antes de que `useInitialRoleResolution` termine de
  // cargarlo) — nunca debería ser el caso normal.
  const labelsRef = useRef(new Map());
  const nextNumberRef = useRef(1);

  function labelFor(anonId, name) {
    if (name) return name;
    if (!labelsRef.current.has(anonId)) {
      labelsRef.current.set(anonId, `Alumno ${nextNumberRef.current}`);
      nextNumberRef.current += 1;
    }
    return labelsRef.current.get(anonId);
  }

  // Se resetea todo al cambiar de reunión/rol — mismo criterio que
  // `useLiveQuestions.js`: evita arrastrar el roster de una clase anterior
  // a esta.
  useEffect(() => {
    setAttentionRoster([]);
    labelsRef.current = new Map();
    nextNumberRef.current = 1;
  }, [meetingCode, role]);

  useEffect(() => {
    const listener = (message) => {
      if (message?.type !== 'SPARKLE_WS_EVENT') return;
      const event = message.payload || {};
      if (event.meetingCode !== meetingCode || event.type !== 'attention_roster_updated') return;

      const students = Array.isArray(event.students) ? event.students : [];
      // `inattentive` — Corrección (pedido explícito posterior): antes se
      // excluía a propósito acá ("ese campo lo manda el alumno con SU
      // PROPIO Y y este panel nunca lo lee"), de cuando `ConcentrationStats.jsx`
      // todavía reclasificaba con SU PROPIO Y. Esa variable (`attentionThreshold`)
      // se sacó por completo del proyecto — TODOS los consumidores del
      // roster (`ConcentrationStats.jsx`, `TeacherDebugLog.jsx`,
      // `useGroupAttentionAlert.js` vía `App.jsx`) ahora clasifican
      // atento/desatento leyendo este campo tal cual, nunca recalculando
      // contra `concentration` (que, para `no_face`, siempre llega en
      // `true` — regla global "sin rostro = desatento", ver
      // `backend/src/ws/handlers.js#handleAttentionSnapshot`).
      //
      // `type`/`noFaceFraction` viajan por el mismo motivo que
      // `inattentive`: son el mismo dato crudo que `AttentionDebugLog.jsx` ya
      // muestra del lado del alumno — sin esto, una fila `no_face` (que
      // llega con `concentration: null`, ver
      // `backend/src/ws/handlers.js#handleAttentionSnapshot`) no tendría
      // forma de distinguirse de una predicción real con 0% de
      // concentración.
      const newRoster = students.map((student) => ({
        anonId: student.anonId,
        label: labelFor(student.anonId, student.name),
        type: student.type === 'no_face' ? 'no_face' : 'prediction',
        concentration: student.concentration,
        inattentive: Boolean(student.inattentive),
        noFaceFraction: student.noFaceFraction ?? null,
        ts: student.ts,
      }));

      setAttentionRoster(newRoster);
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [meetingCode, role]);

  return { attentionRoster };
}
