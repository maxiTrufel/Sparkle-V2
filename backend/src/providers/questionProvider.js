// Contrato que debe cumplir cualquier proveedor de preguntas — hoy conviven
// `RandomQuestionProvider` (banco local, sin IA) y `OpenAIQuestionProvider`
// (ver `providers/index.js` para cuál está ACTIVA, detrás de
// `ENABLE_AI_QUESTION_GENERATION`), pero el resto de la app
// (`services/questionService.js`) solo conoce ESTE contrato, nunca una
// implementación concreta.
//
// `generateQuestion(context)` devuelve una `GeneratedQuestion`:
//   { prompt: string, options: string[4], correctOptionIndex: 0|1|2|3 }
// Sin persistir nada — la persistencia real ocurre recién si el docente
// decide enviarla (ver `questionService.createAndStartQuestion`).
//
// `context` es OPCIONAL y específico de cada proveedor — `RandomQuestionProvider`
// lo ignora por completo (elige de un banco fijo, sin importar la
// reunión); `OpenAIQuestionProvider` sí lo necesita: `{ mainTopics,
// keyConcepts, transcriptSegments, previousPrompts }` (ver ese archivo
// para el detalle de cada campo). `questionService.generatePreview` es
// quien arma este objeto — ni este contrato ni `RandomQuestionProvider`
// necesitan saber de dónde sale cada campo.
class QuestionProvider {
  async generateQuestion(_context) {
    throw new Error('QuestionProvider.generateQuestion() no está implementado.');
  }
}

module.exports = { QuestionProvider };
