// Íconos SVG inline, minimalistas (estilo outline), sin dependencias externas.
// Todos aceptan className/size para reutilizarse en distintos contextos del panel.

// Logo oficial de Sparkle V2 (Ajuste post-entrega — reemplaza al viejo
// ícono de "destello") — mortero de graduación, relleno/"solid" a
// propósito: es el único ícono de MARCA del set (el resto de `icons.jsx` es
// outline/stroke porque son íconos de UI, no de identidad). Se usa en dos
// contextos con dos tratamientos de color (ver `.sparkle-brand-icon` en
// `panel.css` para la versión "fondo claro" — azul sobre blanco/celeste — y
// `ToggleTab.jsx`, que ya vive sobre su propio fondo azul, para la versión
// "fondo oscuro" — blanco directo, sin contenedor propio adicional).
export function GraduationCapIcon({ size = 20, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path fill="currentColor" d="M12 3.3 22.5 8.6 12 13.9 1.5 8.6 12 3.3z" />
      <path
        fill="currentColor"
        d="M6.2 10.6v3.3c0 1.6 2.8 2.9 5.8 2.9s5.8-1.3 5.8-2.9v-3.3L12 13.5 6.2 10.6z"
      />
      <path d="M19.6 9.7v5.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
      <circle cx="19.6" cy="15.4" r="1.15" fill="currentColor" />
    </svg>
  );
}

export function TeacherIcon({ size = 20, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2 9l10-5 10 5-10 5-10-5z" />
      <path d="M6 11.5V16c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4.5" />
      <path d="M22 9v6" />
    </svg>
  );
}

export function StudentIcon({ size = 20, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v15H5.5C4.7 19 4 18.3 4 17.5V5.5z" />
      <path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v15h5.5c.8 0 1.5-.7 1.5-1.5V5.5z" />
    </svg>
  );
}

export function UploadIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 15V4M12 4l-4 4M12 4l4 4" />
      <path d="M5 15v3.5C5 19.9 6.1 21 7.5 21h9c1.4 0 2.5-1.1 2.5-2.5V15" />
    </svg>
  );
}

export function PlayIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l6 3.5-6 3.5v-7z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ClockIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

export function CheckIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  );
}

// Contraparte de `CheckIcon` — mismo círculo (radio, grosor de trazo), con
// una X en vez del tilde. Par visual consistente para el feedback grande de
// "respuesta correcta/incorrecta" en `ui/AnswerResultPopup.jsx`.
export function CrossCircleIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
}

export function QuestionIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function StopIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Estado "en pausa" (no error) — Ajuste UI: tarjeta unificada "Clase
// detenida" del panel del alumno (ver `ui/ClassPausedCard.jsx`). Mismo
// estilo outline que el resto del set (círculo r=9 + glifo interno).
export function PauseIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7M14 8.5v7" />
    </svg>
  );
}

export function InfoIcon({ size = 16, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 16, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 16, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function HistoryIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4.5H7.5" />
      <path d="M12 8v4.5l3 2" />
    </svg>
  );
}

export function ChartIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M3 20h18" />
    </svg>
  );
}

export function NotesIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M6 3.5h9l3 3v14H6z" />
      <path d="M9 10h6M9 14h6M9 18h3" />
    </svg>
  );
}

export function ArrowDownIcon({ size = 12, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

export function AlertTriangleIcon({ size = 16, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 3.5 21.5 20H2.5L12 3.5z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function BellIcon({ size = 20, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14 6 10z" />
      <path d="M10.5 19a1.8 1.8 0 0 0 3 0" />
    </svg>
  );
}

export function CloseIcon({ size = 16, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

// Reporte PDF de fin de clase — botón "Descargar reporte" de
// `TeacherPanel.jsx` (flecha hacia una bandeja, mismo estilo outline/stroke
// que el resto del set).
export function DownloadIcon({ size = 17, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 3v12" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4 16.5V19a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
    </svg>
  );
}

// Aviso de encuadre de cámara (`CameraPositionNotice.jsx`) — cuerpo de
// cámara simple + óvalo del lente, mismo estilo outline/stroke que el
// resto del set.
// Tilde y cruz sueltos, sin círculo: van adentro del círculo de color de
// `.sparkle-option-marker` (corrección del "Quiz final").
export function TickIcon({ size = 12, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function CrossMarkIcon({ size = 12, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function CameraIcon({ size = 18, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.4l1-1.6a1 1 0 0 1 .85-.4h6.5a1 1 0 0 1 .85.4l1 1.6h2.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-9z" />
      <circle cx="12" cy="13" r="3.4" />
    </svg>
  );
}
