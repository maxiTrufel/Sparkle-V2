const OpenAI = require('openai');
const { ClassReportProvider } = require('./classReportProvider');
const { requestJson, parseJsonText } = require('./openAIJsonRequest');

// Salida estructurada (ver `openAIJsonRequest.js`).
const STRING_LIST = { type: 'array', items: { type: 'string' } };
const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['strengths', 'weaknesses', 'questionDiagnostics', 'studentRecommendations', 'suggestedTopics'],
  properties: {
    strengths: STRING_LIST,
    weaknesses: STRING_LIST,
    questionDiagnostics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['questionId', 'diagnosis', 'explanation'],
        properties: {
          questionId: { type: 'integer' },
          diagnosis: { type: 'string', enum: ['dificultad_tema', 'pregunta_confusa'] },
          explanation: { type: 'string' },
        },
      },
    },
    studentRecommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'recommendation'],
        properties: { name: { type: 'string' }, recommendation: { type: 'string' } },
      },
    },
    suggestedTopics: STRING_LIST,
  },
};

// Mismo criterio que el resto de los proveedores de OpenAI de esta app: la
// API key se lee una sola vez; el modelo se lee a CALL-TIME, dentro de
// `analyze`, para poder cambiarlo sin reiniciar el proceso. 'gpt-4o-mini'
// por default — esto corre COMO MUCHO una vez por reunión (el resultado se
// cachea, ver `services/classReportCache.js`).
const { OPENAI_API_KEY } = process.env;
const DEFAULT_REPORT_MODEL = 'gpt-4o-mini';

const OPTION_LETTERS = ['a', 'b', 'c', 'd'];

const SYSTEM_PROMPT = `Analizás los resultados de una clase en vivo (preguntas de opción múltiple estilo Kahoot) para
armar la sección de análisis pedagógico de un reporte que va a leer el DOCENTE, no los alumnos.

Recibís, por cada pregunta finalizada: el enunciado, las 4 opciones, cuál era la correcta, y cuántos
alumnos eligieron cada opción. Además recibís, por cada alumno, el detalle de qué eligió (o si
salteó) en cada pregunta.

Tu tarea, en un solo objeto JSON:
1. "strengths": 2 a 4 fortalezas del GRUPO como conjunto — temas o tipos de pregunta donde el grupo
   respondió bien en general. Basate en los datos reales, nunca inventes.
2. "weaknesses": 2 a 4 debilidades del GRUPO — temas o tipos de pregunta donde el grupo respondió mal
   en general.
3. "questionDiagnostics": SOLO para las preguntas con una tasa de acierto BAJA (la minoría acertó) —
   para cada una, diagnosticá si el problema fue "dificultad_tema" (el grupo se dividió entre varias
   opciones incorrectas distintas, sin un patrón claro — sugiere que el tema en sí es difícil) o
   "pregunta_confusa" (la GRAN MAYORÍA de los que erraron eligió EL MISMO distractor incorrecto —
   sugiere que esa opción es engañosa o la pregunta está mal redactada, no que el grupo no sepa el
   tema). Si TODAS las preguntas tuvieron buena tasa de acierto, este array queda vacío.
4. "studentRecommendations": una recomendación breve y CONCRETA por cada alumno que tuvo al menos un
   error o salteo — qué tema puntual repasar, basado en SUS respuestas incorrectas/salteadas
   específicas (nunca genérico tipo "repasar todo"). Los alumnos que respondieron todo bien no
   aparecen acá.
5. "suggestedTopics": 2 a 4 temas concretos para reforzar en la PRÓXIMA clase, derivados de las
   debilidades detectadas.

Reglas:
- Español, directo, profesional — es un reporte para un docente, no para un alumno.
- Basate ÚNICAMENTE en los datos que se te pasan — nunca inventes un tema o nombre que no esté ahí.
- Si hay muy pocos datos (una sola pregunta, o ningún alumno con errores), las secciones que
  correspondan pueden quedar con listas cortas o vacías — preferí eso antes que inventar contenido.

Respondé ÚNICAMENTE con un objeto JSON, sin bloques de código markdown y sin texto antes o después,
con EXACTAMENTE esta forma:
{"strengths": ["..."], "weaknesses": ["..."], "questionDiagnostics": [{"questionId": 1, "diagnosis": "dificultad_tema", "explanation": "..."}], "studentRecommendations": [{"name": "...", "recommendation": "..."}], "suggestedTopics": ["..."]}`;

function formatQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return '(sin preguntas finalizadas)';
  return questions
    .map((q, i) => {
      const optionsText = q.optionDistribution
        .map((opt, idx) => `    ${OPTION_LETTERS[idx]}) ${opt.label} — ${opt.count} alumno(s)${opt.correct ? ' [CORRECTA]' : ''}`)
        .join('\n');
      return `Pregunta ${i + 1} (id=${q.id}): ${q.prompt}\n${optionsText}`;
    })
    .join('\n\n');
}

