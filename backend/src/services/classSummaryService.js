const meetingRepository = require('../repositories/meetingRepository');
const transcriptRepository = require('../repositories/transcriptRepository');
const questionAnswerRepository = require('../repositories/questionAnswerRepository');
const roleService = require('./roleService');
const classService = require('./classService');
const documentAnalysisService = require('./documentAnalysisService');
const classSummaryCache = require('./classSummaryCache');
const { openAIClassSummaryProvider } = require('../providers');

// Orquesta el "Obtener resumen de la clase" del alumno — DOS partes bien
// separadas (ver el comentario de `getClassSummary`, más abajo):
//   1. La parte COMÚN (bullets del resumen real de la clase) — UNA sola
//      llamada a OpenAI por reunión, cacheada (ver `classSummaryCache.js`).
//   2. La parte PERSONALIZADA ("Para repasar") — cero llamadas a IA, arma
//      todo a partir de `question_answers`/`questions`, ya persistidos.

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const OPTION_LETTERS = ['a', 'b', 'c', 'd'];

// Diagnóstico en vivo (2026-07-26) — un docente/alumno probó con una
// clase de prueba de segundos de duración; la transcripción real tenía 3
// segmentos / 59 caracteres totales. El modelo devolvió `{"bullets": []}`
// — JSON válido, shape correcto, obedeciendo la instrucción del prompt de
// no inventar contenido sin transcripción real que resumir. El parser
// VIEJO trataba ese array vacío como un error de formato (`parseClassSummaryResponse`
// tiraba "no devolvió ningún punto"), lo que terminaba mostrándole al
// alumno "formato inválido — reintentá", un mensaje de error genérico
// para lo que en realidad es un resultado perfectamente legítimo. Dos
// correcciones:
//   1. Un `bullets: []` YA NO es un error de parseo (ver
//      `openAIClassSummaryProvider.parseClassSummaryResponse`) — es un
//      resultado válido que ACÁ se traduce a `summaryUnavailableReason:
//      'insufficient_transcript'`, nunca a un error.
//   2. Antes de llamar a OpenAI, se chequea el volumen de transcripción
//      (`OPENAI_CLASS_SUMMARY_MIN_CHARS`, default 500): con MENOS
//      contenido que eso, ni tiene sentido pagar la llamada — el modelo
//      predeciblemente iba a devolver lo mismo. 59 caracteres está muy
//      por debajo de cualquier umbral razonable, así que este chequeo
//      hubiera evitado esa llamada (y su costo) por completo.
const DEFAULT_MIN_TRANSCRIPT_CHARS = 500;

// Resultado NEUTRAL (nunca un error) para "no hay nada real para armar un
// resumen" — ni transcripción suficiente, ni (si tampoco la había)
// tema/concepto del documento para el camino (b). Mismo `keyConcepts` que
// si hubiera salido bien (siguen sirviendo para la heurística de
// `findRelatedConcept` en la sección de repaso, que no depende de esto).
function insufficientTranscriptResult(keyConcepts) {
  return {
    bullets: null,
    keyConcepts,
    summarySource: null,
    summaryUnavailableReason: 'insufficient_transcript',
    generatedAt: new Date().toISOString(),
  };
}

