import { useEffect, useRef, useState } from 'react';
import { StudentIcon } from './icons';

// Badge de "N alumnos en línea" con un popover que lista sus nombres — se
// abre al pasar el mouse (con un pequeño margen antes de cerrarse, para que
// mover el cursor hacia el popover no lo cierre de golpe) o con un click
// (para touch/teclado). Solo estado visual local: `students` sigue viniendo
// de afuera (el listado real de conectados), acá no se decide ni consulta
// nada por su cuenta.
export default function ConnectedStudentsBadge({ students }) {
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef(null);

  useEffect(() => () => clearTimeout(closeTimeoutRef.current), []);

  const count = students.length;
  const label = count === 0 ? 'Sin alumnos en línea' : `${count} ${count === 1 ? 'alumno en línea' : 'alumnos en línea'}`;

  const handleMouseEnter = () => {
    clearTimeout(closeTimeoutRef.current);
    setOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimeoutRef.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <div className="sparkle-connected-badge-wrap" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <button
        type="button"
        className={`sparkle-connected-badge ${count > 0 ? 'sparkle-connected-badge-active' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span className={`sparkle-status-dot ${count > 0 ? 'sparkle-status-dot-active' : ''}`} />
        <span className="sparkle-connected-badge-label">{label}</span>
      </button>

      {open && (
        <div className="sparkle-popover" role="dialog" aria-label="Alumnos conectados">
          {count === 0 ? (
            <p className="sparkle-popover-empty">Todavía no hay alumnos conectados.</p>
          ) : (
            <ul className="sparkle-popover-list">
              {students.map(({ email, name }) => (
                <li className="sparkle-popover-item" key={email}>
                  <span className="sparkle-popover-item-icon">
                    <StudentIcon size={14} />
                  </span>
                  {name || email}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
