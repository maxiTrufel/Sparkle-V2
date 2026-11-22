const OpenAI = require('openai');
const { ClassSummaryProvider } = require('./classSummaryProvider');
const { requestJson, parseJsonText } = require('./openAIJsonRequest');

// Mismo criterio que el resto de los proveedores de OpenAI de esta app: la
// API key se lee una sola vez (no cambia en caliente); modelo y tope de
// caracteres se leen a CALL-TIME, dentro de `summarize`, para poder
// cambiarlos sin reiniciar el proceso y que los tests los toggleen por
// caso. 'gpt-4o-mini' por default — esto corre COMO MUCHO una vez por
// clase (el resultado se cachea por reunión, ver
// `services/classSummaryCache.js`), así que el costo real de esta
// llamada puntual importa menos que el de preguntas (que corre muchas
// veces por clase), pero se mantiene el mismo modelo económico por
// consistencia.
const { OPENAI_API_KEY } = process.env;
const DEFAULT_SUMMARY_MODEL = 'gpt-4o-mini';
// 60.000 caracteres por default (vs. 40.000 del resumen de documento,
// `OPENAI_SUMMARY_MAX_CHARS`) — acá se trunca la TRANSCRIPCIÓN COMPLETA de
// una clase entera, no un PDF, así que el tope natural es más alto.
const DEFAULT_TRANSCRIPT_MAX_CHARS = 60000;

// Instrucciones FIJAS del resumen de clase — a diferencia del resumen de
// documento (`openAIDocumentAnalysisProvider.js`, pensado como CONTEXTO
// para otro proceso automático), este SÍ lo lee el alumno directamente:
// tiene que reflejar lo que REALMENTE se dijo en la clase, usando el
// documento como MARCO TEMÁTICO (para dar contexto/vocabulario), nunca
// como fuente principal — si el docente no llegó a cubrir un tema del
// PDF, ese tema NO tiene que aparecer en el resumen.
const SYSTEM_PROMPT = `Generás el resumen de UNA clase en vivo para que lo lea un alumno que quiere repasar lo que se
explicó.

Reglas, todas igual de importantes:
- La FUENTE PRINCIPAL es la TRANSCRIPCIÓN de la clase — es lo que el docente REALMENTE dijo. Los
  temas y conceptos clave del documento son solo un MARCO TEMÁTICO para entender de qué materia se
  trata y con qué vocabulario nombrarla — nunca una lista de contenidos a cubrir sí o sí.
- Si el documento tiene un tema o concepto que el docente NO llegó a explicar en la transcripción,
  ESE TEMA NO APARECE en el resumen — ni mencionado de pasada. Preferí un resumen más corto y fiel
  a lo dicho antes que uno más completo pero inventado o basado solo en el documento.
- La transcripción es reconocimiento de voz en vivo: puede venir sucia, entrecortada, con palabras
  mal reconocidas, repetidas, o cortes de audio. Tolerá esos errores e interpretá la intención
  general — no descartes un fragmento entero por un par de palabras raras, y apoyate en los temas/
  conceptos del documento para desambiguar cuando haga falta.
- Formato de salida: bullet points, no prosa corrida. Cada bullet es una idea concreta de lo que se
  explicó (un tema, una definición, un ejemplo que dio el docente) — nunca un bullet "resumen de
  los bullets anteriores".
- Extensión TOTAL (sumando todos los bullets): entre 200 y 250 palabras. Ni menos (dejaría afuera
  contenido real) ni más (dejaría de ser un resumen).
- Español, directo, sin rodeos ni prefijos tipo "En esta clase se vio...": andá directo al
  contenido de cada bullet.

Respondé ÚNICAMENTE con un objeto JSON, sin bloques de código markdown y sin texto antes o
después, con EXACTAMENTE esta forma:
{"bullets": ["primer punto del resumen", "segundo punto del resumen"]}`;

