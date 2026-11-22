import { InfoIcon } from './icons';

// Switch visual (Etapa 64 — antes un botón de texto; Etapa 65 — texto
// actualizado + ícono de información con tooltip). Se monta dentro de
// `Header.jsx`, justo debajo del email, solo cuando `role === 'student'`.
// Puramente presentacional: no sabe nada de getUserMedia ni de persistencia,
// solo refleja `enabled` y avisa clicks vía `onToggle` — toda la lógica
// vive en `useCameraPreference` (`hooks/useCameraPreference.js`). El ícono
// "i" es `tabIndex={0}` para que el tooltip también sea alcanzable por
// teclado (`:focus-visible` en panel.css), no solo con mouse.
export function CameraSwitch({ enabled, onToggle }) {
  return (
    <div className="sparkle-camera-switch-row">
      <span className="sparkle-info-icon" tabIndex={0} aria-label="Por qué se pide acceso a la cámara">
        <InfoIcon size={13} />
        <span className="sparkle-tooltip" role="tooltip">
          Habilitar el acceso a la cámara ayuda a detectar patrones de desatención durante la clase.
        </span>
      </span>
      <label className="sparkle-camera-switch">
        <input
          type="checkbox"
          className="sparkle-camera-switch-input"
          checked={enabled}
          onChange={onToggle}
        />
        <span className="sparkle-camera-switch-track" aria-hidden="true">
          <span className="sparkle-camera-switch-thumb" />
        </span>
        <span className="sparkle-camera-switch-label">
          {enabled ? 'Acceso a la cámara habilitado' : 'Acceso a la cámara deshabilitado'}
        </span>
      </label>
    </div>
  );
}
