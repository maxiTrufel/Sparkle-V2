const OpenAI = require('openai');
const { RecoverySummaryProvider } = require('./recoverySummaryProvider');
const { requestJson, parseJsonText } = require('./openAIJsonRequest');

// Mismo criterio que el resto de los proveedores de OpenAI de esta app: la
// API key se lee una sola vez (no cambia en caliente); modelo y tope de
// caracteres se leen a CALL-TIME, dentro de `summarize`, para poder
// cambiarlos sin reiniciar el proceso. 'gpt-4o-mini' por default — esto
// corre potencialmente varias veces por clase (cada alumno que aprieta
// "Recuperar contenido"), a diferencia del resumen final (una sola vez por
// reunión, cacheado), así que el modelo económico importa más acá, no
// menos.
const { OPENAI_API_KEY } = process.env;
const DEFAULT_MODEL = 'gpt-4o-mini';
// 8.000 caracteres por default — MUY por debajo del tope del resumen de
// clase completa (60.000, `OPENAI_CLASS_SUMMARY_MAX_CHARS`): acá la
// "transcripción" es una ventana de 2-3 minutos, no una clase entera, así
// que en la práctica nunca debería acercarse a este tope salvo un caso
// extremo (varias personas hablando sin pausa) — el tope existe igual, por
// consistencia con el resto de los proveedores, nunca por necesidad real.
const DEFAULT_MAX_CHARS = 8000;

// Instrucciones FIJAS — a diferencia del resumen de clase completa (que
// resume TODA la clase), esto resume un FRAGMENTO CORTO Y RECIENTE (los
// últimos 2-3 minutos) para un alumno que se distrajo y quiere saber, ya
// mismo, de qué habló el docente mientras no prestaba atención. El
// documento del docente es marco temático, igual que en
// `openAIClassSummaryProvider.js` — la transcripción SIEMPRE tiene
// prioridad como fuente principal, EXCEPTO en el camino de fallback (ver
// la regla marcada como tal, más abajo): si el fragmento no da para nada,
// el documento pasa a ser la fuente principal en su lugar, para no dejar
// al alumno con un resumen vacío pudiendo darle algo útil sobre la
// materia.
const SYSTEM_PROMPT = `Un alumno estuvo distraído durante los últimos minutos de una clase en vivo y quiere saber, en
un vistazo, de qué habló el docente en ese fragmento puntual — NO de la clase completa, solo de
este tramo reciente.

Reglas, todas igual de importantes (salvo la de FALLBACK, que es una excepción explícita a las
demás — se aplica solo en el caso que ella misma describe):
- La FUENTE PRINCIPAL es el FRAGMENTO DE TRANSCRIPCIÓN que se te pasa — es lo que el docente
  REALMENTE dijo en esos minutos. Los temas y conceptos clave del documento son, por defecto,
  solo un MARCO TEMÁTICO para entender de qué materia se trata y con qué vocabulario nombrarla —
  nunca una lista de contenidos a asumir como dados, SALVO en el caso de FALLBACK de abajo.
- Si el documento tiene un tema que el fragmento no menciona, ESE TEMA NO APARECE en el resumen
  (salvo en el caso de FALLBACK). Preferí un resumen más corto y fiel a lo dicho antes que uno
  más completo pero inventado.
- La transcripción es reconocimiento de voz en vivo: puede venir sucia, entrecortada, con
  palabras mal reconocidas o cortes de audio. Tolerá esos errores e interpretá la intención
  general — esto no es lo mismo que "fragmento insuficiente" (ver FALLBACK): una transcripción
  sucia pero con contenido real sigue siendo la fuente principal, se interpreta con tolerancia,
  no se descarta.
- FALLBACK — usar ÚNICAMENTE si el fragmento de transcripción está VACÍO, es DEMASIADO CORTO, o
  no alcanza para identificar ningún tema puntual tratado en él: en ese caso, y SOLO en ese caso,
  en vez de devolver bullets vacíos, usá los TEMAS DEL DOCUMENTO y los CONCEPTOS CLAVE como
  fuente PRINCIPAL en su lugar, y armá un resumen de los temas GENERALES de la clase a partir de
  ellos. PROHIBIDO en este camino escribir como si el docente hubiera dicho esto en este tramo
  puntual (nunca "en este fragmento se habló de...", "el docente dijo...", "se explicó..."): usá
  formulaciones neutras sobre el TEMARIO general de la materia ("el material de la clase cubre...",
  "según el documento...", "los temas incluyen..."). Es un plan de RESERVA, no una alternativa
  igual de válida — la transcripción tiene SIEMPRE prioridad cuando alcanza para identificar algo
  real; recurrí al documento únicamente cuando el fragmento realmente no da para nada. Si TAMPOCO
  el documento tiene temas o conceptos disponibles, ahí sí devolvé bullets vacíos — no hay
  ninguna fuente real de la que armar un resumen.
- Formato de salida: EXACTAMENTE entre 3 y 5 bullet points, no prosa corrida (esto incluye al
  camino de FALLBACK). Cada bullet es un tema concreto — nunca un bullet "resumen de los bullets
  anteriores". Nunca rellenes con contenido inventado para llegar al mínimo.
- Español, conciso, directo — cada bullet es una oración corta, sin rodeos: andá directo al
  contenido.

Respondé ÚNICAMENTE con un objeto JSON, sin bloques de código markdown y sin texto antes o
después, con EXACTAMENTE esta forma:
{"bullets": ["primer tema tratado", "segundo tema tratado"]}`;

