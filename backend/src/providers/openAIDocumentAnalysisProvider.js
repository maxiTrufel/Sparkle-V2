const OpenAI = require('openai');
const { DocumentSummaryProvider } = require('./documentSummaryProvider');
const { requestJson, parseJsonText } = require('./openAIJsonRequest');

// Salida estructurada (ver `openAIJsonRequest.js`).
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mainTopics', 'keyConcepts'],
  properties: {
    mainTopics: { type: 'array', items: { type: 'string' } },
    keyConcepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'definition'],
        properties: { term: { type: 'string' }, definition: { type: 'string' } },
      },
    },
  },
};

// La API key SÍ se lee una sola vez acá (no cambia en caliente, y sin
// ella este provider no puede llamar a OpenAI en absoluto, ver el chequeo
// en `summarize`). `OPENAI_SUMMARY_MODEL`/`OPENAI_SUMMARY_MAX_CHARS`, en
// cambio, se leen a CALL-TIME, dentro de `summarize` (mismo criterio que
// `ENABLE_AI_DOCUMENT_ANALYSIS` en `documentAnalysisService.js`): permite
// cambiarlas sin reiniciar el proceso, y que los tests las togglee por
// caso sin recargar módulos.
//   - OPENAI_SUMMARY_MODEL: 'gpt-4o-mini' por default — modelo económico,
//     de sobra para resumir apuntes de clase; cambiarlo no requiere tocar
//     código, solo esta env var (único lugar de la app que la lee).
//   - OPENAI_SUMMARY_MAX_CHARS: cuántos caracteres del texto extraído se
//     mandan como máximo (ver `truncateForSummary`, más abajo) — pensado
//     para limitar el gasto de tokens de entrada, no la calidad del
//     resumen: para apuntes de clase, 40.000 caracteres alcanzan de
//     sobra.
const { OPENAI_API_KEY } = process.env;
const DEFAULT_SUMMARY_MODEL = 'gpt-4o-mini';
const DEFAULT_SUMMARY_MAX_CHARS = 40000;

// Este resumen NO es para que lo lea un docente — es CONTEXTO COMPACTO
// que otro proceso va a usar después para generar preguntas de
// comprensión (ver `services/documentAnalysisService.js`), así que pide
// temas + conceptos puntuales, nunca una paráfrasis larga del documento.
// La forma exacta se describe acá, en el propio texto del prompt, se exige
// con la salida estructurada (`SUMMARY_SCHEMA`), Y se vuelve a sanear en
// `parseSummaryResponse`: ninguna de las capas asume que las otras alcanzan
// por sí solas.
const SUMMARY_PROMPT = `Sos un asistente que arma un resumen TEMÁTICO Y COMPACTO del material de una
clase, para que otro proceso automático lo use como CONTEXTO al generar preguntas de comprensión —
no es un resumen para que lea un docente, así que no hace falta prosa ni una paráfrasis larga del
documento.

A partir del texto plano de abajo (extraído de un PDF — puede tener ruido propio de la extracción:
saltos de página, encabezados repetidos, palabras cortadas), identificá:

1. Entre 3 y 8 temas principales de la clase, en el ORDEN EXACTO en que se presentan en el
   documento. Cada tema tiene que describir DE QUÉ TRATA el contenido — NUNCA reproducir el
   título de una sección ni copiar la estructura del documento tal cual (títulos y temas NO son
   lo mismo: un título organiza el documento, un tema describe contenido real). Si una sección
   tiene un título vago o administrativo ("Datos adicionales", "Anexo", "Notas",
   "Generalidades"), nombrá el CONTENIDO REAL que hay adentro de esa sección, nunca el título
   vago en sí.

   Reglas EXTRA, todas igual de importantes:
   - NUNCA generes un tema final que compare, resuma o agrupe a los temas anteriores de tu
     propia lista — ni como "tema paraguas" ("Los grandes grupos de dinosaurios") ni como
     "comparación/diferencias" ("Diferencias entre los grupos de dinosaurios", "Comparación
     entre X e Y"). Si te encontrás escribiendo un tema así, BORRALO — la lista tiene que
     terminar en el último tema de contenido real, no en una síntesis de los anteriores.
   - Si el documento tiene VARIAS secciones parecidas entre sí (ej. una por cada grupo/tipo/
     categoría), NO generes un tema por sección con la misma plantilla repetida ("Características
     de los terópodos", "Características de los saurópodos", "Características de los
     ceratópsidos"...). En vez de eso, para cada una nombrá lo que la HACE DISTINTA de las
     demás (qué la define, no que "tiene características") — y si varias secciones son
     demasiado parecidas entre sí como para distinguirlas con algo específico, es preferible
     fusionarlas en MENOS temas de contenido real, nunca multiplicar temas casi idénticos.
   - Cada tema describe UNA sola idea — nunca dos ideas distintas unidas con "y"/coma
     ("Aclaración sobre pterodáctilos y plesiosaurios y la extinción de los dinosaurios" son DOS
     temas, no uno). Una enumeración corta DENTRO de la misma idea sí vale (ej. "Dietas
     carnívora, herbívora y omnívora" es una sola idea: los tipos de dieta).
   - Frase nominal CORTA — sin paréntesis ni aclaraciones entre comas, sin prefijos tipo
     "Aclaración sobre..."/"Sobre..."/"Acerca de...".

   Por ejemplo, para un documento sobre dinosaurios:
   - MAL: ["Clasificación según su alimentación", "Características de los terópodos",
     "Características de los saurópodos", "Los grandes grupos de dinosaurios", "Datos
     adicionales"] — el 2do y 3er tema son la misma plantilla repetida sin decir qué distingue a
     cada grupo, el 4to es un tema paraguas que agrupa a otros, y el 5to copia un título vago sin
     decir qué hay adentro.
   - BIEN: ["Dietas carnívora, herbívora y omnívora", "Terópodos bípedos y su relación con las
     aves", "Saurópodos de cuello largo", "Defensas de ceratópsidos y blindados", "Extinción por
     impacto de asteroide"] — cada tema es una idea de contenido real, y ninguno resume a los
     demás.
2. Los conceptos clave del documento, cada uno con una definición breve (1-2 líneas) tal como se
   explica en el documento — no inventes conceptos que no estén, ni definiciones que no salgan
   del texto.

Escribí los temas y las definiciones en el MISMO IDIOMA que el documento (si el documento está en
español, respondé en español; si está en inglés, respondé en inglés).

Respondé ÚNICAMENTE con un objeto JSON —sin bloques de código markdown (nada de \`\`\`) y sin
ningún texto antes o después—, con EXACTAMENTE esta forma:
{"mainTopics": ["tema 1", "tema 2"], "keyConcepts": [{"term": "concepto", "definition": "definición breve"}]}

TEXTO DEL DOCUMENTO:
"""
`;

