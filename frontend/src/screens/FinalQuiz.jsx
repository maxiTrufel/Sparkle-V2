import { useEffect, useRef } from 'react';
import {
  ChevronLeftIcon, CheckIcon, CrossCircleIcon, TickIcon, CrossMarkIcon,
} from '../ui/icons';
import { getFinalQuiz } from '../services/backendMessaging';
import { withTimeout } from '../utils/withTimeout';

// "Quiz final" del ALUMNO — pantalla propia con "Volver", mismo "screen swap"
// que `ClassSummary.jsx`. 3 preguntas personales generadas con IA (ver
// `backend/src/services/finalQuizService.js`), de opción múltiple o de
// verdadero/falso — el backend normaliza las dos a `options` +
// `correctOptionIndex`, así que acá se muestran y se corrigen igual.
//
// Nada se guarda en la base: la corrección se hace acá, localmente. El estado
// (`quizState`) vive en `StudentPanel.jsx` y no en este componente, para que
// "Volver" y entrar de nuevo muestre el MISMO quiz (y no pague otra llamada a
// OpenAI); se pierde recién al recargar la página o cuando arranca otra clase.
//
// `quizState`:
//   { status: 'loading' | 'error' | 'unavailable' | 'ready',
//     errorMessage, unavailableReason, questions, selected: number[], submitted }
const QUIZ_QUERY_TIMEOUT_MS = 45000;

const UNAVAILABLE_REASON_MESSAGES = {
  insufficient_content: 'Esta clase no tuvo suficiente contenido (ni transcripción ni material) para armar un quiz.',
  ai_disabled: 'El quiz final no está disponible por ahora.',
};

const TYPE_LABELS = {
  multiple_choice: 'Opción múltiple',
  true_false: 'Verdadero o falso',
};

function optionClass(question, index, selectedIndex, submitted) {
  if (!submitted) return `sparkle-option ${selectedIndex === index ? 'sparkle-option--picked' : ''}`;
  if (index === question.correctOptionIndex) return 'sparkle-option sparkle-option--static sparkle-option--correct';
  if (index === selectedIndex) return 'sparkle-option sparkle-option--static sparkle-option--wrong';
  return 'sparkle-option sparkle-option--static';
}

// Etapa 86 — con el resultado a la vista, la opción correcta lleva un tilde y
// la elegida por error una cruz, en vez de la letra. Antes solo cambiaba el
// color, y si el alumno acertaba todo no se notaba que estaba corregido.
function optionMarker(question, index, selectedIndex, submitted) {
  if (submitted && index === question.correctOptionIndex) return <TickIcon />;
  if (submitted && index === selectedIndex) return <CrossMarkIcon />;
  if (question.type === 'true_false') return index === 0 ? 'V' : 'F';
  return String.fromCharCode(65 + index);
}

