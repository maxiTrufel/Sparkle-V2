// Veredicto de tres estados — cómo se combinan el puntaje de cara, las reglas
// y el modelo. Reemplaza al promedio `0,9 × cara + 0,1 × modelo`
// (`combineScores` de `faceScore.js`, que queda exportado pero ya no decide).
//
// La cara decide atento o desatento. El modelo NO es la nota final: sólo
// separa, dentro de "atento", al alumno que además muestra signos de
// aburrimiento. Del lado desatento su opinión se registra y no cambia nada:
// ahí el alumno no mira la pantalla, y el modelo se entrenó sobre DAiSEE,
// donde la cabeza casi nunca se desvía — está fuera de su dominio.
//
//   Cara       Modelo                     Estado                 modelOpinion
//   atenta     no aburrido                atento                 no_aburrido
//   atenta     aburrido                   atento_aburrimiento    aburrido
//   atenta     sin opinión                atento                 sin_opinion
//   desatenta  aburrido                   desatento              confirma
//   desatenta  no aburrido                desatento              no_confirma
//   desatenta  sin opinión                desatento              sin_opinion
//   sin valor  —                          sin_veredicto          —
//
// ANTES DE LA TABLA: si R1 o R2 disparan, el estado es `desatento` aunque la
// cara diga atenta. Son las reglas con mejor respaldo del proyecto (0
// activaciones en 1.817 ventanas de alumnos atentos) y cubren lo que la
// ventana de 10 s de la cara suaviza: distracción o sueño repetidos a lo largo
// de casi un minuto.
//
// "SIN OPINIÓN" del modelo: se abstiene (confianza por debajo del margen) o su
// ventana de 50 s todavía no está completa. Con la ventana a medias el modelo
// promedia menos lecturas y no se abstiene nunca, y ese no es el punto que se
// validó (5 lecturas no solapadas + abstención), así que ahí no opina.
//
// Especificación: `Fase 4/Especificacion_Veredicto_Tres_Estados.md` del repo
// de visión (cerrada el 2026-09-17, decisiones del 2026-09-27).

export const STATE = Object.freeze({
  ATENTO: 'atento',
  ATENTO_ABURRIMIENTO: 'atento_aburrimiento',
  DESATENTO: 'desatento',
  SIN_VEREDICTO: 'sin_veredicto',
});

export const MODEL_OPINION = Object.freeze({
  NO_ABURRIDO: 'no_aburrido',
  ABURRIDO: 'aburrido',
  CONFIRMA: 'confirma',
  NO_CONFIRMA: 'no_confirma',
  SIN_OPINION: 'sin_opinion',
});

/**
 * Qué dice el modelo sobre la ventana, o `null` si no tiene opinión válida.
 * Mismo criterio de umbral que el resto del detector: "aburrido" ⇔ la
 * concentración del modelo (`1 − pWindow`) no supera Y.
 *
 * @returns {'aburrido'|'no_aburrido'|null}
 */
export function modelView({ pWindow, windowFilled, abstains, threshold }) {
  if (!windowFilled || abstains || !Number.isFinite(pWindow)) return null;
  return 1 - pWindow <= threshold ? 'aburrido' : 'no_aburrido';
}

/**
 * @param {object} args
 * @param {number|null} args.face - puntaje de cara 0-100, `null` sin cuadros suficientes
 * @param {boolean} args.ruleFired - R1 o R2 activas sobre la ventana de 50 s
 * @param {number} args.pWindow - probabilidad de desatención promediada del modelo
 * @param {boolean} args.windowFilled - la ventana del modelo tiene sus 5 lecturas
 * @param {boolean} args.abstains - el modelo se abstiene por baja confianza
 * @param {number} args.threshold - Y, umbral de atención (0-1)
 * @returns {{state: string, modelOpinion: string|null, decidedBy: 'rule'|'face'|null}}
 */
export function decideState({
  face, ruleFired, pWindow, windowFilled, abstains, threshold,
}) {
  const view = modelView({ pWindow, windowFilled, abstains, threshold });

  if (ruleFired) {
    return { state: STATE.DESATENTO, modelOpinion: registerInattentive(view), decidedBy: 'rule' };
  }
  if (face == null) {
    return { state: STATE.SIN_VEREDICTO, modelOpinion: null, decidedBy: null };
  }
  // `<=` como en todo el detector: igualar Y no alcanza para estar atento.
  if (face / 100 <= threshold) {
    return { state: STATE.DESATENTO, modelOpinion: registerInattentive(view), decidedBy: 'face' };
  }
  if (view === 'aburrido') {
    return { state: STATE.ATENTO_ABURRIMIENTO, modelOpinion: MODEL_OPINION.ABURRIDO, decidedBy: 'face' };
  }
  return {
    state: STATE.ATENTO,
    modelOpinion: view === 'no_aburrido' ? MODEL_OPINION.NO_ABURRIDO : MODEL_OPINION.SIN_OPINION,
    decidedBy: 'face',
  };
}

function registerInattentive(view) {
  if (view === 'aburrido') return MODEL_OPINION.CONFIRMA;
  if (view === 'no_aburrido') return MODEL_OPINION.NO_CONFIRMA;
  return MODEL_OPINION.SIN_OPINION;
}
