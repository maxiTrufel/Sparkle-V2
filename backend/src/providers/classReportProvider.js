// Contrato del análisis con IA del reporte PDF de fin de clase — se invoca
// solo cuando `ENABLE_AI_CLASS_REPORT === 'true'` (chequeado en
// `services/classReportService.js`), mismo criterio que
// `classSummaryProvider.js`: sin flag activo, el service ni siquiera llama
// a esto, y el reporte se genera igual con la Sección 5 marcada como no
// disponible.
//
// `analyze(context)` recibe:
//   - `questions`: array de preguntas finalizadas, con `{ prompt, options,
//     correctOptionIndex, optionDistribution }` (misma forma que devuelve
//     `questionService.getFinishedQuestionsForMeeting`) — el "distractor más
//     engañoso" de cada una ya se puede derivar de `optionDistribution`, no
//     hace falta que el modelo lo calcule.
//   - `studentAnswers`: array plano `{ questionId, studentName,
//     selectedOption, isCorrect, skipped }` (ver
//     `questionAnswerRepository.getDetailedAnswersForMeeting`) — el detalle
//     por alumno que hace falta para recomendaciones personalizadas.
//
// Devuelve `{ strengths, weaknesses, questionDiagnostics,
// studentRecommendations, suggestedTopics, model, inputTokens,
// outputTokens }` — ver `openAIClassReportProvider.js` para la forma exacta
// de cada campo.
class ClassReportProvider {
  async analyze(_context) {
    throw new Error('ClassReportProvider.analyze() no está implementado.');
  }
}

module.exports = { ClassReportProvider };
