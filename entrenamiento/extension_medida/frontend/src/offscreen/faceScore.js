// Puntaje de atención a partir de la orientación de la cabeza, la mirada y la
// apertura de los ojos, sobre la misma detección de MediaPipe que ya corre
// `detector.js` (no abre la cámara ni carga ningún modelo propio).
//
// Por cuadro: la cabeza y la mirada se suman en una sola dirección en grados
// (si gira la cabeza pero compensa con los ojos, sigue mirando la pantalla) y
// se marca "en rango" si esa dirección cae dentro de los límites y los ojos no
// están cerrados de forma sostenida. El puntaje es el porcentaje de cuadros en
// rango de los últimos 10 s.
//
// Sin calibración inicial: el alumno puede no estar frente a la cámara al
// arrancar, y un "centro" tomado en ese momento quedaría mal toda la clase.

export const GAZE_DEGREES = 40;      // desviación completa de la mirada, en grados
export const SIDE_LIMIT = 25;
export const DOWN_LIMIT = -20;
export const UP_LIMIT = 25;
export const EYE_CLOSED_THRESHOLD = 0.5; // eyeBlink por encima de esto = ojo cerrado
export const CLOSURE_MS = 500;       // un cierre más largo que esto ya no es un parpadeo
export const WINDOW_MS = 10000;
export const MIN_FRAMES = 30;        // ~5 s a 6 fps antes de dar un puntaje
export const FACE_WEIGHT = 0.9;

const LANDMARK = { nose: 1, cheekA: 234, cheekB: 454, forehead: 10, chin: 152 };

const blendshape = (cats, name) => cats.find((c) => c.categoryName === name)?.score ?? 0;
const toDeg = (rad) => (rad * 180) / Math.PI;

// Magnitud desde la matriz (column-major, igual que `features.js`); el signo
// desde la geometría de los puntos, que no depende de convenciones internas.
function headAngles(m, lm) {
  const r00 = m[0], r10 = m[1], r20 = m[2], r21 = m[6], r22 = m[10];
  const yaw = Math.abs(toDeg(Math.atan2(-r20, Math.hypot(r00, r10))));
  const pitch = Math.abs(toDeg(Math.atan2(r21, r22)));

  const centerX = (lm[LANDMARK.cheekA].x + lm[LANDMARK.cheekB].x) / 2;
  const [top, bottom] = lm[LANDMARK.forehead].y < lm[LANDMARK.chin].y
    ? [lm[LANDMARK.forehead], lm[LANDMARK.chin]] : [lm[LANDMARK.chin], lm[LANDMARK.forehead]];

  return {
    yaw: lm[LANDMARK.nose].x < centerX ? yaw : -yaw, // + = girado a su derecha
    pitch: top.z < bottom.z ? -pitch : pitch,        // - = mirando abajo
  };
}

export function createFaceScore() {
  let frames = [];           // { t, ok }
  let closedSince = null;

  function reset() {
    frames = [];
    closedSince = null;
  }

  /** Registra un cuadro. `result` es el FaceLandmarkerResult de MediaPipe. */
  function record(result, now) {
    const lm = result?.faceLandmarks?.[0];
    if (!lm || lm.length === 0) {
      closedSince = null;
      frames.push({ t: now, ok: false });
      return;
    }
    const m = result?.facialTransformationMatrixes?.[0]?.data;
    const bs = result?.faceBlendshapes?.[0]?.categories;
    if (!m || !bs) return;

    const angles = headAngles(m, lm);

    const closed = (blendshape(bs, 'eyeBlinkLeft') + blendshape(bs, 'eyeBlinkRight')) / 2
      > EYE_CLOSED_THRESHOLD;
    if (closed) closedSince ??= now;
    else closedSince = null;
    const eyesClosed = closed && now - closedSince >= CLOSURE_MS;

    let dirX = angles.yaw;
    let dirY = angles.pitch;
    // La mirada solo con los ojos abiertos: al bajar los párpados MediaPipe
    // dispara eyeLookDown y ensuciaría la dirección.
    if (!closed) {
      dirX += ((blendshape(bs, 'eyeLookInLeft') + blendshape(bs, 'eyeLookOutRight'))
        - (blendshape(bs, 'eyeLookOutLeft') + blendshape(bs, 'eyeLookInRight'))) / 2 * GAZE_DEGREES;
      dirY += ((blendshape(bs, 'eyeLookUpLeft') + blendshape(bs, 'eyeLookUpRight'))
        - (blendshape(bs, 'eyeLookDownLeft') + blendshape(bs, 'eyeLookDownRight'))) / 2 * GAZE_DEGREES;
    }

    const onScreen = Math.abs(dirX) <= SIDE_LIMIT && dirY >= DOWN_LIMIT && dirY <= UP_LIMIT;
    frames.push({ t: now, ok: onScreen && !eyesClosed });
  }

  /** Porcentaje (0-100) de cuadros en rango de la ventana, o `null` si todavía no alcanza. */
  function value(now) {
    frames = frames.filter((f) => f.t > now - WINDOW_MS);
    if (frames.length < MIN_FRAMES) return null;
    return (100 * frames.filter((f) => f.ok).length) / frames.length;
  }

  return { record, value, reset };
}

/** Promedio ponderado de los dos porcentajes; si falta uno, queda el otro. */
export function combineScores(face, model) {
  if (face == null) return model ?? null;
  if (model == null) return face;
  return FACE_WEIGHT * face + (1 - FACE_WEIGHT) * model;
}
