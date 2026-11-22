import { useEffect, useRef } from 'react';
import { AlertTriangleIcon, CloseIcon } from './icons';
import { playAlertSound } from '../utils/playAlertSound';

// Alerta grupal de atención del DOCENTE — mismo patrón visual y estructural
// que `FatigueAlert.jsx` (el equivalente del alumno): mismo estilo
// (fade+slide, "siempre montado, nunca se desmonta"), mismo sonido discreto
// al aparecer. No comparte las clases CSS de `FatigueAlert` — cada
// notificación de este código replica a mano su propio estilo por
// convención (ver el mismo criterio en
// `NewQuestionToast.jsx`/`ClassResumeNotice.jsx`), así que esto tiene su
// propio bloque en `panel.css` con los mismos valores. El posicionamiento
// (esquina, apilado con las demás notificaciones) vive en
// `NotificationStack`/CSS, no acá — ver el punto de montaje en `App.jsx`.
//
// PRIVADA por construcción — vive en el árbol de React de ESTE docente
// únicamente (montada en `App.jsx`, hermano de `.sparkle-panel`), calculada
// enteramente a partir del `attentionRoster` que ya recibe este cliente
// (`hooks/useLiveAttention.js`) — ningún dato nuevo cruza hacia el backend
// para esto.
//
// En la práctica nunca coincide visible con `ClassResumeNotice.jsx` (la
// otra notificación del docente): `classResumable` (lo que activa esa
// notificación) y `classStarted` (lo único que permite que exista un roster
// con alumnos, y por lo tanto esta alerta) son mutuamente excluyentes en
// `hooks/useLiveClass.js`. Si algún día dejaran de serlo, `NotificationStack`
// ya las apila sin overlap igual.
export function GroupAttentionAlert({
  visible, onLaunchQuestion, onDismiss, style,
}) {
  // Beep solo en el flanco de subida (false → true) — mismo criterio que
  // `FatigueAlert.jsx`.
  const wasVisibleRef = useRef(false);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      playAlertSound();
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  return (
    <div
      className={`sparkle-group-alert ${visible ? 'sparkle-group-alert--visible' : ''}`}
      style={style}
      role="alert"
      aria-live="assertive"
      aria-hidden={!visible}
    >
      <span className="sparkle-group-alert-icon">
        <AlertTriangleIcon size={18} />
      </span>

      <div className="sparkle-group-alert-body">
        <div className="sparkle-group-alert-head">
          <p className="sparkle-group-alert-title">Desatención generalizada</p>
          <button
            type="button"
            className="sparkle-group-alert-close"
            onClick={onDismiss}
            aria-label="Cerrar aviso"
            tabIndex={visible ? 0 : -1}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <p className="sparkle-group-alert-text">
          Se detectó desatención generalizada en tu clase. Podés lanzar una pregunta
          para recuperar la atención o cambiar el ritmo de la clase.
        </p>
        <div className="sparkle-group-alert-actions">
          <button
            type="button"
            className="sparkle-button sparkle-button-primary"
            onClick={onLaunchQuestion}
            tabIndex={visible ? 0 : -1}
          >
            Lanzar pregunta
          </button>
          <button
            type="button"
            className="sparkle-button sparkle-button-secondary"
            onClick={onDismiss}
            tabIndex={visible ? 0 : -1}
          >
            Ignorar
          </button>
        </div>
      </div>
    </div>
  );
}