// Instrucciones FIJAS para el camino (b) — la clase no tuvo transcripción
// suficiente (ver `classSummaryService.buildCommonSummary`), pero el
// documento SÍ tiene temas/conceptos: se arma un resumen del MATERIAL DE
// APOYO, nunca de "lo que se dijo en clase" (no hay forma de saberlo sin
// transcripción). La diferencia con `SYSTEM_PROMPT` de arriba no es solo
// de contenido (temas del documento vs. transcripción) sino de VOZ: acá
// el modelo tiene EXPRESAMENTE PROHIBIDO escribir como si el docente
// hubiera explicado esto — es el motivo por el que este es un prompt
// aparte, no una variación del mismo con el campo transcripción vacío.
const DOCUMENT_ONLY_SYSTEM_PROMPT = `Armás un resumen del MATERIAL DE APOYO (el documento/PDF que preparó el docente) de una
clase — esta clase en particular NO tuvo transcripción suficiente para saber qué se explicó
realmente, así que este resumen se arma SOLO a partir de los temas y conceptos clave del
documento, nunca de la clase dictada (que no podés conocer).

Reglas, todas igual de importantes:
- PROHIBIDO escribir como si el docente hubiera explicado esto: nunca uses formulaciones tipo
  "se explicó...", "el docente dijo...", "vimos que...", "en la clase se vio...". Estás
  resumiendo el CONTENIDO DEL MATERIAL, no una clase — usá formulaciones neutras sobre el
  TEMARIO ("el material cubre...", "según el documento...", "los temas incluyen...", "se
  define...").
- Basate ÚNICAMENTE en los temas y conceptos clave que se te pasan — nunca inventes contenido
  que no esté ahí, ni asumas que se profundizó más de lo que dice cada definición.
- Formato de salida: bullet points, no prosa corrida. Cada bullet es un tema o concepto concreto
  del material — nunca un bullet "resumen de los bullets anteriores".
- Extensión TOTAL (sumando todos los bullets): entre 200 y 250 palabras.
- Español, directo, sin rodeos.

Respondé ÚNICAMENTE con un objeto JSON, sin bloques de código markdown y sin texto antes o
después, con EXACTAMENTE esta forma:
{"bullets": ["primer punto del resumen", "segundo punto del resumen"]}`;

function formatTopics(mainTopics) {
  if (!Array.isArray(mainTopics) || mainTopics.length === 0) return '(sin temas disponibles)';
  return mainTopics.map((topic) => `- ${topic}`).join('\n');
}

function formatConcepts(keyConcepts) {
  if (!Array.isArray(keyConcepts) || keyConcepts.length === 0) return '(sin conceptos disponibles)';
  return keyConcepts.map((concept) => `- ${concept.term}: ${concept.definition}`).join('\n');
}

// Arma el texto plano de la transcripción — mismo formato "[speaker]:
// texto" que `providers/openAIQuestionProvider.js#formatTranscript`, una
// línea por segmento, en el orden cronológico en que ya vienen (ver
// `transcriptRepository.getAllSegments`).
function formatTranscriptText(transcriptSegments) {
  if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) return '';
  return transcriptSegments.map((segment) => `[${segment.speaker || 'Desconocido'}]: ${segment.text}`).join('\n');
}

// Trunca la transcripción YA FORMATEADA al máximo configurado
// (`OPENAI_CLASS_SUMMARY_MAX_CHARS`) — a diferencia de
// `truncateForSummary` del resumen de documento (que recorta el FINAL,
// `text.slice(0, maxChars)`), acá se recorta el INICIO
// (`text.slice(text.length - maxChars)`): para una clase, el tramo FINAL
// de la transcripción es el que más probablemente todavía no se
// resumió/repasó en ningún lado, así que es preferible perder el
// arranque de la clase antes que el cierre. Nunca silencioso: si corta,
// queda logueado con el tamaño real, para que truncar una clase que
// necesitaba más contexto sea visible.
function truncateTranscriptForSummary(text, maxChars) {
  if (text.length <= maxChars) return text;
  console.log(
    `[Sparkle][IA] Transcripción truncada para el resumen de clase: ${text.length} → ${maxChars} caracteres ` +
      `(se recortó el INICIO, se conserva el tramo final — ver OPENAI_CLASS_SUMMARY_MAX_CHARS).`
  );
  return text.slice(text.length - maxChars);
}

function buildUserMessage({ mainTopics, keyConcepts, transcriptText }) {
  return `TEMAS DEL DOCUMENTO (marco temático — NO asumas que todos se explicaron en la clase):
${formatTopics(mainTopics)}

CONCEPTOS CLAVE DEL DOCUMENTO (marco temático, mismo criterio que arriba):
${formatConcepts(keyConcepts)}

TRANSCRIPCIÓN COMPLETA DE LA CLASE (reconocimiento de voz en vivo, puede tener errores; ES LA FUENTE PRINCIPAL):
${transcriptText || 'No hay transcripción disponible.'}`;
}

// User message del camino (b) — SIN transcripción (no se pasa ni vacía,
// para no darle al modelo la tentación de comentar su ausencia): solo los
// temas/conceptos del documento, que acá SÍ son la fuente completa (no un
// mero "marco").
function buildDocumentOnlyUserMessage({ mainTopics, keyConcepts }) {
  return `TEMAS DEL MATERIAL:
${formatTopics(mainTopics)}

CONCEPTOS CLAVE DEL MATERIAL:
${formatConcepts(keyConcepts)}`;
}