// Arma la promesa que resuelve la parte COMÚN (bullets + keyConcepts, para
// reusar en la sección de repaso sin otra llamada a IA) — SIN cachear acá
// adentro: quien llama (`getCommonSummary`) es quien decide cachear la
// promesa que ESTA función devuelve, antes de que resuelva.
//
// Tres caminos, en este orden (pedido explícito: nunca mostrarle al
// alumno "no hay nada" si hay AL MENOS una fuente real de contenido):
//   a) Transcripción suficiente → resume lo que REALMENTE se dijo en
//      clase (`source: 'transcript'`, comportamiento de siempre).
//   b) Transcripción insuficiente, pero el documento SÍ tiene
//      temas/conceptos → resume el MATERIAL DE APOYO en su lugar
//      (`source: 'document'`) — con un prompt DISTINTO (ver
//      `openAIClassSummaryProvider.js`) que evita sugerir que el docente
//      explicó ese contenido. Sigue siendo UNA llamada a OpenAI, cacheada
//      igual que el camino (a).
//   c) Ninguna de las dos → mensaje neutral, sin llamar a OpenAI.
async function buildCommonSummary(meetingId, meetingCode) {
  // En paralelo — mismo criterio que `questionService.generatePreview`:
  // el resumen cacheado del documento y la transcripción completa son
  // lecturas independientes entre sí.
  const [summary, transcriptSegments] = await Promise.all([
    documentAnalysisService.getAnalysisSummary(meetingId),
    transcriptRepository.getAllSegments(meetingCode),
  ]);

  const mainTopics = summary?.mainTopics ?? [];
  const keyConcepts = summary?.keyConcepts ?? [];
  const totalChars = transcriptSegments.reduce((sum, segment) => sum + (segment.text ? segment.text.length : 0), 0);
  const minChars = Number.parseInt(process.env.OPENAI_CLASS_SUMMARY_MIN_CHARS, 10) || DEFAULT_MIN_TRANSCRIPT_CHARS;

  // Visibilidad real (no solo para depurar este caso puntual): cuánta
  // transcripción tenía la clase que dispara cada resumen, y contra qué
  // mínimo se la compara — así, si el modelo alguna vez vuelve a devolver
  // `[]`, alcanza con este log para saber si fue por un corte razonable
  // (clase realmente corta) o si el mínimo quedó demasiado exigente.
  const transcriptSufficient = totalChars >= minChars;
  console.log(
    `[Sparkle][IA] Resumen de clase — reunión "${meetingCode}": ${transcriptSegments.length} segmento(s), ` +
      `${totalChars} caracter(es) totales de transcripción (mínimo configurado: ${minChars}, ver OPENAI_CLASS_SUMMARY_MIN_CHARS) ` +
      `→ ${transcriptSufficient ? 'suficiente' : 'insuficiente'}.`
  );

  if (transcriptSufficient) {
    const result = await openAIClassSummaryProvider.summarize({
      source: 'transcript',
      mainTopics,
      keyConcepts,
      transcriptSegments,
    });

    // El modelo puede devolver CERO bullets aun con transcripción
    // "suficiente" en caracteres (diagnóstico en vivo, ver el historial de
    // este archivo) — no es un error del proveedor, es la instrucción del
    // propio prompt cumpliéndose. No hay fallback a (b) en este caso
    // puntual (no fue pedido) — mismo estado neutral que si nunca hubiera
    // habido transcripción.
    if (!result.bullets || result.bullets.length === 0) {
      return insufficientTranscriptResult(result.keyConcepts);
    }

    return {
      bullets: result.bullets,
      keyConcepts: result.keyConcepts,
      summarySource: 'transcript',
      summaryUnavailableReason: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Camino (b) — sin transcripción suficiente, ¿hay algo del documento
  // para resumir en su lugar?
  const hasDocumentContext = mainTopics.length > 0 || keyConcepts.length > 0;
  if (!hasDocumentContext) {
    return insufficientTranscriptResult(keyConcepts); // camino (c)
  }

  const result = await openAIClassSummaryProvider.summarize({
    source: 'document',
    mainTopics,
    keyConcepts,
  });

  if (!result.bullets || result.bullets.length === 0) {
    return insufficientTranscriptResult(result.keyConcepts);
  }

  return {
    bullets: result.bullets,
    keyConcepts: result.keyConcepts,
    summarySource: 'document',
    summaryUnavailableReason: null,
    generatedAt: new Date().toISOString(),
  };
}

// Lectura CACHEADA (con deduplicación de llamadas concurrentes) de la
// parte común — ver `classSummaryCache.js` para el porqué de cachear la
// PROMESA, no solo el resultado. Sin ningún `await` en el cuerpo de ESTA
// función en particular: el chequeo del caché y la creación de la promesa
// nueva pasan en el mismo tick de JS, sin ceder el control al event loop
// en el medio — así dos pedidos concurrentes para la misma reunión nunca
// pueden "cruzarse" entre el `get` y el `set` de abajo.
function getCommonSummary(meetingId, meetingCode) {
  const cached = classSummaryCache.get(meetingId);
  if (cached) return cached;

  const pending = buildCommonSummary(meetingId, meetingCode);
  classSummaryCache.set(meetingId, pending);
  // Si la generación falla (OpenAI caído, transcripción vacía, formato
  // inválido), no queda una promesa RECHAZADA cacheada para siempre — se
  // saca del Map para que el próximo pedido (ej. el alumno apretando
  // "Reintentar") dispare un intento fresco, no un error repetido sin
  // reintentar de verdad.
  pending.catch(() => classSummaryCache.invalidate(meetingId));

  return pending;
}

// Heurística de matching SIN IA (a propósito — ver el pedido explícito de
// "cero llamadas por alumno"): superposición de palabras "significativas"
// (4+ letras, sin tildes) entre el enunciado de la pregunta y el término
// de cada concepto clave del documento. Se queda con el concepto de MAYOR
// superposición; si ninguno comparte ni una palabra, no asocia nada (mejor
// no sugerir relación que sugerir una relación falsa).
function normalizeWords(text) {
  const normalized = (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  return normalized.match(/[a-z0-9]{4,}/g) || [];
}

function findRelatedConcept(prompt, keyConcepts) {
  if (!Array.isArray(keyConcepts) || keyConcepts.length === 0) return null;

  const promptWords = new Set(normalizeWords(prompt));
  if (promptWords.size === 0) return null;

  let bestTerm = null;
  let bestScore = 0;
  for (const concept of keyConcepts) {
    const termWords = normalizeWords(concept.term);
    const score = termWords.filter((word) => promptWords.has(word)).length;
    if (score > bestScore) {
      bestScore = score;
      bestTerm = concept.term;
    }
  }
  return bestScore > 0 ? bestTerm : null;
}

// Clasifica una fila de `questionAnswerRepository.getStudentQuestionHistory`
// — mismo criterio que `questionService.toStudentHistoryEntry`
// (`answered_at` en NULL es la única forma de distinguir "nunca hubo fila"
// de "hubo fila con skipped=1", ver ese archivo para el detalle completo).
function classifyRow(row) {
  if (row.answered_at == null) return 'unanswered';
  if (row.skipped) return 'skipped';
  return row.is_correct ? 'correct' : 'incorrect';
}

// Sección "Para repasar" — CERO llamadas a IA, se arma entera a partir de
// `question_answers`/`questions` ya persistidos (reusa la misma consulta
// que ya usa "Preguntas respondidas", `questionAnswerRepository.
// getStudentQuestionHistory`, sin necesitar ninguna consulta nueva).
// `null` si la clase no tuvo ninguna pregunta (nada que mostrar).
//
// Corrección — SIEMPRE incluye las CUATRO preguntas (acertadas incluidas):
// antes las correctas se descartaban del todo y, si el alumno acertó
// todas, la sección quedaba vacía salvo por el mensaje de felicitación —
// ahora ese mensaje es un cartel APARTE (`congratulations`) que el
// frontend muestra ARRIBA del listado, nunca en su reemplazo; `items`
// siempre trae una entrada por cada pregunta finalizada de la clase.
function buildReviewSection(rows, keyConcepts) {
  if (rows.length === 0) return null;

  const items = rows.map((row) => {
    const status = classifyRow(row); // 'correct' | 'incorrect' | 'unanswered' | 'skipped'
    const correctAnswer = row[`option_${row.correct_option}`];
    // "Qué eligió" solo tiene sentido si de verdad eligió una opción
    // (correcta o incorrecta) — `unanswered`/`skipped` nunca tienen
    // `selected_option`, así que `yourAnswer` queda en `null` para esos.
    const yourAnswer =
      status === 'correct' || status === 'incorrect' ? row[`option_${row.selected_option}`] : null;
    // El "concepto relacionado" (heurística sin IA) solo tiene sentido
    // como AYUDA DE REPASO — no hace falta para una que ya salió bien.
    const relatedConcept = status === 'correct' ? null : findRelatedConcept(row.prompt, keyConcepts);

    return {
      id: row.id,
      prompt: row.prompt,
      status,
      yourAnswer,
      correctAnswer,
      relatedConcept,
    };
  });

  const congratulations = items.every((item) => item.status === 'correct');
  return { congratulations, items };
}

// Punto de entrada — "Obtener resumen de la clase" (alumno) y, mismo
// endpoint, lo que vería el docente si lo abriera (sin sección de repaso
// personal, ver más abajo). Autorización: solo alumno o docente de ESTA
// reunión (`roleService.getRole`), y solo con la clase YA TERMINADA
// (`classService.getClassState` — mismo criterio que
// `questionService.createAndStartQuestion`, en el sentido inverso: ahí se
// exige `active`, acá se exige `!active`). Nunca se confía en ningún
// estado del cliente (ej. `endNotice` del lado del frontend, que es
// efímero y no autoritativo) para esto.
async function getClassSummary(meetingCode, email) {
  const { role } = await roleService.getRole(meetingCode, email);
  if (role !== 'teacher' && role !== 'student') {
    throw httpError(403, 'No participaste de esta clase.');
  }

  const state = await classService.getClassState(meetingCode);
  if (!state) throw httpError(404, 'La reunión no existe.');
  if (state.active) {
    throw httpError(409, 'La clase todavía está en curso — el resumen está disponible recién cuando termine.');
  }

  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const meetingId = await meetingRepository.getMeetingIdByCode(normalizedMeetingCode);
  if (!meetingId) throw httpError(404, 'La reunión no existe.');

  // Se lee ACÁ, a CALL-TIME (no una vez al cargar `providers/index.js`) —
  // mismo criterio que `ENABLE_AI_QUESTION_GENERATION`/
  // `ENABLE_AI_DOCUMENT_ANALYSIS`: permite prender/apagar sin reiniciar el
  // proceso.
  //
  // Corrección — con el flag apagado, esto YA NO tira un error: la
  // sección "Para repasar" (más abajo) no depende de la IA en absoluto,
  // así que apagar el resumen automático no tiene por qué dejar al
  // alumno sin nada. `summaryUnavailableReason` es la señal NEUTRAL que
  // el frontend usa para mostrar "no disponible" en vez de un error con
  // un "Reintentar" que, en estos dos casos (flag apagado, o transcripción
  // insuficiente — ver `buildCommonSummary`), nunca podría cambiar nada
  // (repetir el pedido da el mismo resultado siempre) — un botón de
  // reintentar ahí sería confuso, no útil.
  const aiEnabled = process.env.ENABLE_AI_CLASS_SUMMARY === 'true';

  let bullets = null;
  let summarySource = null;
  let generatedAt = null;
  let keyConceptsForReview = [];
  let summaryUnavailableReason = aiEnabled ? null : 'ai_disabled';

  if (aiEnabled) {
    let common;
    try {
      common = await getCommonSummary(meetingId, normalizedMeetingCode);
    } catch (err) {
      // Mismo criterio que `questionService.generatePreview`: `err.message`
      // ya es un texto seguro para mostrar tal cual (el proveedor traduce
      // cualquier error crudo de OpenAI antes de tirarlo) — 502 porque el
      // fallo es de un servicio upstream, no un bug de este backend. Esto
      // SÍ es un fallo transitorio real (OpenAI caído, cuota agotada, JSON
      // realmente malformado) — a diferencia de `summaryUnavailableReason`
      // (arriba), acá un "Reintentar" SÍ puede terminar funcionando.
      throw httpError(502, err.message);
    }
    bullets = common.bullets;
    summarySource = common.summarySource;
    generatedAt = common.generatedAt;
    keyConceptsForReview = common.keyConcepts;
    summaryUnavailableReason = common.summaryUnavailableReason;
  }

  // La sección de repaso es PERSONAL y NUNCA usa IA — solo tiene sentido
  // para un alumno (nunca para el docente, que no "respondió" nada de lo
  // suyo propio), y se arma igual sin importar `aiEnabled`.
  let review = null;
  if (role === 'student') {
    const rows = await questionAnswerRepository.getStudentQuestionHistory(normalizedMeetingCode, email);
    review = buildReviewSection(rows, keyConceptsForReview);
  }

  return {
    aiSummaryAvailable: bullets !== null,
    // 'transcript' | 'document' | null — el frontend lo usa para elegir el
    // título/aclaración de la sección (ver `screens/ClassSummary.jsx`): un
    // resumen armado SOLO con el documento (camino b) nunca debe
    // presentarse como "lo que se explicó en la clase", porque no hay
    // forma de saber si eso pasó de verdad.
    summarySource,
    summaryUnavailableReason,
    bullets,
    generatedAt,
    review,
  };
}

module.exports = { getClassSummary };
