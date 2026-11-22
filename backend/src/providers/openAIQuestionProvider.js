const OpenAI = require('openai');
const { QuestionProvider } = require('./questionProvider');
const { requestJson, parseJsonText } = require('./openAIJsonRequest');

// Mismo criterio que `openAIDocumentAnalysisProvider.js`: la API key se lee
// una sola vez (no cambia en caliente); el modelo se lee a CALL-TIME,
// dentro de `generateQuestion`, para poder cambiarlo sin reiniciar el
// proceso y que los tests lo togglee por caso sin recargar módulos.
// 'gpt-4o-mini' (económico) por default — esto corre muchas veces por
// clase (cada "Generar pregunta"/"Generar otra pregunta"), es donde va a
// estar el costo real de la app, no un uso puntual como el resumen del
// documento.
const { OPENAI_API_KEY } = process.env;
const DEFAULT_QUESTION_MODEL = 'gpt-4o-mini';

// Instrucciones FIJAS (nunca cambian entre llamadas) en el system message
// — el contenido que sí varía por reunión/momento (temas, transcripción,
// preguntas previas) va en el user message (ver `generateQuestion`),
// nunca acá. Afirmativo y corto, como se pidió: sin rodeos ni ejemplos
// largos.
const SYSTEM_PROMPT = `Generás preguntas de opción múltiple para verificar la comprensión de los
alumnos DURANTE una clase en vivo.

Reglas:
- Devolvé EXACTAMENTE 4 opciones, con UNA sola correcta.
- La pregunta tiene que poder responderse con lo que YA se explicó (temas/conceptos del
  documento y lo que se dijo hasta ahora en la transcripción) — nunca sobre contenido que
  todavía no se vio, y nunca exigiendo conocimiento previo que no esté ni en el documento ni
  en la transcripción. El criterio de fondo: la tiene que poder responder un alumno que
  prestó atención a la clase y leyó el material, no alguien que además sepa el tema de antes.
- ORDEN DE PRIORIDAD para elegir en qué apoyar la pregunta (usá la primera fuente que
  alcance para armar una pregunta nueva y distinta de las ya listadas):
  1. Lo que el DOCENTE ACABA DE EXPLICAR en la transcripción — es lo más fresco y lo más
     fiel a esta clase puntual, así que es la fuente preferida cuando hay algo ahí.
  2. Las DEFINICIONES DE LOS CONCEPTOS CLAVE del documento — es contenido real y
     desarrollado del material, a diferencia de los temas (ver punto 3).
  3. Solo si ninguna de las dos anteriores alcanza (se agotaron, o no dan para una pregunta
     nueva), ampliá sobre alguno de los TEMAS DEL DOCUMENTO con conocimiento general — pero
     manteniéndote en el mismo nivel de profundidad que el documento: los temas son títulos,
     no contenido desarrollado, así que NUNCA pidas ahí un dato técnico o específico
     (número exacto, nombre propio puntual, cifra) que el material no haya cubierto — a lo
     sumo una idea general asociada al tema, del tipo que cualquiera que leyó el título
     ya podría inferir sin haber estudiado el tema en profundidad.
- La transcripción es reconocimiento de voz en vivo: puede venir sucia, entrecortada, con
  palabras mal reconocidas o repetidas. Tolerá esos errores. Si un fragmento puntual es
  ambiguo, apoyate en los temas y conceptos del documento para interpretarlo — no descartes
  la transcripción entera por eso.
- Si no hay transcripción todavía, generá la pregunta con el resto del orden de prioridad
  (conceptos clave primero, temas del documento recién si hace falta).
- La pregunta tiene que abordar un tema DISTINTO de los ya listados (te paso la lista, sean
  preguntas ya enviadas a la clase o previews que el docente generó y descartó) — nunca una
  reformulación o variación superficial del mismo tema con otras palabras. Si los temas
  puntuales del documento ya se agotaron, profundizá en un aspecto o matiz diferente de
  alguno de ellos en vez de repetir la misma pregunta con otro enunciado.
- Elegí también "suggestedDurationSeconds": uno de estos 4 valores EXACTOS — 15, 30, 45, 60
  (nunca otro número). Más tiempo (45 o 60) si la pregunta exige razonar, comparar, o leer
  opciones largas; menos tiempo (15) si es recordar un dato puntual con opciones cortas; 30
  para el caso intermedio.
- Español, afirmativo, corto: sin explicaciones fuera del JSON, sin preámbulo.

Respondé ÚNICAMENTE con un objeto JSON, sin bloques de código markdown y sin texto antes o
después, con EXACTAMENTE esta forma:
{"prompt": "enunciado de la pregunta", "options": ["opción 1", "opción 2", "opción 3", "opción 4"], "correctOptionIndex": 0, "suggestedDurationSeconds": 30}`;