// Limpieza del texto ANTES de mandarlo a OpenAI — nunca toca el
// `extractedText` que se persiste/muestra en el panel (eso sigue siendo
// el texto CRUDO tal cual lo devolvió `pdf-parse`, ver
// `services/documentAnalysisService.js`): esta versión limpia es
// exclusiva del input del resumen, para bajar ruido/tokens sin alterar lo
// que el docente inspecciona. Tres pasos: (1) saca líneas que son
// ÚNICAMENTE un número — casi siempre números de página, sin valor
// temático; (2) colapsa espacios/tabs múltiples a uno solo; (3) colapsa
// saltos de línea múltiples a uno solo (el PDF de origen suele traer
// varios saltos seguidos entre secciones/páginas).
function cleanTextForSummary(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\d+\s*$/.test(line))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Trunca el texto YA LIMPIO al máximo configurado (`OPENAI_SUMMARY_MAX_CHARS`)
// — nunca silencioso: si corta, queda logueado con el tamaño real del
// documento, para que truncar un documento que sí necesitaba más contexto
// sea visible y no un misterio dentro de un resumen que "quedó incompleto".
function truncateForSummary(text, originalName, maxChars) {
  if (text.length <= maxChars) return text;
  console.log(
    `[Sparkle][IA] Texto de "${originalName}" truncado para el resumen: ${text.length} → ` +
      `${maxChars} caracteres (ver OPENAI_SUMMARY_MAX_CHARS).`
  );
  return text.slice(0, maxChars);
}

// Parseo DEFENSIVO de la respuesta — nunca deja pasar un campo con el tipo
// equivocado sin sanitizarlo (los descarta en vez de propagarlos), y nunca
// deja que un `JSON.parse` roto tire un error opaco hacia arriba.
//
// Etapa 85 — ahora con salida estructurada (`SUMMARY_SCHEMA`, ver
// `openAIJsonRequest.js`), y si el JSON no se puede leer, `requestJson`
// vuelve a pedir el resumen solo.
function parseSummaryResponse(rawText) {
  let parsed;
  try {
    parsed = parseJsonText(rawText);
  } catch (err) {
    throw new Error('No se pudo interpretar el resumen que devolvió OpenAI.');
  }

  const mainTopics = Array.isArray(parsed?.mainTopics)
    ? parsed.mainTopics.filter((topic) => typeof topic === 'string')
    : [];

  const keyConcepts = Array.isArray(parsed?.keyConcepts)
    ? parsed.keyConcepts
        .filter((item) => item && typeof item.term === 'string' && typeof item.definition === 'string')
        .map((item) => ({ term: item.term, definition: item.definition }))
    : [];

  return { mainTopics, keyConcepts };
}