function formatStudentAnswers(studentAnswers) {
  if (!Array.isArray(studentAnswers) || studentAnswers.length === 0) return '(sin respuestas registradas)';
  const byStudent = new Map();
  for (const row of studentAnswers) {
    if (!byStudent.has(row.studentName)) byStudent.set(row.studentName, []);
    byStudent.get(row.studentName).push(row);
  }
  const lines = [];
  for (const [name, rows] of byStudent) {
    const detail = rows
      .map((row) => {
        if (row.skipped) return `pregunta ${row.questionId}: salteó`;
        if (row.selectedOption == null) return `pregunta ${row.questionId}: no respondió`;
        return `pregunta ${row.questionId}: ${row.isCorrect ? 'correcta' : 'incorrecta'}`;
      })
      .join(', ');
    lines.push(`- ${name}: ${detail}`);
  }
  return lines.join('\n');
}

function buildUserMessage({ questions, studentAnswers }) {
  return `PREGUNTAS DE LA CLASE:
${formatQuestions(questions)}

DETALLE DE RESPUESTAS POR ALUMNO:
${formatStudentAnswers(studentAnswers)}`;
}

// Parseo DEFENSIVO — mismo criterio que el resto de los proveedores de esta
// app: cubre el caso sin salida estructurada (`json_object`, que solo
// garantiza JSON válido, no esta forma puntual). Los cuatro arrays son obligatorios (pueden venir vacíos,
// nunca ausentes/con otro tipo).
//
// Etapa 85 — si esto tira, `requestJson` vuelve a pedir el análisis solo.
function parseReportResponse(rawText) {
  let parsed;
  try {
    parsed = parseJsonText(rawText);
  } catch (err) {
    throw new Error('No se pudo interpretar el análisis que devolvió OpenAI.');
  }

  const arrays = ['strengths', 'weaknesses', 'questionDiagnostics', 'studentRecommendations', 'suggestedTopics'];
  for (const field of arrays) {
    if (!Array.isArray(parsed?.[field])) {
      throw new Error(`OpenAI devolvió un análisis sin el campo "${field}" (array).`);
    }
  }

  return {
    strengths: parsed.strengths.filter((s) => typeof s === 'string' && s.trim().length > 0),
    weaknesses: parsed.weaknesses.filter((s) => typeof s === 'string' && s.trim().length > 0),
    questionDiagnostics: parsed.questionDiagnostics.filter(
      (d) => d && typeof d.explanation === 'string' && (d.diagnosis === 'dificultad_tema' || d.diagnosis === 'pregunta_confusa')
    ),
    studentRecommendations: parsed.studentRecommendations.filter(
      (r) => r && typeof r.name === 'string' && typeof r.recommendation === 'string'
    ),
    suggestedTopics: parsed.suggestedTopics.filter((s) => typeof s === 'string' && s.trim().length > 0),
  };
}

// Único archivo que importa el SDK de `openai` para el análisis del
// reporte — el resto de la app (`services/classReportService.js`) solo
// conoce el contrato de `ClassReportProvider`.
class OpenAIClassReportProvider extends ClassReportProvider {
  constructor() {
    super();
    // Perezoso — mismo motivo que el resto: `providers/index.js` instancia
    // esto de forma EAGER, sin condicionarlo a `ENABLE_AI_CLASS_REPORT`, así
    // que crear el cliente acá tumbaría el server sin `OPENAI_API_KEY`,
    // incluso con el flag apagado.
    this.client = null;
  }

  async analyze({ questions, studentAnswers } = {}) {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY no está configurada — no se puede generar el análisis del reporte.');
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: OPENAI_API_KEY });
    }

    const model = process.env.OPENAI_CLASS_REPORT_MODEL || DEFAULT_REPORT_MODEL;
    const userMessage = buildUserMessage({ questions, studentAnswers });

    const { value: parsed, response } = await requestJson({
      client: this.client,
      label: 'el análisis del reporte',
      model,
      // Baja, igual criterio que el resto de los proveedores de esta
      // app: se busca un diagnóstico fiel a los datos, no variación
      // creativa.
      temperature: 0.25,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      schemaName: 'analisis_del_reporte',
      schema: REPORT_SCHEMA,
      parse: parseReportResponse,
      failureMessage: 'No se pudo generar el análisis del reporte con IA — reintentá en unos segundos.',
    });

    // Visibilidad real del costo — como mucho corre UNA vez por reunión
    // (cacheado, ver `services/classReportCache.js`).
    console.log(
      `[Sparkle][IA] Análisis de reporte generado — tokens: prompt=${response.usage?.prompt_tokens ?? 'n/a'}, ` +
        `completion=${response.usage?.completion_tokens ?? 'n/a'}, total=${response.usage?.total_tokens ?? 'n/a'} ` +
        `(modelo="${response.model || model}").`
    );

    return {
      ...parsed,
      model: response.model || model,
      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
    };
  }
}

module.exports = { OpenAIClassReportProvider };