function formatTopics(mainTopics) {
  if (!Array.isArray(mainTopics) || mainTopics.length === 0) return '(sin temas disponibles)';
  return mainTopics.map((topic) => `- ${topic}`).join('\n');
}

function formatConcepts(keyConcepts) {
  if (!Array.isArray(keyConcepts) || keyConcepts.length === 0) return '(sin conceptos disponibles)';
  return keyConcepts.map((concept) => `- ${concept.term}: ${concept.definition}`).join('\n');
}

function formatTranscript(transcriptSegments) {
  if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) {
    return 'Todavía no hay transcripción disponible.';
  }
  return transcriptSegments.map((segment) => `[${segment.speaker || 'Desconocido'}]: ${segment.text}`).join('\n');
}

// `previousPrompts` mezcla dos orígenes distintos (ver
// `questionService.generatePreview`): enunciados YA ENVIADOS a la clase, y
// enunciados de previews que el docente generó y descartó sin enviar en
// esta misma tanda — desde acá adentro no hace falta distinguirlos, para
// el propósito de esta lista ("no repitas tema") son equivalentes.
function formatPreviousPrompts(previousPrompts) {
  if (!Array.isArray(previousPrompts) || previousPrompts.length === 0) return 'Ninguna todavía.';
  return previousPrompts.map((prompt) => `- ${prompt}`).join('\n');
}

// Contenido VARIABLE de la llamada — arma el user message a partir del
// `context` que arma `questionService.generatePreview` (ver
// `questionProvider.js` para la forma exacta). A propósito NUNCA recibe
// `extractedText`: el texto completo del documento infla el prompt (y el
// costo) en CADA pulsación de "Generar pregunta"/"Generar otra
// pregunta" — los temas/conceptos ya resumidos alcanzan de sobra como
// contexto temático.
function buildUserMessage({ mainTopics, keyConcepts, transcriptSegments, previousPrompts }) {
  return `TEMAS DEL DOCUMENTO:
${formatTopics(mainTopics)}

CONCEPTOS CLAVE:
${formatConcepts(keyConcepts)}

TRANSCRIPCIÓN RECIENTE DE LA CLASE (puede tener errores de reconocimiento de voz):
${formatTranscript(transcriptSegments)}

TEMAS/PREGUNTAS A EVITAR — enviados a la clase o descartados sin enviar, no repitas ninguno:
${formatPreviousPrompts(previousPrompts)}`;
}

