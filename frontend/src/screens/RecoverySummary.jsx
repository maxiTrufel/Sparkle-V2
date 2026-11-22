import { useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon } from '../ui/icons';
import { getRecoverySummary } from '../services/backendMessaging';
import { withTimeout } from '../utils/withTimeout';

// "Recuperar contenido" para el ALUMNO — pantalla propia con "Volver",
// mismo criterio de "screen swap" que `ClassSummary.jsx` (que este
// componente reusa casi entero en estructura y estilos: mismas clases
// `.sparkle-summary-section`/`.sparkle-summary-list`/`.sparkle-inline-error`,
// ver `styles/panel.css`). La diferencia real con `ClassSummary.jsx` no es
// visual — es de ALCANCE: esto resume solo los ÚLTIMOS 2-3 MINUTOS de
// transcripción (ver `backend/src/services/recoverySummaryService.js`),
// pedido en CUALQUIER momento de la clase (nunca cacheado — cada click de
// cada alumno es personal y de ESE instante), mientras que
// `ClassSummary.jsx` resume la clase COMPLETA, una sola vez por reunión,
// disponible recién cuando termina. Por eso es un componente aparte y no
// un "modo" de `ClassSummary.jsx`: el service que consulta, el shape de la
// respuesta (sin sección "Para repasar" — no tiene sentido para un
// fragmento de minutos) y las reglas de disponibilidad son todas
// distintas.
//
// Título + badge "En vivo" (`.sparkle-badge-recovery`, panel.css) son la
// distinción visual pedida entre este resumen y el de fin de clase — mismo
// estilo general (misma tarjeta/tipografía de bullets), pero inconfundible
// de un vistazo.
const SUMMARY_QUERY_TIMEOUT_MS = 45000;

// Corrección — pedido explícito: "insufficient_content" (el backend no
// encontró suficiente transcripción en la ventana reciente, ver
// `recoverySummaryService.js`) YA NO se trata como un estado bloqueante
// con mensaje propio — ese caso cae directo a renderizar `summary.bullets`
// más abajo. Este componente siempre INTENTA mostrar algo; el único estado
// que sigue mostrando un mensaje aparte es `ai_disabled` (la función está
// apagada por configuración, no es que no haya encontrado nada que
// resumir — un caso genuinamente distinto).
const AI_DISABLED_MESSAGE = 'El resumen automático de contenido no está disponible por ahora.';

// Corrección — pedido explícito: un array de bullets VACÍO (o `null`) ya
// no se traduce en silencio (una `<ul>` sin ningún `<li>`, que en pantalla
// no se distingue de "todavía no cargó nada") — se muestra este mensaje
// neutral en su lugar, mismo `sparkle-text` que el resto de los estados de
// este componente.
const EMPTY_BULLETS_MESSAGE = 'No hubo actividad reciente para resumir. Consultá con tu docente.';

export default function RecoverySummary({ onBack, meetingCode, email }) {
  const [status, setStatus] = useState('loading'); // 'loading' | 'error' | 'ready'
  const [errorMessage, setErrorMessage] = useState(null);
  const [summary, setSummary] = useState(null); // { aiSummaryAvailable, unavailableReason, bullets, windowMinutes }
  const requestIdRef = useRef(0);

  function loadSummaryNow() {
    if (!meetingCode || !email) return;
    const requestId = (requestIdRef.current += 1);
    setStatus('loading');
    setErrorMessage(null);

    withTimeout(
      getRecoverySummary(meetingCode, email),
      SUMMARY_QUERY_TIMEOUT_MS,
      'Se agotó el tiempo de espera generando el resumen.'
    )
      .then(({ status: httpStatus, body }) => {
        if (requestIdRef.current !== requestId) return;
        if (httpStatus !== 200 || body?.error) {
          throw new Error(body?.error || 'No se pudo generar el resumen de contenido.');
        }
        setSummary({
          aiSummaryAvailable: Boolean(body.aiSummaryAvailable),
          unavailableReason: body.unavailableReason || null,
          bullets: body.bullets || [],
          windowMinutes: body.windowMinutes || 3,
        });
        setStatus('ready');
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        setErrorMessage(err.message);
        setStatus('error');
      });
  }

  useEffect(() => {
    loadSummaryNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingCode, email]);

  return (
    <div className="sparkle-screen">
      <div className="sparkle-screen-head">
        <button type="button" className="sparkle-back-link" onClick={onBack}>
          <ChevronLeftIcon size={15} />
          Volver
        </button>
        <div className="sparkle-screen-head-title-row">
          <h1 className="sparkle-title">Contenido que te perdiste</h1>
          <span className="sparkle-badge-recovery">En vivo</span>
        </div>
        <p className="sparkle-subtitle">Temas de los últimos minutos de la clase</p>
      </div>

      {status === 'loading' && <p className="sparkle-text">Generando el resumen…</p>}

      {status === 'error' && (
        <div className="sparkle-inline-error">
          <p className="sparkle-text sparkle-text-error">{errorMessage}</p>
          <button
            type="button"
            className="sparkle-button sparkle-button-secondary sparkle-button-compact"
            onClick={loadSummaryNow}
          >
            Reintentar
          </button>
        </div>
      )}

      {status === 'ready' && summary && (
        <div className="sparkle-summary-section">
          <p className="sparkle-section-label">Temas de este tramo</p>
          {summary.unavailableReason === 'ai_disabled' && (
            <p className="sparkle-text">{AI_DISABLED_MESSAGE}</p>
          )}
          {summary.unavailableReason !== 'ai_disabled' && (
            summary.bullets && summary.bullets.length > 0 ? (
              <ul className="sparkle-summary-list">
                {summary.bullets.map((bullet, index) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={index}>{bullet}</li>
                ))}
              </ul>
            ) : (
              <p className="sparkle-text">{EMPTY_BULLETS_MESSAGE}</p>
            )
          )}
        </div>
      )}
    </div>
  );
}
