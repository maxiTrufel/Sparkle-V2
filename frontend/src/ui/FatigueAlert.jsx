import { useEffect, useRef } from 'react';
import { AlertTriangleIcon, CloseIcon } from './icons';
import { playAlertSound } from '../utils/playAlertSound';

// Notificación de fatiga/desatención — MISMO patrón visual y estructural que
// `NewQuestionToast.jsx`/`ClassResumeNotice.jsx`/`GroupAttentionAlert.jsx`
// (las otras notificaciones flotantes de la app, todas hijas de
// `NotificationStack` en `App.jsx`): no hay un componente de toast
// compartido en este código, cada notificación es su propio componente que
// replica a mano el mismo estilo/animación por convención. Este sigue esa
// misma convención — mismo `border-radius`/box-shadow, misma animación
// fade+slide "siempre montado, nunca se desmonta" (ver
// `.sparkle-fatigue-alert` en `styles/panel.css`). El posicionamiento en sí
// (esquina, apilado con las demás notificaciones) vive enteramente en
// `NotificationStack`/CSS, no acá.
//
// PRIVADA por construcción, no por un chequeo de acceso: vive en el árbol de
// React de este alumno únicamente (montada en `App.jsx`, hermano de
// `.sparkle-panel`) y ningún dato de `useFatigueAlert` cruza hacia el docente
// ni hacia ningún backend.
export function FatigueAlert({
  visible, onRecoverContent, onDismiss,
}) {
  // Beep solo en el flanco de subida (false → true) — sin este ref sonaría
  // en cada re-render mientras la alerta sigue visible, no solo cuando
  // aparece.
  const wasVisibleRef = useRef(false);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      playAlertSound();
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  return (
    <div
      className={`sparkle-fatigue-alert ${visible ? 'sparkle-fatigue-alert--visible' : ''}`}
      role="alert"
      aria-live="assertive"
      aria-hidden={!visible}
    >
      <span className="sparkle-fatigue-alert-icon">
        <AlertTriangleIcon size={18} />
      </span>

      <div className="sparkle-fatigue-alert-body">
        <div className="sparkle-fatigue-alert-head">
          <p className="sparkle-fatigue-alert-title">Baja atención detectada</p>
          <button
            type="button"
            className="sparkle-fatigue-alert-close"
            onClick={onDismiss}
            aria-label="Cerrar aviso"
            tabIndex={visible ? 0 : -1}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <p className="sparkle-fatigue-alert-text">
          Se detectó falta de atención. ¿Querés recuperar el contenido perdido?
        </p>
        <div className="sparkle-fatigue-alert-actions">
          <button
            type="button"
            className="sparkle-button sparkle-button-primary"
            onClick={onRecoverContent}
            tabIndex={visible ? 0 : -1}
          >
            Recuperar contenido
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