// Parseo DEFENSIVO — igual que `openAIDocumentAnalysisProvider.js`: cubre
// lo que la salida estructurada no fija (4 opciones exactas, índice 0-3) y
// el caso sin ella (`json_object`, que solo garantiza JSON VÁLIDO). A diferencia del resumen (que sanea saltando campos
// inválidos en silencio), acá un shape roto en `prompt`/`options`/
// `correctOptionIndex` SÍ tiene que ser un error explícito: una pregunta
// con 3 opciones, o con `correctOptionIndex` fuera de rango, no tiene
// ningún valor a medias — no hay forma de "arreglarla" sin inventar
// contenido, así que se rechaza entera.
//
// `suggestedDurationSeconds` es distinto a propósito: es una
// RECOMENDACIÓN, no una parte estructural de la pregunta — si vino mal o
// no vino, no tiene sentido tirar toda la pregunta (que sí es válida) por
// eso. Acá se pasa tal cual (sin validar el valor) — la validación contra
// el conjunto de presets permitidos vive en `questionService.
// generatePreview`, que además conoce el default a usar si esto no sirve.
//
// Etapa 85 — si esto tira, `requestJson` vuelve a pedir la pregunta sola;
// el docente solo ve un error si OpenAI no responde en ningún intento.
function parseQuestionResponse(rawText) {
  let parsed;
  try {
    parsed = parseJsonText(rawText);
  } catch (err) {
    throw new Error('OpenAI no devolvió JSON válido para la pregunta.');
  }

  if (typeof parsed?.prompt !== 'string' || !parsed.prompt.trim()) {
    throw new Error('OpenAI devolvió una pregunta sin enunciado.');
  }
  if (!Array.isArray(parsed.options) || parsed.options.length !== 4 || !parsed.options.every((o) => typeof o === 'string' && o.trim())) {
    throw new Error('OpenAI devolvió una cantidad de opciones distinta de 4.');
  }
  // Un "2" como texto es la misma respuesta, solo mal tipada.
  const correctOptionIndex = typeof parsed.correctOptionIndex === 'string' ? Number(parsed.correctOptionIndex) : parsed.correctOptionIndex;
  if (!Number.isInteger(correctOptionIndex) || correctOptionIndex < 0 || correctOptionIndex > 3) {
    throw new Error('OpenAI devolvió un índice de respuesta correcta fuera de rango (0-3).');
  }

  return {
    prompt: parsed.prompt,
    options: parsed.options,
    correctOptionIndex,
    suggestedDurationSeconds: parsed.suggestedDurationSeconds,
  };
}

// Salida estructurada (ver `openAIJsonRequest.js`).
const QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'options', 'correctOptionIndex', 'suggestedDurationSeconds'],
  properties: {
    prompt: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    correctOptionIndex: { type: 'integer' },
    suggestedDurationSeconds: { type: 'integer', enum: [15, 30, 45, 60] },
  },
};

// Único archivo que importa el SDK de `openai` para preguntas — el resto
// de la app (`services/questionService.js`) solo conoce el contrato de
// `QuestionProvider`. Usa Chat Completions con salida estructurada y
// reintentos, igual que el resto (ver `openAIJsonRequest.js`).
class OpenAIQuestionProvider extends QuestionProvider {
  constructor() {
    super();
    // Perezoso — mismo motivo que el resto de los proveedores de OpenAI de
    // esta app: `providers/index.js` instancia esto de forma EAGER, sin
    // condicionarlo a `ENABLE_AI_QUESTION_GENERATION`, así que crear el
    // cliente acá tumbaría el server sin `OPENAI_API_KEY`, incluso con el
    // flag apagado.
    this.client = null;
  }

  async generateQuestion(context = {}) {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY no está configurada — no se puede generar la pregunta con IA.');
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: OPENAI_API_KEY });
    }

    const model = process.env.OPENAI_QUESTION_MODEL || DEFAULT_QUESTION_MODEL;

    // El error crudo del SDK queda en el log (ver `openAIJsonRequest.js`);
    // el docente solo recibe `failureMessage`, que el controller propaga
    // tal cual para que el frontend lo muestre y ofrezca reintentar.
    const { value: question, response } = await requestJson({
      client: this.client,
      label: 'la pregunta',
      model,
      // ~0.4: ni tan bajo como el resumen (0.25 — ahí se quiere
      // extracción fiel, sin variación), ni el default alto — una
      // pregunta necesita algo de variedad entre llamadas seguidas
      // (evitar preguntas calcadas si el docente pide "otra"), pero
      // sigue debiendo basarse estrictamente en el contexto real.
      temperature: 0.4,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(context) },
      ],
      schemaName: 'pregunta_en_vivo',
      schema: QUESTION_SCHEMA,
      parse: parseQuestionResponse,
      failureMessage: 'No se pudo generar la pregunta con IA — reintentá en unos segundos.',
    });

    // Visibilidad real del costo — esto corre en cada "Generar
    // pregunta"/"Generar otra pregunta" durante la clase, muchas veces
    // por hora, a diferencia del resumen del documento (una vez por
    // carga).
    console.log(
      `[Sparkle][IA] Pregunta generada — tokens: prompt=${response.usage?.prompt_tokens ?? 'n/a'}, ` +
        `completion=${response.usage?.completion_tokens ?? 'n/a'}, total=${response.usage?.total_tokens ?? 'n/a'} ` +
        `(modelo="${response.model || model}").`
    );

    return question;
  }
}

module.exports = { OpenAIQuestionProvider };
