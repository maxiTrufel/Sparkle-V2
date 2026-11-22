const OpenAI = require('openai');
const { requestJson, parseJsonText } = require('./openAIJsonRequest');

// "Quiz final" del alumno — 3 preguntas PERSONALES al terminar la clase (ver
// `services/finalQuizService.js`). Mismo criterio que `openAIQuestionProvider.js`:
// la API key se lee una sola vez, el modelo a CALL-TIME, y el cliente se crea
// recién en la primera llamada (perezoso — `providers/index.js` instancia esto
// siempre, con o sin `OPENAI_API_KEY`).
//
// Reusa `OPENAI_QUESTION_MODEL` (no una variable propia): son preguntas de
// verificación de comprensión, mismo tipo de tarea que las de la clase en
// vivo, y así el quiz no suma ninguna variable nueva al despliegue.
const { OPENAI_API_KEY } = process.env;
const DEFAULT_QUIZ_MODEL = 'gpt-4o-mini';
const QUIZ_LENGTH = 3;
const TRUE_FALSE_OPTIONS = ['Verdadero', 'Falso'];

const SYSTEM_PROMPT = `Armás un quiz final de repaso para UN alumno puntual, al terminar una clase.

Reglas:
- Devolvé EXACTAMENTE ${QUIZ_LENGTH} preguntas.
- Cada pregunta es de uno de dos tipos, y podés mezclarlos:
  - "multiple_choice": EXACTAMENTE 4 opciones, UNA sola correcta.
  - "true_false": una afirmación que es verdadera o falsa.
- Las preguntas tienen que poder responderse con lo que se dio en la clase (transcripción y
  material). Nunca sobre contenido que no aparece en ninguna de las dos fuentes.
- PERSONALIZALAS con lo que sabés de este alumno, en este orden de prioridad:
  1. Los temas de las preguntas de la clase que el alumno respondió MAL o NO RESPONDIÓ:
     volvé sobre ese mismo concepto, con una pregunta NUEVA (nunca la misma pregunta ni una
     reformulación calcada).
  2. Lo que se explicó mientras el alumno NO ESTABA CONECTADO a la clase.
  3. El resto de la clase, priorizando los conceptos centrales.
- No repitas temas que el alumno ya respondió BIEN, salvo que no quede otra cosa.
- Las ${QUIZ_LENGTH} preguntas tienen que ser sobre conceptos DISTINTOS entre sí: nunca dos
  preguntas sobre la misma idea (tampoco una de opción múltiple y otra de verdadero/falso
  que pregunten lo mismo).
- La transcripción es reconocimiento de voz: puede venir sucia o entrecortada. Tolerá esos
  errores y apoyate en el material para interpretarla.
- "explanation": una o dos oraciones que explican por qué la respuesta correcta es la correcta.
- Español, directo y corto. Sin texto fuera del JSON.

Respondé ÚNICAMENTE con un objeto JSON, sin bloques de código markdown, con EXACTAMENTE esta forma:
{"questions": [
  {"type": "multiple_choice", "prompt": "enunciado", "options": ["opción 1", "opción 2", "opción 3", "opción 4"], "correctOptionIndex": 0, "explanation": "..."},
  {"type": "true_false", "prompt": "afirmación", "correctAnswer": true, "explanation": "..."}
]}`;

function formatList(items, emptyText) {
  return items.length === 0 ? emptyText : items.map((item) => `- ${item}`).join('\n');
}

function formatTranscript(segments, emptyText) {
  if (!Array.isArray(segments) || segments.length === 0) return emptyText;
  return segments.map((segment) => `[${segment.speaker || 'Desconocido'}]: ${segment.text}`).join('\n');
}

const OUTCOME_LABELS = {
  correct: 'la respondió BIEN',
  incorrect: 'la respondió MAL',
  skipped: 'eligió NO RESPONDER',
  unanswered: 'NO LA RESPONDIÓ',
};

function formatClassQuestions(classQuestions) {
  if (!Array.isArray(classQuestions) || classQuestions.length === 0) return 'En esta clase no hubo preguntas.';
  return classQuestions
    .map((q) => `- "${q.prompt}" (respuesta correcta: "${q.correctAnswer}") → el alumno ${OUTCOME_LABELS[q.outcome]}`)
    .join('\n');
}

// Contenido VARIABLE de la llamada — ver `finalQuizService.buildQuizContext`
// para cómo se arma cada parte.
function buildUserMessage({
  mainTopics = [],
  keyConcepts = [],
  documentExcerpt = '',
  classQuestions = [],
  missedSegments = [],
  transcriptSegments = [],
}) {
  // El fragmento del texto del documento solo viene cuando el material se
  // procesó SIN resumen con IA (no hay temas ni conceptos) — ver
  // `finalQuizService.buildQuizContext`.
  const excerptSection = documentExcerpt
    ? `\n\nTEXTO DEL MATERIAL (fragmento del inicio del documento):\n${documentExcerpt}`
    : '';

  return `TEMAS DEL MATERIAL:
${formatList(mainTopics, '(sin temas disponibles)')}

CONCEPTOS CLAVE DEL MATERIAL:
${formatList(keyConcepts.map((c) => `${c.term}: ${c.definition}`), '(sin conceptos disponibles)')}${excerptSection}

PREGUNTAS QUE SE HICIERON EN LA CLASE Y CÓMO LE FUE A ESTE ALUMNO:
${formatClassQuestions(classQuestions)}

LO QUE SE EXPLICÓ MIENTRAS ESTE ALUMNO NO ESTABA CONECTADO:
${formatTranscript(missedSegments, 'Nada: estuvo conectado durante toda la parte transcripta de la clase.')}

TRANSCRIPCIÓN DE LA CLASE (puede tener errores de reconocimiento de voz):
${formatTranscript(transcriptSegments, 'No hay transcripción de esta clase.')}`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Salida estructurada (ver `openAIJsonRequest.js`): OpenAI genera el quiz
// ajustado a este esquema. Lo que el esquema no fija (4 opciones exactas,
// índice entre 0 y 3) lo sigue controlando `parseQuizResponse`.
const QUIZ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'prompt', 'options', 'correctOptionIndex', 'explanation'],
            properties: {
              type: { type: 'string', enum: ['multiple_choice'] },
              prompt: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              correctOptionIndex: { type: 'integer' },
              explanation: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'prompt', 'correctAnswer', 'explanation'],
            properties: {
              type: { type: 'string', enum: ['true_false'] },
              prompt: { type: 'string' },
              correctAnswer: { type: 'boolean' },
              explanation: { type: 'string' },
            },
          },
        ],
      },
    },
  },
};

