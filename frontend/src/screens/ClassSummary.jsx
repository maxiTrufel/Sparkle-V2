import { useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, CheckIcon } from '../ui/icons';
import { getClassSummary } from '../services/backendMessaging';
import { withTimeout } from '../utils/withTimeout';

// Resumen de la clase para el ALUMNO — pantalla propia con "Volver", mismo
// criterio de "screen swap" que el resto de la app (ver `StudentHistory.jsx`
// del lado del docente). Corrección — ya NO es contenido hardcodeado: pide
// el resumen real al backend (`backend/src/services/classSummaryService.js`),
// que a su vez arma DOS partes bien distintas:
//   1. El resumen en sí (bullets) — generado con IA a partir de la
//      transcripción COMPLETA de la clase, UNA sola vez por reunión (el
//      backend lo cachea — sin importar cuántos alumnos aprieten este
//      botón, es una sola llamada a OpenAI).
//   2. "Para repasar" — PERSONAL de este alumno (preguntas que respondió
//      mal o no llegó a responder), sin ninguna llamada a IA extra.
//
// Un pedido más lento de lo normal (la primera vez que se pide el resumen
// de una reunión, mientras la llamada a OpenAI todavía está en vuelo) es
// esperable acá — por eso el timeout es bastante más generoso que el de
// `getMyQuestionAnswers` en `StudentPanel.jsx` (8s: esa es una lectura
// simple de la base, esto puede incluir la generación real con IA).
const SUMMARY_QUERY_TIMEOUT_MS = 45000;

// Mensaje neutral por motivo (`summaryUnavailableReason`, ver
// `backend/src/services/classSummaryService.js`) — ninguno de los dos es
// un error: ni "la IA está apagada" ni "esta clase casi no tuvo
// transcripción" son algo que un "Reintentar" pueda arreglar (repetir el
// pedido da el mismo resultado siempre), así que se muestran como texto
// normal, nunca con el cartel rojo de error.
const UNAVAILABLE_REASON_MESSAGES = {
  insufficient_transcript: 'Esta clase tuvo muy poca transcripción disponible — no hay suficiente contenido real para armar un resumen.',
  ai_disabled: 'El resumen automático de esta clase no está disponible por ahora.',
};
const DEFAULT_UNAVAILABLE_MESSAGE = 'El resumen automático de esta clase no está disponible por ahora.';

// Etiqueta de estado corta — texto plano coloreado (ver `.sparkle-review-status-*`
// en panel.css), nunca un badge con fondo/borde: la pregunta pedida fue
// específicamente "sin cajas que rompan el ritmo de la lista".
const STATUS_LABELS = {
  correct: 'Acertada',
  incorrect: 'Errada',
  skipped: 'No respondió',
  unanswered: 'Sin responder',
};

// Corrección — cada pregunta es un `<li>` del MISMO `<ul class="sparkle-
// summary-list">` que el resumen de arriba (ver el render principal, más
// abajo): mismo marcador de viñeta, misma tipografía/espaciado — solo el
// COLOR del marcador (y el de esta etiqueta de estado) distingue acertada/
// errada/sin responder (`.sparkle-review-item--*`, panel.css). Ya no es
// una tarjeta aparte (`.sparkle-answered-card`, con su propio borde/fondo/
// padding — esa sigue existiendo, la sigue usando `StudentPanel.jsx` para
// "Preguntas realizadas"): acá las dos secciones tienen que leerse como
// parte del mismo documento, no como componentes distintos pegados.
//
// SIEMPRE recibe las cuatro variantes de `status` ('correct' incluido —
// ver `classSummaryService.buildReviewSection`, que ya no descarta las
// preguntas acertadas).
function ReviewItem({ prompt, status, yourAnswer, correctAnswer, relatedConcept }) {
  return (
    <li className={`sparkle-review-item sparkle-review-item--${status}`}>
      <div className="sparkle-review-item-head">
        <span className="sparkle-review-prompt">{prompt}</span>
        <span className={`sparkle-review-status sparkle-review-status--${status}`}>{STATUS_LABELS[status]}</span>
      </div>

      {status === 'correct' && (
        <p className="sparkle-review-detail">
          Tu respuesta: <span className="sparkle-answered-card-value sparkle-answered-card-value--right">{yourAnswer}</span>
        </p>
      )}

      {status === 'incorrect' && (
        <p className="sparkle-review-detail">
          Elegiste <span className="sparkle-answered-card-value sparkle-answered-card-value--wrong">{yourAnswer}</span> — correcta:{' '}
          <span className="sparkle-answered-card-value sparkle-answered-card-value--right">{correctAnswer}</span>
        </p>
      )}

      {(status === 'skipped' || status === 'unanswered') && (
        <p className="sparkle-review-detail">
          Correcta: <span className="sparkle-answered-card-value sparkle-answered-card-value--right">{correctAnswer}</span>
        </p>
      )}

      {relatedConcept && <p className="sparkle-review-detail">Concepto relacionado: {relatedConcept}</p>}
    </li>
  );
}

