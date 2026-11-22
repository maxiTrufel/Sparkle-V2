import { useRef, useState } from 'react';
import { TeacherIcon, ChevronLeftIcon } from '../ui/icons';
import { registerMeetingRole } from '../services/backendMessaging';
import { withTimeout } from '../utils/withTimeout';

// Presupuesto para el pedido de registro en sí (round-trip real al
// backend) — sin esto, un pedido colgado (conexión zombie, ver
// `enableKeepAlive` en `backend/src/db.js`) dejaría el botón en
// "Confirmando…" para siempre. A diferencia de la versión anterior, un
// timeout acá YA NO significa "seguir de largo sin el rol guardado" — ver
// el comentario de `handleConfirm` más abajo.
const REGISTER_TEACHER_TIMEOUT_MS = 5000;

// Causa raíz real del bug "primer ingreso como docente" (ver
// `hooks/useInitialRoleResolution.js`, `detectEmailWithRetries`): esta
// pantalla usaba `email` como best-effort — si todavía era `null` (Meet
// tardó más que el presupuesto del boot en renderizar el botón de cuenta,
// típico de una carga GENUINAMENTE fría tras varios días sin usar la
// extensión), el registro se saltaba EN SILENCIO y `onConfirmed()` se
// llamaba igual: el panel se abría con un rol que nunca quedó persistido
// en la base. Ahora:
//   1. se exige un email resuelto vía `ensureEmail()` (segundo intento BAJO
//      DEMANDA, no una repetición ciega del mismo timeout — para este
//      momento ya pasaron varios segundos más de carga real de la página);
//   2. `registerMeetingRole` se espera de verdad, y solo un ÉXITO
//      confirmado dispara `onConfirmed()` — el panel de docente
//      (`TeacherPanel.jsx`) nunca se abre con un rol sin guardar;
//   3. cualquier falla (sin email, timeout, error del backend) deja a la
//      persona en ESTA pantalla con un mensaje claro y un botón
//      "Reintentar" — nunca silenciada, nunca un `alert()` nativo. Sin
//      email, además, "Recargar la página" (Etapa 82): al recargar se pasa
//      por la sala de espera, donde el email siempre está escrito.
// `registerMeetingRole` es idempotente del lado del backend (upsert por
// email+reunión, ver `roleService.registerRole`), así que reintentarla acá
// las veces que hagan falta es seguro — nunca crea un duplicado ni pisa mal
// un estado previo.
export default function ConfirmTeacher({ meetingCode, email, ensureEmail, onConfirmed, onCancel }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [emailMissing, setEmailMissing] = useState(false);
  // Diagnóstico temporal — permite comparar en consola el intento que
  // falla (primer ingreso tras varios días sin usar la extensión) contra el
  // que funciona después de recargar y reintentar.
  const attemptRef = useRef(0);

  const handleConfirm = async () => {
    const attempt = (attemptRef.current += 1);
    const startedAt = Date.now();
    setSubmitting(true);
    setError(null);
    setEmailMissing(false);

    console.log(`[Sparkle][DIAG] ConfirmTeacher intento #${attempt} — meetingCode="${meetingCode}" email=${email || '(sin resolver)'}`);

    if (!meetingCode) {
      // No debería pasar (esta pantalla solo vive con una reunión ya
      // detectada), pero sin `meetingCode` no hay nada que registrar.
      setSubmitting(false);
      setError('No se detectó la reunión actual. Recargá la página e intentá de nuevo.');
      return;
    }

    const resolvedEmail = await ensureEmail();
    console.log(
      `[Sparkle][DIAG] ConfirmTeacher intento #${attempt} — ensureEmail() → ${resolvedEmail || '(null)'} ` +
        `(${Date.now() - startedAt}ms desde el click)`
    );

    if (!resolvedEmail) {
      setSubmitting(false);
      setEmailMissing(true);
      setError(
        'No pudimos detectar tu cuenta de Google. Sparkle la sigue buscando: probá de nuevo en unos segundos, o recargá la página.'
      );
      return;
    }

    try {
      await withTimeout(
        registerMeetingRole(meetingCode, resolvedEmail, 'teacher'),
        REGISTER_TEACHER_TIMEOUT_MS,
        'El registro tardó demasiado — puede que el backend esté iniciando.'
      );
      console.log(
        `[Sparkle][DIAG] ConfirmTeacher intento #${attempt} — rol registrado OK (${Date.now() - startedAt}ms desde el click).`
      );
      setSubmitting(false);
      onConfirmed();
    } catch (err) {
      console.log(
        `[Sparkle][DIAG] ConfirmTeacher intento #${attempt} — FALLÓ registrando el rol: ${err.message} ` +
          `(${Date.now() - startedAt}ms desde el click).`
      );
      setSubmitting(false);
      setError(`No se pudo guardar tu rol de docente: ${err.message}`);
    }
  };

  return (
    <div className="sparkle-screen">
      <div className="sparkle-screen-head">
        <button type="button" className="sparkle-back-link" onClick={onCancel} disabled={submitting}>
          <ChevronLeftIcon size={15} />
          Volver
        </button>
        <h1 className="sparkle-title">¿Sos el docente de esta clase?</h1>
        <p className="sparkle-subtitle">
          Vas a poder gestionar la clase y el material — confirmá para continuar.
        </p>
      </div>

      {error && <p className="sparkle-text sparkle-text-error">{error}</p>}

      <div className="sparkle-actions">
        <button
          className="sparkle-button sparkle-button-primary"
          onClick={handleConfirm}
          disabled={submitting}
        >
          <TeacherIcon size={17} />
          {submitting ? 'Confirmando…' : error ? 'Reintentar' : 'Sí, soy el docente'}
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
    </div>
  );
}
