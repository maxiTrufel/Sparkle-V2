import { GraduationCapIcon, CloseIcon } from './icons';
import { CameraSwitch } from './CameraSwitch';

const ROLE_LABELS = {
  teacher: 'Docente',
  student: 'Alumno',
};

// Barra de marca fija arriba del panel. Muestra el logo de Sparkle, el
// email detectado (Etapa 11), cuando ya se eligió un rol un badge con ese
// rol, y un botón para cerrar el panel (equivalente a volver a hacer click
// en la pestaña). Se renderiza igual en Welcome/TeacherPanel/StudentPanel
// (todas comparten este Header desde App.jsx), así que el email queda
// visible en las tres sin duplicar nada por pantalla.
//
// `name`: nombre de usuario que el alumno eligió al registrarse
// (`screens/StudentName.jsx`) — solo existe para `role === 'student'` (las
// filas de "teacher" nunca tienen nombre, ver `roleService.getRole`). Para
// cualquier otro rol se sigue mostrando únicamente el email, como siempre.
// Cuando sí hay nombre, se muestra en una sola línea junto al email
// (nombre destacado + separador "·" + email en gris/chico), no apilados.
//
// `cameraEnabled`/`onToggleCamera` (Etapa 64) — HERRAMIENTA DE PRUEBA, ver
// `hooks/useCameraPreference.js` (dueño real del estado — acá solo se
// renderiza el switch). Se muestra debajo del email, ÚNICAMENTE para
// `role === 'student'` (ese prop ya llega como `confirmedRole` desde
// App.jsx, así que solo vale 'student' cuando el rol está genuinamente
// confirmado para esta reunión, nunca antes).
export default function Header({ role, email, name, onClose, cameraEnabled, onToggleCamera }) {
  return (
    <header className="sparkle-header">
      <div className="sparkle-header-row">
        <div className="sparkle-brand">
          <span className="sparkle-brand-icon">
            <GraduationCapIcon size={15} />
          </span>
          <span className="sparkle-brand-name">Sparkle</span>
          <span className="sparkle-brand-version">V2</span>
        </div>
        <div className="sparkle-header-actions">
          {role && <span className="sparkle-role-badge">{ROLE_LABELS[role]}</span>}
          <button
            type="button"
            className="sparkle-close-button"
            onClick={onClose}
            aria-label="Cerrar panel"
          >
            <CloseIcon size={15} />
          </button>
        </div>
      </div>
      {role === 'student' && name ? (
        <p className="sparkle-header-identity">
          <span className="sparkle-header-username">{name}</span>
          {email && (
            <>
              <span className="sparkle-header-separator" aria-hidden="true">
                ·
              </span>
              <span className="sparkle-header-email">{email}</span>
            </>
          )}
        </p>
      ) : (
        email && <p className="sparkle-header-email">{email}</p>
      )}
      {role === 'student' && <CameraSwitch enabled={cameraEnabled} onToggle={onToggleCamera} />}
    </header>
  );
}