// Tolera "true"/"verdadero" como texto: es la misma respuesta, solo mal tipada.
function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (word === 'true' || word === 'verdadero') return true;
  if (word === 'false' || word === 'falso') return false;
  return null;
}

function toIndex(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(number) ? number : null;
}

// Las de verdadero/falso se normalizan a la misma forma que las de opción
// múltiple (`options` + `correctOptionIndex`), así el frontend las muestra y
// las corrige con un único componente.
function normalizeQuestion(q, index) {
  if (!isNonEmptyString(q?.prompt)) {
    throw new Error(`La pregunta ${index + 1} vino sin enunciado.`);
  }
  const explanation = isNonEmptyString(q.explanation) ? q.explanation.trim() : null;

  if (q.type === 'true_false') {
    const answer = toBoolean(q.correctAnswer);
    if (answer === null) {
      throw new Error(`La pregunta ${index + 1} (verdadero/falso) vino sin "correctAnswer" booleano.`);
    }
    return {
      type: 'true_false',
      prompt: q.prompt.trim(),
      options: TRUE_FALSE_OPTIONS,
      correctOptionIndex: answer ? 0 : 1,
      explanation,
    };
  }

  if (q.type === 'multiple_choice') {
    if (!Array.isArray(q.options) || q.options.length !== 4 || !q.options.every(isNonEmptyString)) {
      throw new Error(`La pregunta ${index + 1} (opción múltiple) no trae 4 opciones.`);
    }
    const correct = toIndex(q.correctOptionIndex);
    if (correct === null || correct < 0 || correct > 3) {
      throw new Error(`La pregunta ${index + 1} trae un índice de respuesta correcta fuera de rango (0-3).`);
    }
    return {
      type: 'multiple_choice',
      prompt: q.prompt.trim(),
      options: q.options.map((o) => o.trim()),
      correctOptionIndex: correct,
      explanation,
    };
  }

  throw new Error(`La pregunta ${index + 1} trae un tipo desconocido ("${q.type}").`);
}

// Parseo DEFENSIVO. Una pregunta rota no se puede "arreglar" sin inventar
// contenido, así que se DESCARTA y se usan las demás: si vienen 4 y una está
// mal, alcanzan las otras 3. Con menos de 3 válidas se rechaza el quiz
// entero y `requestJson` lo vuelve a pedir, sin que el alumno se entere.
function parseQuizResponse(rawText) {
  let parsed;
  try {
    parsed = parseJsonText(rawText);
  } catch (err) {
    throw new Error('OpenAI no devolvió JSON válido para el quiz.');
  }

  if (!Array.isArray(parsed?.questions)) {
    throw new Error('OpenAI devolvió un quiz sin el campo "questions".');
  }

  const valid = [];
  const problems = [];
  parsed.questions.forEach((q, index) => {
    try {
      valid.push(normalizeQuestion(q, index));
    } catch (err) {
      problems.push(err.message);
    }
  });

  if (valid.length < QUIZ_LENGTH) {
    throw new Error(`Solo ${valid.length} de ${QUIZ_LENGTH} preguntas válidas. ${problems.join(' ')}`.trim());
  }
  if (problems.length > 0) {
    console.log(`[Sparkle][IA] Quiz final: se descartaron preguntas mal armadas y se usaron las demás (${problems.join(' ')}).`);
  }
  return valid.slice(0, QUIZ_LENGTH);
}

class OpenAIFinalQuizProvider {
  constructor() {
    this.client = null;
  }

  async generateQuiz(context = {}) {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY no está configurada — no se puede generar el quiz con IA.');
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: OPENAI_API_KEY });
    }

    const model = process.env.OPENAI_QUESTION_MODEL || DEFAULT_QUIZ_MODEL;

    const { value: questions, response } = await requestJson({
      client: this.client,
      label: 'el quiz final',
      model,
      // Mismo valor que las preguntas en vivo: algo de variedad, pero
      // atado al contexto real.
      temperature: 0.4,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(context) },
      ],
      schemaName: 'quiz_final',
      schema: QUIZ_SCHEMA,
      parse: parseQuizResponse,
      failureMessage: 'No se pudo generar el quiz con IA — reintentá en unos segundos.',
    });

    console.log(
      `[Sparkle][IA] Quiz final generado — tokens: prompt=${response.usage?.prompt_tokens ?? 'n/a'}, ` +
        `completion=${response.usage?.completion_tokens ?? 'n/a'}, total=${response.usage?.total_tokens ?? 'n/a'} ` +
        `(modelo="${response.model || model}").`
    );

    return questions;
  }
}

module.exports = { OpenAIFinalQuizProvider, parseQuizResponse, buildUserMessage, QUIZ_LENGTH };
