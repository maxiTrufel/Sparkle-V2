import { useState } from 'react';
import { StudentIcon, ChevronLeftIcon } from '../ui/icons';
import { registerStudent } from '../services/backendMessaging';

// Etapa 68, Cambio 1 — pantalla intermedia entre "elegí Soy Alumno" y el
// panel de alumno real: hasta que esta pantalla no confirma un nombre
// válido y único (dentro de ESTA reunión, ver `backend/src/routes/
// meetings.js`), la persona NO tiene ningún rol asignado para esta
// reunión — ni siquiera "alumno" (App.jsx no toca `role` hasta que
// `onConfirmed` se llama). Se llega acá desde dos lugares: `Welcome.jsx`
// ("Soy Alumno") y `TeacherPanel.jsx` (el botón "Unirme como alumno" de la
// pantalla de rechazo, Fix 3 de la Etapa 51) — ambos delegan la decisión de
// cuándo `role` pasa a ser "student" acá adentro, vía `onConfirmed`.
//
// `onBack` (Etapa 69, Cambio 2): cancela el flujo sin dejar rastro — como
// el rol recién se persiste al confirmar (arriba), no hace falta liberar
// nada en la base acá; solo le avisa a `App.jsx` que vuelva a Welcome.
export default function StudentName({ meetingCode, email, ensureEmail, onConfirmed, onBack }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [emailMissing, setEmailMissing] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();

    // Validación de cliente — feedback inmediato, sin esperar el
    // round-trip al backend. La validación real (la que de verdad importa,
    // incluida la unicidad) es la del servidor: ver el chequeo de status
    // más abajo.
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Ingresá tu nombre para continuar.');
      return;
    }

    if (!meetingCode) {
      setError('No se pudo detectar la reunión actual — recargá la página e intentá de nuevo.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setEmailMissing(false);

    // Segundo intento de detección BAJO DEMANDA (ver `ensureEmail()` en
    // `hooks/useInitialRoleResolution.js`) — mismo fix que `ConfirmTeacher.jsx`.
    // Sin email, además de reintentar se ofrece "Recargar la página" (Etapa
    // 82): al recargar se pasa por la sala de espera, donde el email siempre
    // está escrito.
    const resolvedEmail = email || (await ensureEmail());
    if (!resolvedEmail) {
      setSubmitting(false);
      setEmailMissing(true);
      setError(
        'No pudimos detectar tu cuenta de Google. Sparkle la sigue buscando: probá de nuevo en unos segundos, o recargá la página.'
      );
      return;
    }

    try {
      const result = await registerStudent(meetingCode, resolvedEmail, trimmedName);
      if (result.status === 200) {
        onConfirmed(result.body.name);
        return;
      }
      if (result.status === 409) {
        setError('Ese nombre ya está en uso en esta clase. Probá con otro.');
        return;
      }
      setError(result.body?.error || 'No se pudo registrar el nombre. Intentá de nuevo.');
    } catch (err) {
      setError(`Error al conectar con el backend: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sparkle-screen">
      <div className="sparkle-screen-head">
        {/* Ajuste 1 (Etapa 70) — mismo estilo/posición que el resto de los
            "Volver" del sistema: chico, subrayado, primero en la pantalla. */}
        <button type="button" className="sparkle-back-link" onClick={onBack} disabled={submitting}>
          <ChevronLeftIcon size={15} />
          Volver
        </button>
        <h1 className="sparkle-title">¿Cómo te llamás?</h1>
        <p className="sparkle-subtitle">
          Tu docente va a ver este nombre para identificarte en esta clase.
        </p>
      </div>

      <form className="sparkle-name-form" onSubmit={handleSubmit}>
        <div className="sparkle-input-group">
          <span className="sparkle-input-icon">
            <StudentIcon size={16} />
          </span>
          <input
            type="text"
            className="sparkle-input"
            placeholder="Nombre y apellido"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(null);
            }}
            disabled={submitting}
            maxLength={100}
            autoFocus
          />
        </div>

        {error && <p className="sparkle-text sparkle-text-error">{error}</p>}

        <div className="sparkle-actions">
          <button type="submit" className="sparkle-button sparkle-button-primary" disabled={submitting}>
            {submitting ? 'Confirmando…' : 'Confirmar'}
          </button>
          {emailMissing && (
            <button
              type="button"
              className="sparkle-button sparkle-button-secondary"
              onClick={() => window.location.reload()}
              disabled={submitting}
            >
              Recargar la página
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
