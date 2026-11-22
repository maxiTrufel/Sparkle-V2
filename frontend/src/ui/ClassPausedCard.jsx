import { PauseIcon } from './icons';

// Estado UNIFICADO "Clase detenida" del panel del alumno — Ajuste UI.
// Antes existían dos tarjetas con textos y diseño propios según el motivo
// ("No hay una clase en curso." para quien nunca vio una clase, "El
// docente ha detenido la clase." para quien la vio arrancar y el docente
// la frenó en vivo — ver `StudentPanel.jsx`), duplicando exactamente la
// misma estructura de JSX. Para el alumno ambos casos se sienten igual (no
// hay nada para hacer más que esperar), así que se unificaron en este
// único componente reutilizable — mismo título/descripción en los dos
// casos, sin ninguna lógica nueva.
//
// `children` es opcional: solo lo usa el caso "el docente detuvo la clase
// en vivo" (`endNotice` en `StudentPanel.jsx`) para agregar el botón
// "Obtener resumen de la clase" — no tiene sentido ofrecerlo cuando la
// clase nunca llegó a arrancar, así que esa diferencia funcional se
// preserva tal cual estaba. Ajuste UI — el botón se renderiza AFUERA de la
// tarjeta amarilla (como acción de pantalla normal, mismo ancho que el
// resto de los botones de la app vía `.sparkle-actions`), no adentro.
//
// Paleta ámbar suave (misma familia que `--sparkle-warning*`, ya usada en
// la alerta "Prestá atención") a propósito — nunca roja/de error: transmite
// una pausa, no un problema.
export default function ClassPausedCard({ children }) {
  return (
    <>
      <div className="sparkle-paused-card">
        <span className="sparkle-paused-card-icon">
          <PauseIcon size={26} />
        </span>
        <h2 className="sparkle-paused-card-title">La clase está detenida</h2>
      </div>
      {children && <div className="sparkle-actions">{children}</div>}
    </>
  );
}