export default function FinalQuiz({ onBack, meetingCode, email, quizState, onQuizStateChange }) {
  const requestIdRef = useRef(0);

  function loadQuizNow() {
    if (!meetingCode || !email) return;
    const requestId = (requestIdRef.current += 1);
    onQuizStateChange({ status: 'loading' });

    withTimeout(getFinalQuiz(meetingCode, email), QUIZ_QUERY_TIMEOUT_MS, 'Se agotó el tiempo de espera armando el quiz.')
      .then(({ status: httpStatus, body }) => {
        if (requestIdRef.current !== requestId) return;
        if (httpStatus !== 200 || body?.error) {
          throw new Error(body?.error || 'No se pudo armar el quiz.');
        }
        if (!body.quizAvailable) {
          onQuizStateChange({ status: 'unavailable', unavailableReason: body.unavailableReason });
          return;
        }
        onQuizStateChange({
          status: 'ready',
          questions: body.questions,
          selected: body.questions.map(() => null),
          submitted: false,
        });
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        onQuizStateChange({ status: 'error', errorMessage: err.message });
      });
  }

  // Solo se pide si todavía no hay nada (primera vez que se abre); un quiz ya
  // armado se reusa tal cual.
  useEffect(() => {
    if (!quizState) loadQuizNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingCode, email]);

  const status = quizState?.status || 'loading';
  const questions = quizState?.questions || [];
  const selected = quizState?.selected || [];
  const submitted = Boolean(quizState?.submitted);
  const allAnswered = questions.length > 0 && selected.every((value) => value !== null);
  const correctCount = questions.filter((q, i) => selected[i] === q.correctOptionIndex).length;

  function pick(questionIndex, optionIndex) {
    if (submitted) return;
    const next = [...selected];
    next[questionIndex] = optionIndex;
    onQuizStateChange({ ...quizState, selected: next });
  }

  return (
    <div className="sparkle-screen">
      <div className="sparkle-screen-head">
        <button type="button" className="sparkle-back-link" onClick={onBack}>
          <ChevronLeftIcon size={15} />
          Volver
        </button>
        <h1 className="sparkle-title">Quiz final</h1>
        <p className="sparkle-subtitle">Tres preguntas sobre la clase, pensadas para vos.</p>
      </div>

      {status === 'loading' && <p className="sparkle-text">Armando tu quiz…</p>}

      {status === 'error' && (
        <div className="sparkle-inline-error">
          <p className="sparkle-text sparkle-text-error">{quizState.errorMessage}</p>
          <button type="button" className="sparkle-button sparkle-button-secondary sparkle-button-compact" onClick={loadQuizNow}>
            Reintentar
          </button>
        </div>
      )}

      {status === 'unavailable' && (
        <p className="sparkle-text">
          {UNAVAILABLE_REASON_MESSAGES[quizState.unavailableReason] || UNAVAILABLE_REASON_MESSAGES.ai_disabled}
        </p>
      )}

      {status === 'ready' && (
        <>
          {submitted && (
            <p className="sparkle-quiz-score">
              Acertaste {correctCount} de {questions.length}
            </p>
          )}

          <div className="sparkle-quiz-list">
            {questions.map((question, qIndex) => (
              // eslint-disable-next-line react/no-array-index-key
              <div className="sparkle-quiz-question" key={qIndex}>
                <div className="sparkle-quiz-question-head">
                  <p className="sparkle-section-label">
                    Pregunta {qIndex + 1} · {TYPE_LABELS[question.type]}
                  </p>
                  {submitted && (selected[qIndex] === question.correctOptionIndex ? (
                    <span className="sparkle-quiz-result sparkle-quiz-result--correct">
                      <CheckIcon size={15} />
                      Correcta
                    </span>
                  ) : (
                    <span className="sparkle-quiz-result sparkle-quiz-result--wrong">
                      <CrossCircleIcon size={15} />
                      Incorrecta
                    </span>
                  ))}
                </div>
                <p className="sparkle-quiz-prompt">{question.prompt}</p>
                <div className="sparkle-option-list">
                  {question.options.map((option, oIndex) => (
                    <button
                      type="button"
                      // eslint-disable-next-line react/no-array-index-key
                      key={oIndex}
                      className={optionClass(question, oIndex, selected[qIndex], submitted)}
                      onClick={() => pick(qIndex, oIndex)}
                      disabled={submitted}
                    >
                      <span className="sparkle-option-marker">{optionMarker(question, oIndex, selected[qIndex], submitted)}</span>
                      {option}
                    </button>
                  ))}
                </div>
                {submitted && question.explanation && <p className="sparkle-review-detail">{question.explanation}</p>}
              </div>
            ))}
          </div>

          <div className="sparkle-actions">
            {!submitted ? (
              <button
                type="button"
                className="sparkle-button sparkle-button-primary"
                disabled={!allAnswered}
                onClick={() => onQuizStateChange({ ...quizState, submitted: true })}
              >
                Ver resultado
              </button>
            ) : (
              <button type="button" className="sparkle-button sparkle-button-secondary" onClick={loadQuizNow}>
                Hacer otro quiz
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
