import { useState } from 'react';
import { TeacherIcon, StudentIcon, ChevronRightIcon } from '../ui/icons';

// Etapa 69 — ni "Soy Docente" ni "Soy Alumno" registran nada contra el
// backend acá: ambos solo navegan a una pantalla intermedia propia
// (`ConfirmTeacher.jsx`/`StudentName.jsx`, ver `App.jsx`,
// `handleSelectRole`) que es quien de verdad decide cuándo el rol se
// asigna — con una confirmación explícita para el docente (Cambio 1) y con
// un nombre válido y único para el alumno (Etapa 68, Cambio 1).
//
// `hasTeacher` (Etapa 71, Capa 1 — preventiva) — cuando esta reunión YA
// tiene un docente permanente registrado con otro email, la tarjeta "Soy
// Docente" directamente NO SE RENDERIZA (no deshabilitada, no grisada:
// ausente) — no tiene sentido ofrecerle a nadie más un camino que el WS va
// a rechazar de todos modos. Esto es solo la primera capa: como `App.jsx`
// resuelve `hasTeacher` una única vez al montar, sigue existiendo una
// carrera posible (alguien más se registra como docente en el ratito entre
// que este panel cargó y que la persona hace click) — la Capa 2, defensiva,
// vive en `App.jsx` (`handleSelectRole`) y hace un chequeo FRESCO al
// momento exacto del click, antes de decidir si mostrar el diálogo de
// confirmación o saltar directo al rechazo.
//
// `loading` — mientras `onSelectRole('teacher')` está en vuelo (esa Capa 2
// implica un round-trip real al backend antes de decidir qué mostrar, a
// diferencia de "alumno" que navega de una), ambas tarjetas quedan
// deshabilitadas: evita un doble click que dispare dos chequeos a la vez, y
// le da a la persona una señal de que el click se registró mientras espera
// la respuesta.
export default function Welcome({ onSelectRole, hasTeacher }) {
  const [loading, setLoading] = useState(false);

  const handleClick = async (role) => {
    setLoading(true);
    try {
      await onSelectRole(role);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sparkle-screen">
      <div className="sparkle-screen-head">
        <h1 className="sparkle-title">Bienvenido a Sparkle V2</h1>
        <p className="sparkle-subtitle">Elegí cómo vas a participar en esta clase.</p>
      </div>

      <div className="sparkle-role-list">
        {!hasTeacher && (
          <button className="sparkle-role-card" onClick={() => handleClick('teacher')} disabled={loading}>
            <span className="sparkle-role-icon">
              <TeacherIcon size={18} />
            </span>
            <span className="sparkle-role-card-text">
              <span className="sparkle-role-card-title">Soy Docente</span>
              <span className="sparkle-role-card-helper">Gestioná la clase y el material</span>
            </span>
            <ChevronRightIcon size={16} className="sparkle-role-card-chevron" />
          </button>
        )}

        <button className="sparkle-role-card" onClick={() => handleClick('student')} disabled={loading}>
          <span className="sparkle-role-icon">
            <StudentIcon size={18} />
          </span>
          <span className="sparkle-role-card-text">
            <span className="sparkle-role-card-title">Soy Alumno</span>
            <span className="sparkle-role-card-helper">Sumate a la clase en curso</span>
          </span>
          <ChevronRightIcon size={16} className="sparkle-role-card-chevron" />
        </button>
      </div>
    </div>
  );
}
