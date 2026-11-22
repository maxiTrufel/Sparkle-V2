import { useEffect, useRef } from 'react';
import { CameraIcon, CloseIcon } from './icons';

const AUTO_CLOSE_MS = 9000;

// Aviso de encuadre de cámara — TODAVÍA NO CONECTADO a ningún evento real
// (paso 1 de 2, ver comentario en `App.jsx` donde se monta temporalmente).
// Mismo patrón visual/estructural que el resto de notificaciones flotantes
// de `NotificationStack` (`FatigueAlert.jsx`/`NewQuestionToast.jsx`): no
// hay un componente de toast compartido en este código, cada uno replica a
// mano el mismo estilo (ver `.sparkle-camera-notice*` en
// `styles/panel.css`). role="status"/aria-live="polite" (no "alert"): es
// un aviso informativo, no una alerta urgente — mismo criterio que
// `NewQuestionToast`.
//
// A diferencia de `FatigueAlert` (que delega el timing a
// `hooks/useFatigueAlert.js`), ESTE componente maneja su propio timer de
// auto-cierre acá adentro: en el paso 1 todavía no existe ningún hook que
// lo dispare, así que tiene que poder funcionar solo con `visible`/
// `onClose` controlados desde afuera. Cuando se conecte al evento real de
// activación de cámara (paso 2), se decidirá si este timer se queda acá o
// se muda a un hook dedicado — no se toca ahora.
export function CameraPositionNotice({ visible, onClose }) {
  const timeoutRef = useRef(null);

  useEffect(() => {
    if (visible) {
      timeoutRef.current = setTimeout(onClose, AUTO_CLOSE_MS);
    }
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [visible, onClose]);

  function handleDismiss() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    onClose();
  }

  return (
    <div
      className={`sparkle-camera-notice ${visible ? 'sparkle-camera-notice--visible' : ''}`}
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
    >
      <span className="sparkle-camera-notice-icon">
        <CameraIcon size={18} />
      </span>

      <div className="sparkle-camera-notice-body">
        <div className="sparkle-camera-notice-head">
          <p className="sparkle-camera-notice-title">Ubicá bien tu cámara</p>
          <button
            type="button"
            className="sparkle-camera-notice-close"
            onClick={handleDismiss}
            aria-label="Cerrar aviso"
            tabIndex={visible ? 0 : -1}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <p className="sparkle-camera-notice-text">
          Para que la detección de atención funcione bien, tu cámara tiene que
          mostrarte de frente, no de costado ni en ángulo. Acomodala antes de
          seguir.
        </p>
        <button
          type="button"
          className="sparkle-button sparkle-button-primary sparkle-camera-notice-cta"
          onClick={handleDismiss}
          tabIndex={visible ? 0 : -1}
        >
          Entendido
        </button>
      </div>
    </div>
  );
}
