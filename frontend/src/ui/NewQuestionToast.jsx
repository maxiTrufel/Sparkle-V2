import { BellIcon, CloseIcon } from './icons';

// Notificación flotante de "nueva pregunta en vivo" — vive dentro de
// `NotificationStack` (montado como hermano de `.sparkle-panel` en
// `App.jsx`, fuera de su árbol: `.sparkle-panel` anima con `transform`, así
// que cualquier `position: fixed` DESCENDIENTE suyo quedaría posicionado
// relativo al panel en vez de a toda la ventana). Por eso puede avisar de
// una pregunta nueva incluso con el panel cerrado.
//
// Puramente presentacional — toda la lógica (cuándo aparece, el auto-hide,
// qué pasa al responder/cerrar) vive en `App.jsx`. Siempre queda montado
// (nunca se desmonta) para que la animación de salida (fade + slide) pueda
// correr con una transición CSS normal en vez de un timer de desmontaje
// separado; `pointer-events: none` mientras está oculto asegura que nunca
// bloquea clicks debajo suyo, ni siquiera a mitad de la transición. El
// apilado con `FatigueAlert` (la otra notificación que puede coincidir
// visible) es responsabilidad de `NotificationStack`/CSS, no de este
// componente.
export default function NewQuestionToast({
  visible, onRespond, onClose,
}) {
  return (
    <div
      className={`sparkle-question-toast ${visible ? 'sparkle-question-toast--visible' : ''}`}
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
    >
      <span className="sparkle-question-toast-icon">
        <BellIcon size={18} />
      </span>

      <div className="sparkle-question-toast-body">
        <div className="sparkle-question-toast-head">
          <p className="sparkle-question-toast-title">Nueva pregunta en vivo</p>
          <button
            type="button"
            className="sparkle-question-toast-close"
            onClick={onClose}
            aria-label="Cerrar notificación"
            tabIndex={visible ? 0 : -1}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <p className="sparkle-question-toast-text">
          El docente acaba de enviar una nueva pregunta. Tenés tiempo limitado para responder.
        </p>
        <button
          type="button"
          className="sparkle-button sparkle-button-primary sparkle-question-toast-cta"
          onClick={onRespond}
          tabIndex={visible ? 0 : -1}
        >
          Responder ahora
        </button>
      </div>
    </div>
  );
}
