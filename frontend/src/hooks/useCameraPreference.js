import { useEffect, useRef, useState } from 'react';
import { getCameraEnabled, updateCameraEnabled } from '../services/backendMessaging';

// Etapa 63/64 — HERRAMIENTA DE PRUEBA, pensada para eliminarse por completo
// antes de las funcionalidades reales de IA (ver DOCUMENTACION.md).
//
// Etapa 64 — la lógica vive en este único hook (antes vivía junto a las
// piezas visuales en un solo componente); las dos piezas visuales que la
// consumen (`ui/CameraSwitch.jsx`, `ui/CameraPreviewBox.jsx`) se montan en
// DOS lugares distintos del árbol (el switch dentro de `Header.jsx`, el
// recuadro de preview fuera de `.sparkle-panel` por completo), así que este
// hook es la única fuente de verdad del estado, para no duplicarlo entre
// las dos.
//
// El acceso a la cámara (`getUserMedia`) se pide ÚNICAMENTE cuando el
// switch está habilitado Y ADEMÁS hay clase activa al mismo tiempo — nunca
// antes, ni con una sola de las dos condiciones. Cualquier transición que
// rompa esa condición (switch apagado a mano, o la clase deja de estar
// activa) corta el stream de la cámara de verdad (`track.stop()` en cada
// track, no solo ocultar el video) — ver el efecto de `active` más abajo.
//
// La preferencia se guarda por email + meetingCode (backend, tabla
// "participations" — no chrome.storage, tiene que sobrevivir entre
// dispositivos para la misma persona/reunión) y se vuelve a consultar al
// montar, para arrancar en el estado correcto sin que el usuario tenga que
// volver a tocarlo cada vez que reabre el panel.
//
// Etapa 65 — `inCall` (`callStage === 'en-llamada'`, ver `App.jsx`) se
// suma a la condición de `active`: sin esto, un alumno que salía de la
// llamada (cuelga, cierra la pestaña, pasa a la pantalla de "salida") con el
// switch activado seguía mostrando el preview y con la cámara prendida,
// porque `classStarted` NUNCA se resetea a `false` desde el frontend (solo
// se prende, nunca se apaga localmente) y `<App/>` no se desmonta al salir
// de la llamada — solo cambia de pantalla dentro del mismo panel montado. El
// switch en sí (la preferencia `enabled`) NO se toca acá: solo se corta el
// acceso REAL a la cámara, para que al volver a estar genuinamente
// en-llamada (reconexión a la misma reunión) el preview reaparezca solo si
// el switch seguía activado.
export function useCameraPreference({ active: featureActive, meetingCode, email, classStarted, inCall }) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  // Etapa 65 — evita una carrera real (encontrada escribiendo un test de
  // integración, no una hipótesis): la consulta inicial de abajo hace un
  // fetch real, así que puede seguir en vuelo un instante después del
  // montaje. Si el usuario clickea el switch ANTES de que esa consulta
  // resuelva, sin este flag la respuesta tardía (que todavía no sabe nada
  // del click) pisaría el `setEnabled` del click apenas llegara — el switch
  // podría "revertirse solo" a los pocos milisegundos de tocarlo. Una vez
  // que el usuario tocó el switch, la consulta inicial ya no tiene nada más
  // autoritativo que decir.
  const touchedRef = useRef(false);

  // Carga la preferencia guardada al montar (o si cambia meetingCode/email).
  // `featureActive` es `role === 'student'` (ver App.jsx) — nunca tiene
  // sentido consultar esto para un docente.
  useEffect(() => {
    if (!featureActive || !meetingCode || !email) return;
    let cancelled = false;

    getCameraEnabled(meetingCode, email)
      .then((result) => {
        if (!cancelled && !touchedRef.current) setEnabled(Boolean(result?.enabled));
      })
      .catch((err) => {
        console.log(`[Sparkle] Error consultando la preferencia de cámara: ${err.message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [featureActive, meetingCode, email]);

  // Etapa 85 — se incrementa para volver a pedir la cámara (ver el
  // "Permission dismissed" más abajo).
  const [retryAttempt, setRetryAttempt] = useState(0);

  const active = featureActive && enabled && classStarted && inCall;

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let removeFocusRetry = null;
    setError(null);

    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch((err) => {
        if (cancelled) return;
        // Etapa 85 — "Permission dismissed" NO es un "no" del usuario: Chrome
        // cierra solo el cartel de permiso cuando la pestaña pierde el foco
        // (por ejemplo, porque la extensión abrió su propia pestaña de
        // permiso al mismo tiempo). Antes esto apagaba el interruptor; ahora
        // se vuelve a pedir cuando el usuario regresa a la pestaña de Meet.
        if (err.name === 'NotAllowedError' && /dismiss/i.test(err.message)) {
          console.log('[Sparkle] El cartel de permiso de cámara se cerró solo: se reintenta al volver a la pestaña.');
          const onFocus = () => {
            removeFocusRetry?.();
            setRetryAttempt((n) => n + 1);
          };
          window.addEventListener('focus', onFocus);
          removeFocusRetry = () => {
            window.removeEventListener('focus', onFocus);
            removeFocusRetry = null;
          };
          return;
        }
        // Permiso denegado o sin cámara disponible: mensaje claro en vez de
        // romper el panel, y el toggle vuelve a "desactivado" solo — así no
        // se le vuelve a pedir permiso en cada re-render mientras siga sin
        // poder darlo.
        console.log(`[Sparkle] Error accediendo a la cámara: ${err.message}`);
        setError('No se pudo acceder a la cámara.');
        setEnabled(false);
        updateCameraEnabled(meetingCode, email, false).catch((err2) => {
          console.log(`[Sparkle] Error guardando el apagado automático de cámara: ${err2.message}`);
        });
      });

    return () => {
      cancelled = true;
      removeFocusRetry?.();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [active, meetingCode, email, retryAttempt]);

  const handleToggle = () => {
    touchedRef.current = true;
    const next = !enabled;
    setError(null);
    setEnabled(next);
    updateCameraEnabled(meetingCode, email, next).catch((err) => {
      // Best-effort: el cambio local pasa igual, sin bloquear al usuario
      // por un error de red o del backend (mismo criterio que el resto de
      // la persistencia de esta app) — pero queda logueado.
      console.log(`[Sparkle] Error guardando la preferencia de cámara: ${err.message}`);
    });
  };

  return { enabled, error, active, videoRef, handleToggle };
}