// Único archivo que importa el SDK de `openai` — el resto de la app
// (`documentAnalysisService.js`) solo conoce el contrato de
// `DocumentSummaryProvider`. Usa la Chat Completions API (no la Responses
// API de versiones anteriores de este proveedor) con salida estructurada y
// reintentos, igual que el resto (ver `openAIJsonRequest.js`).
//
// Recibe TEXTO PLANO ya extraído (ver `summarize`, más abajo) — nunca
// abre el PDF por su cuenta: ese paso corre siempre, antes, en
// `providers/pdfTextExtractionProvider.js`, esté este resumen activo o
// no (ver `services/documentAnalysisService.js`).
class OpenAIDocumentAnalysisProvider extends DocumentSummaryProvider {
  constructor() {
    super();
    // El cliente NO se crea acá — el constructor de `OpenAI` tira una
    // excepción sincrónica si `apiKey` es falsy ("Missing credentials...").
    // `providers/index.js` instancia este provider de forma EAGER al
    // cargar el módulo, SIN condicionarlo a `ENABLE_AI_DOCUMENT_ANALYSIS`
    // (el flag se chequea recién en `documentAnalysisService.js`, a la
    // hora de decidir si llamar a `summarize` o no) — crear el cliente
    // acá tumbaría el server entero al arrancar en cualquier entorno sin
    // `OPENAI_API_KEY` configurada, incluso con el flag apagado. Se crea
    // perezosamente en `summarize`, la primera vez que hace falta de
    // verdad, después de nuestro propio chequeo con un mensaje claro.
    this.client = null;
  }

  async summarize(text, { originalName } = {}) {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY no está configurada — no se puede generar el resumen del documento.');
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: OPENAI_API_KEY });
    }

    const model = process.env.OPENAI_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL;
    const maxChars = Number.parseInt(process.env.OPENAI_SUMMARY_MAX_CHARS, 10) || DEFAULT_SUMMARY_MAX_CHARS;
    const inputText = truncateForSummary(cleanTextForSummary(text), originalName, maxChars);

    // El error crudo del SDK (vocabulario interno de OpenAI) queda en el log
    // de `openAIJsonRequest.js`; acá solo sale `failureMessage`, porque
    // `documentAnalysisService.js` guarda lo que sea que esto tire tal cual
    // en `files.analysis_error`, y de ahí lo lee directo el docente.
    const { value, response } = await requestJson({
      client: this.client,
      label: `el resumen de "${originalName}"`,
      model,
      // Baja a propósito (no el default ~1) — este resumen es para
      // extraer contenido puntual del documento, no para generar texto
      // creativo; menos variación entre corridas del mismo documento.
      temperature: 0.25,
      messages: [{ role: 'user', content: `${SUMMARY_PROMPT}${inputText}\n"""` }],
      schemaName: 'resumen_de_documento',
      schema: SUMMARY_SCHEMA,
      parse: parseSummaryResponse,
      failureMessage: 'No se pudo generar el resumen con IA — reintentá más tarde.',
      // Corre en segundo plano al subir el material (nadie espera con un
      // tope de 45 s), y un documento largo tarda más que el resto.
      timeBudgetMs: 90000,
    });
    const { mainTopics, keyConcepts } = value;

    // Visibilidad real del costo — este resumen corre en cada carga de
    // documento (con el flag activo), así que el uso de tokens por
    // llamada es la única forma de saber cuánto sale de verdad, sin
    // depender de revisar el dashboard de OpenAI a mano.
    console.log(
      `[Sparkle][IA] Resumen de "${originalName}" — tokens: prompt=${response.usage?.prompt_tokens ?? 'n/a'}, ` +
        `completion=${response.usage?.completion_tokens ?? 'n/a'}, total=${response.usage?.total_tokens ?? 'n/a'} ` +
        `(modelo="${response.model || model}").`
    );

    return {
      mainTopics,
      keyConcepts,
      model: response.model || model,
      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
    };
  }
}

module.exports = { OpenAIDocumentAnalysisProvider };