// Parseo DEFENSIVO — mismo criterio que `openAIDocumentAnalysisProvider.js`:
// cubre el caso sin salida estructurada (`json_object`, que solo garantiza
// JSON VÁLIDO, no esta forma puntual). Se rechaza si falta el campo `bullets` (array) — eso SÍ es un
// formato inválido, sin ningún valor a medias.
//
// Diagnóstico en vivo — un `bullets: []` (array VACÍO, pero presente y
// bien tipado) NO es un error de formato: el propio system prompt le pide
// al modelo que no invente contenido si la transcripción no alcanza para
// un resumen real, y `[]` es exactamente esa respuesta obedeciendo la
// instrucción. Se devuelve tal cual, sin tirar nada acá — es
// `classSummaryService.buildCommonSummary` quien decide qué significa un
// resultado vacío (transcripción insuficiente, ver ese archivo), no este
// provider.
//
// Etapa 85 — si esto tira, `requestJson` vuelve a pedir el resumen solo
// (el contenido crudo queda en el log de ese archivo).
function parseClassSummaryResponse(rawText) {
  let parsed;
  try {
    parsed = parseJsonText(rawText);
  } catch (err) {
    throw new Error('No se pudo interpretar el resumen que devolvió OpenAI.');
  }

  if (!Array.isArray(parsed?.bullets)) {
    throw new Error('OpenAI devolvió un resumen sin el campo "bullets" (array).');
  }

  const bullets = parsed.bullets.filter((bullet) => typeof bullet === 'string' && bullet.trim().length > 0);
  return { bullets };
}

// Salida estructurada (ver `openAIJsonRequest.js`) — mismo esquema para
// los dos caminos (transcripción o solo documento).
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bullets'],
  properties: { bullets: { type: 'array', items: { type: 'string' } } },
};

// Único archivo que importa el SDK de `openai` para el resumen de clase —
// el resto de la app (`services/classSummaryService.js`) solo conoce el
// contrato de `ClassSummaryProvider`.
class OpenAIClassSummaryProvider extends ClassSummaryProvider {
  constructor() {
    super();
    // Perezoso — mismo motivo que el resto: `providers/index.js` instancia
    // esto de forma EAGER, sin condicionarlo a `ENABLE_AI_CLASS_SUMMARY`,
    // así que crear el cliente acá tumbaría el server sin `OPENAI_API_KEY`,
    // incluso con el flag apagado.
    this.client = null;
  }

  // `source` — 'transcript' (default, camino a) o 'document' (camino b,
  // ver `classSummaryService.buildCommonSummary`): decide qué PROMPT/user
  // message se usa, no solo qué datos se mandan. `transcriptSegments` se
  // ignora por completo en modo 'document' (ni se formatea ni se trunca —
  // no tiene sentido gastar ese trabajo si el prompt ni lo va a mencionar).
  async summarize({ source = 'transcript', mainTopics, keyConcepts, transcriptSegments } = {}) {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY no está configurada — no se puede generar el resumen de la clase.');
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: OPENAI_API_KEY });
    }

    const model = process.env.OPENAI_CLASS_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL;

    let systemPrompt;
    let userMessage;
    if (source === 'document') {
      systemPrompt = DOCUMENT_ONLY_SYSTEM_PROMPT;
      userMessage = buildDocumentOnlyUserMessage({ mainTopics, keyConcepts });
    } else {
      const maxChars =
        Number.parseInt(process.env.OPENAI_CLASS_SUMMARY_MAX_CHARS, 10) || DEFAULT_TRANSCRIPT_MAX_CHARS;
      const transcriptText = truncateTranscriptForSummary(formatTranscriptText(transcriptSegments), maxChars);
      systemPrompt = SYSTEM_PROMPT;
      userMessage = buildUserMessage({ mainTopics, keyConcepts, transcriptText });
    }

    const { value: parsed, response } = await requestJson({
      client: this.client,
      label: `el resumen de la clase (fuente="${source}")`,
      model,
      // Baja, igual criterio que el resumen de documento (0.25): se
      // busca fidelidad a lo que se dijo, no variación creativa.
      temperature: 0.25,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      schemaName: 'resumen_de_clase',
      schema: SUMMARY_SCHEMA,
      parse: parseClassSummaryResponse,
      failureMessage: 'No se pudo generar el resumen de la clase con IA — reintentá en unos segundos.',
    });

    // Visibilidad real del costo — como mucho corre UNA vez por clase (el
    // resultado se cachea por reunión, ver
    // `services/classSummaryCache.js`), así que este log alcanza para
    // saber el gasto exacto por clase resumida, sin tener que revisar el
    // dashboard de OpenAI a mano.
    console.log(
      `[Sparkle][IA] Resumen de clase generado (fuente="${source}") — tokens: prompt=${response.usage?.prompt_tokens ?? 'n/a'}, ` +
        `completion=${response.usage?.completion_tokens ?? 'n/a'}, total=${response.usage?.total_tokens ?? 'n/a'} ` +
        `(modelo="${response.model || model}").`
    );

    return {
      bullets: parsed.bullets,
      keyConcepts: Array.isArray(keyConcepts) ? keyConcepts : [],
      model: response.model || model,
      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
    };
  }
}

module.exports = { OpenAIClassSummaryProvider };