function formatTopics(mainTopics) {
  if (!Array.isArray(mainTopics) || mainTopics.length === 0) return '(sin temas disponibles)';
  return mainTopics.map((topic) => `- ${topic}`).join('\n');
}

function formatConcepts(keyConcepts) {
  if (!Array.isArray(keyConcepts) || keyConcepts.length === 0) return '(sin conceptos disponibles)';
  return keyConcepts.map((concept) => `- ${concept.term}: ${concept.definition}`).join('\n');
}

// Mismo formato "[speaker]: texto" que el resto de los proveedores que
// consumen transcripción (`openAIQuestionProvider.js`,
// `openAIClassSummaryProvider.js`) — una línea por segmento, ya en orden
// cronológico (ver `transcriptRepository.getSegmentsSince`).
function formatTranscriptText(transcriptSegments) {
  if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) return '';
  return transcriptSegments.map((segment) => `[${segment.speaker || 'Desconocido'}]: ${segment.text}`).join('\n');
}

// Trunca el FINAL de la ventana (a diferencia de `openAIClassSummaryProvider`,
// que trunca el INICIO de la clase completa) — acá la ventana YA es "lo más
// reciente", así que si por algún motivo excede el tope, tiene más sentido
// conservar el ARRANQUE de la ventana (más cerca de donde el alumno se
// distrajo) que el final.
function truncateForSummary(text, maxChars) {
  if (text.length <= maxChars) return text;
  console.log(
    `[Sparkle][IA] Fragmento de recuperación truncado: ${text.length} → ${maxChars} caracteres ` +
      '(ver OPENAI_RECOVERY_SUMMARY_MAX_CHARS).'
  );
  return text.slice(0, maxChars);
}

function buildUserMessage({ mainTopics, keyConcepts, transcriptText, windowMinutes }) {
  return `TEMAS DEL DOCUMENTO (marco temático — NO asumas que se mencionaron en este fragmento):
${formatTopics(mainTopics)}

CONCEPTOS CLAVE DEL DOCUMENTO (marco temático, mismo criterio que arriba):
${formatConcepts(keyConcepts)}

FRAGMENTO DE TRANSCRIPCIÓN — ÚLTIMOS ${windowMinutes} MINUTOS (reconocimiento de voz en vivo, puede tener errores; ES LA FUENTE PRINCIPAL):
${transcriptText || 'No hay transcripción disponible para este tramo.'}`;
}

// Parseo DEFENSIVO — mismo criterio que `openAIClassSummaryProvider.js`:
// cubre el caso sin salida estructurada (`json_object`, que solo garantiza
// JSON VÁLIDO, no esta forma puntual). Un `bullets: []` (vacío pero bien tipado) no es un error de
// formato — es una respuesta legítima cuando el fragmento no tenía nada
// real que resumir; `services/recoverySummaryService.js` es quien decide
// qué significa eso, no este provider.
//
// Etapa 85 — si esto tira, `requestJson` vuelve a pedir el resumen solo.
function parseRecoverySummaryResponse(rawText) {
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

// Salida estructurada (ver `openAIJsonRequest.js`).
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bullets'],
  properties: { bullets: { type: 'array', items: { type: 'string' } } },
};

// Único archivo que importa el SDK de `openai` para "Recuperar contenido"
// — el resto de la app (`services/recoverySummaryService.js`) solo conoce
// el contrato de `RecoverySummaryProvider`.
class OpenAIRecoverySummaryProvider extends RecoverySummaryProvider {
  constructor() {
    super();
    // Perezoso — mismo motivo que el resto: `providers/index.js` instancia
    // esto de forma EAGER, sin condicionarlo a `RECOVERY_SUMMARY_ENABLED`,
    // así que crear el cliente acá tumbaría el server sin `OPENAI_API_KEY`,
    // incluso con el flag apagado.
    this.client = null;
  }

  async summarize({
    mainTopics, keyConcepts, transcriptSegments, windowMinutes,
  } = {}) {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY no está configurada — no se puede generar el resumen de recuperación.');
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: OPENAI_API_KEY });
    }

    const model = process.env.OPENAI_RECOVERY_SUMMARY_MODEL || DEFAULT_MODEL;
    const maxChars = Number.parseInt(process.env.OPENAI_RECOVERY_SUMMARY_MAX_CHARS, 10) || DEFAULT_MAX_CHARS;
    const transcriptText = truncateForSummary(formatTranscriptText(transcriptSegments), maxChars);
    const userMessage = buildUserMessage({
      mainTopics, keyConcepts, transcriptText, windowMinutes,
    });

    const { value: parsed, response } = await requestJson({
      client: this.client,
      label: 'el resumen de recuperación',
      model,
      // Baja, igual criterio que el resto: fidelidad a lo que se dijo,
      // no variación creativa.
      temperature: 0.25,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      schemaName: 'resumen_de_recuperacion',
      schema: SUMMARY_SCHEMA,
      parse: parseRecoverySummaryResponse,
      failureMessage: 'No se pudo generar el resumen con IA — reintentá en unos segundos.',
    });

    console.log(
      `[Sparkle][IA] Resumen de recuperación generado (ventana=${windowMinutes}min) — tokens: prompt=${response.usage?.prompt_tokens ?? 'n/a'}, ` +
        `completion=${response.usage?.completion_tokens ?? 'n/a'}, total=${response.usage?.total_tokens ?? 'n/a'} ` +
        `(modelo="${response.model || model}").`
    );

    return {
      bullets: parsed.bullets,
      model: response.model || model,
      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
    };
  }
}

module.exports = { OpenAIRecoverySummaryProvider };