export default function ClassSummary({ onBack, meetingCode, email }) {
  const [status, setStatus] = useState('loading'); // 'loading' | 'error' | 'ready'
  const [errorMessage, setErrorMessage] = useState(null);
  const [summary, setSummary] = useState(null); // { bullets, review }
  const requestIdRef = useRef(0);

  function loadSummaryNow() {
    if (!meetingCode || !email) return;
    const requestId = (requestIdRef.current += 1);
    setStatus('loading');
    setErrorMessage(null);

    withTimeout(
      getClassSummary(meetingCode, email),
      SUMMARY_QUERY_TIMEOUT_MS,
      'Se agotó el tiempo de espera generando el resumen de la clase.'
    )
      .then(({ status: httpStatus, body }) => {
        if (requestIdRef.current !== requestId) return;
        if (httpStatus !== 200 || body?.error) {
          throw new Error(body?.error || 'No se pudo generar el resumen de la clase.');
        }
        setSummary({
          aiSummaryAvailable: Boolean(body.aiSummaryAvailable),
          summarySource: body.summarySource || null,
          summaryUnavailableReason: body.summaryUnavailableReason || null,
          bullets: body.bullets || [],
          review: body.review || null,
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
        <h1 className="sparkle-title">Resumen de la clase</h1>
        <p className="sparkle-subtitle">Un repaso de lo que se explicó en esta clase.</p>
      </div>

      {status === 'loading' && <p className="sparkle-text">Generando el resumen de la clase…</p>}

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
        <>
          <div className="sparkle-summary-section">
            {/* Corrección — el título depende de `summarySource`: un
                resumen armado con el MATERIAL (camino b, sin transcripción
                suficiente) nunca puede llamarse "Lo que se explicó" —
                sería engañoso, da a entender que el docente desarrolló
                esos temas cuando en realidad no hay forma de saberlo. */}
            <p className="sparkle-section-label">
              {summary.summarySource === 'document' ? 'Temas del material' : 'Lo que se explicó'}
            </p>
            {summary.aiSummaryAvailable ? (
              <ul className="sparkle-summary-list">
                {summary.bullets.map((bullet, index) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={index}>{bullet}</li>
                ))}
              </ul>
            ) : (
              // Corrección — ni el flag apagado NI la falta de contenido
              // (ni transcripción ni documento) son un error (antes el
              // backend devolvía 503/422 y esta pantalla mostraba el mismo
              // cartel rojo + "Reintentar" que un fallo real, aunque
              // reintentar nunca podía cambiar nada en ninguno de los dos
              // casos): son estados NEUTRALES y esperables, así que se
              // muestran como texto normal, sin tocar la sección "Para
              // repasar" de abajo (que nunca dependió de la IA ni de la
              // transcripción).
              <p className="sparkle-text">
                {UNAVAILABLE_REASON_MESSAGES[summary.summaryUnavailableReason] || DEFAULT_UNAVAILABLE_MESSAGE}
              </p>
            )}
          </div>

          {/* Corrección — la sección de repaso SIEMPRE lista las cuatro
              preguntas (acertadas incluidas, ver
              `classSummaryService.buildReviewSection`); el mensaje de
              felicitación, si corresponde, va ARRIBA del listado, nunca en
              su lugar. */}
          {summary.review && (
            <div className="sparkle-summary-section">
              <p className="sparkle-section-label">Para repasar</p>
              {summary.review.congratulations && (
                <p className="sparkle-text">
                  <CheckIcon size={14} /> ¡Respondiste bien todas las preguntas de esta clase!
                </p>
              )}
              <ul className="sparkle-summary-list sparkle-review-list">
                {summary.review.items.map((item) => (
                  <ReviewItem key={item.id} {...item} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
