import { useEffect, useRef, useState } from 'react';
import { PauseIcon, CloseIcon } from './icons';
import { resumeClass } from '../services/backendMessaging';

// Cuánto queda visible antes de auto-ocultarse sola — mismo orden de
// magnitud que `QUESTION_TOAST_AUTO_HIDE_MS` en `App.jsx` (el toast
// equivalente del lado del alumno).
const AUTO_HIDE_MS = 8000;
// Duración de la transición CSS de salida (`--visible` se saca, ver
// `panel.css`) — el nodo se desmonta recién cuando termina, para que la
// animación de fade+slide llegue a correr en vez de desaparecer de golpe.
const LEAVE_TRANSITION_MS = 280;

// Notificación flotante fuera del panel lateral — vive dentro de
// `NotificationStack` (`ui/NotificationStack.jsx`), junto con
// `NewQuestionToast.jsx`/`FatigueAlert.jsx`/`GroupAttentionAlert.jsx`, hermano
// de `.sparkle-panel` en `App.jsx`: avisa al docente que la clase de esta
// reunión sigue detenida, sin depender de que abra el panel para enterarse.
//
// `active` es un booleano DERIVADO de `classResumable` (ver
// `hooks/useLiveClass.js`), sin `!isOpen` de por medio a propósito: si la
// visibilidad dependiera de abrir/cerrar el panel, cerrar el panel con la
// clase todavía detenida la haría "reaparecer" cada vez — justamente lo que
// no tiene que pasar (ver el punto de abajo). En cambio, esta notificación
// tiene su PROPIO ciclo de vida (`phase`), completamente separado de
// `isOpen`:
//   - se dispara UNA VEZ por cada transición `false -> true` de `active`
//     (una detección nueva: el docente se une/reconecta con la clase
//     detenida, o la detiene él mismo en vivo — nunca por un re-render
//     incidental del padre, que no cambia el VALOR de `active`);
//   - se auto-oculta sola a los `AUTO_HIDE_MS`, con una transición suave
//     (fade + slide, mismas clases que `NewQuestionToast`);
//   - se puede cerrar a mano en cualquier momento con el botón "X";
//   - "Reanudar clase" la cierra de inmediato (no espera la confirmación
//     del servidor — la propia vista del panel, si está abierta, ya refleja
//     el resultado real apenas llega "class_resumed");
//   - una vez cerrada (por cualquiera de los tres caminos de arriba), NO
//     vuelve a aparecer sola mientras `active` se mantenga en `true` sin
//     interrupciones — recién se vuelve a disparar ante una transición
//     `false -> true` genuina (`useEffect` de abajo, atado a `[active]`).
export default function ClassResumeNotice({ active, meetingCode, email }) {
  const [phase, setPhase] = useState('hidden'); // 'hidden' | 'visible' | 'leaving'
  const autoHideTimeoutRef = useRef(null);
  const leaveTimeoutRef = useRef(null);

  useEffect(() => {
    if (active) {
      clearTimeout(autoHideTimeoutRef.current);
      clearTimeout(leaveTimeoutRef.current);
      setPhase('visible');
      autoHideTimeoutRef.current = setTimeout(startLeaving, AUTO_HIDE_MS);
    } else {
      clearTimeout(autoHideTimeoutRef.current);
      clearTimeout(leaveTimeoutRef.current);
      setPhase('hidden');
    }

    return () => {
      clearTimeout(autoHideTimeoutRef.current);
      clearTimeout(leaveTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Arranca la transición de salida (auto-hide, "X", o "Reanudar clase") —
  // el nodo sigue montado durante `LEAVE_TRANSITION_MS` (sin la clase
  // `--visible`, ver `panel.css`) para que la animación llegue a correr, y
  // recién ahí se desmonta del todo.
  function startLeaving() {
    clearTimeout(autoHideTimeoutRef.current);
    setPhase((current) => (current === 'hidden' ? current : 'leaving'));
    clearTimeout(leaveTimeoutRef.current);
    leaveTimeoutRef.current = setTimeout(() => setPhase('hidden'), LEAVE_TRANSITION_MS);
  }

  if (phase === 'hidden') return null;

  // Misma acción que "Reanudar clase" dentro del panel
  // (`TeacherPanel.jsx`, `handleResumeClass`) — mismo `resumeClass` de
  // `services/backendMessaging.js`, sin reimplementar nada. Se cierra de
  // inmediato al clickear (fire-and-forget): si falla, queda logueado en
  // consola — el panel (si está abierto) sigue mostrando su propio botón
  // "Reanudar clase" para reintentar.
  function handleResume() {
    startLeaving();
    resumeClass(meetingCode, email).catch((err) => {
      console.log(`[Sparkle] Error reanudando la clase desde la notificación externa: ${err.message}`);
    });
  }

  return (
    <div
      className={`sparkle-resume-notice ${phase === 'visible' ? 'sparkle-resume-notice--visible' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="sparkle-resume-notice-icon">
        <PauseIcon size={18} />
      </span>

      <div className="sparkle-resume-notice-body">
        <div className="sparkle-resume-notice-head">
          <p className="sparkle-resume-notice-title">La clase está detenida</p>
          <button
            type="button"
            className="sparkle-resume-notice-close"
            onClick={startLeaving}
            aria-label="Cerrar notificación"
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <button
          type="button"
          className="sparkle-button sparkle-button-primary sparkle-resume-notice-cta"
          onClick={handleResume}
        >
          Reanudar clase
        </button>
      </div>
    </div>
  );
}
