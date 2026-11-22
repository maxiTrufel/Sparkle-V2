// Extracción de las 22 features geométricas por cuadro — port EXACTO del
// código de extracción del dataset (`Sparkle_V2_Fase2_3_v2_MAR_Blendshapes.ipynb`,
// función `extract_features_from_frame`).
//
// Por qué "exacto" es la palabra importante acá: el modelo se entrenó sobre
// features calculadas de una forma concreta. Cualquier divergencia entre cómo
// se calcularon al entrenar y cómo se calculan al inferir degrada el modelo
// EN SILENCIO — no hay error, no hay excepción, simplemente las predicciones
// empeoran sin que nada lo indique. Por eso este archivo replica el orden de
// las features, los índices de landmarks y la derivación de ángulos uno a uno,
// y por eso `FEATURE_NAMES` se valida contra el JSON de preprocesamiento que
// exporta el notebook (ver `preprocessing.js`).

// Índices de landmarks de MediaPipe FaceMesh. Son los mismos en Python y en
// JavaScript: el modelo `face_landmarker.task` es el mismo binario.
const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const LEFT_EYE = [362, 385, 387, 263, 373, 380];
const MOUTH_CORNERS = [61, 291];
const MOUTH_VERTICAL = [13, 14];

// Subconjunto curado de los 52 blendshapes que produce MediaPipe. El ORDEN
// importa: define las columnas 7 a 22 del vector de features.
export const BLENDSHAPES_OF_INTEREST = [
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeLookDownLeft',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeLookDownRight',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'jawOpen',
];

export const FEATURE_NAMES = [
  'ear_avg',
  'ear_left',
  'ear_right',
  'yaw',
  'pitch',
  'mar',
  ...BLENDSHAPES_OF_INTEREST,
];

export const N_FEATURES = FEATURE_NAMES.length; // 22

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

// Eye Aspect Ratio: (vertical1 + vertical2) / (2 * horizontal), sobre los 6
// landmarks del ojo en coordenadas de PÍXEL (por eso se multiplica por el
// ancho y el alto del cuadro: las coordenadas de MediaPipe vienen
// normalizadas a [0,1] y el aspecto del cuadro no es cuadrado).
function eyeAspectRatio(landmarks, ids, w, h) {
  const p = ids.map((i) => [landmarks[i].x * w, landmarks[i].y * h]);
  const horiz = distance(p[0][0], p[0][1], p[3][0], p[3][1]);
  if (horiz === 0) return NaN;
  const vert1 = distance(p[1][0], p[1][1], p[5][0], p[5][1]);
  const vert2 = distance(p[2][0], p[2][1], p[4][0], p[4][1]);
  return (vert1 + vert2) / (2 * horiz);
}

// Mouth Aspect Ratio: apertura vertical sobre ancho entre comisuras.
function mouthAspectRatio(landmarks, w, h) {
  const [l, r] = MOUTH_CORNERS;
  const [t, b] = MOUTH_VERTICAL;
  const horiz = distance(
    landmarks[l].x * w, landmarks[l].y * h,
    landmarks[r].x * w, landmarks[r].y * h,
  );
  if (horiz === 0) return NaN;
  const vert = distance(
    landmarks[t].x * w, landmarks[t].y * h,
    landmarks[b].x * w, landmarks[b].y * h,
  );
  return vert / horiz;
}

// Ángulos de Euler (yaw, pitch) en GRADOS a partir de la matriz de
// transformación facial 4×4 que devuelve MediaPipe.
//
// ATENCIÓN al layout de la matriz. El modelo se entrenó con los valores que
// produjo el pipeline de Python, así que lo que este código tiene que
// reproducir es la CONVENCIÓN DE PYTHON, no la corrección geométrica.
//
// VERIFICADO EMPÍRICAMENTE (2026-08-01), lado Python:
//   `facial_transformation_matrixes[0]` llega como ndarray (4,4) con la
//   TRASLACIÓN EN LA ÚLTIMA COLUMNA y última fila [0,0,0,1]:
//       [[  0.9985  -0.0263  -0.0483   -0.3826]
//        [  0.0356   0.9782   0.2048   -6.0262]
//        [  0.0419  -0.2062   0.9776  -34.3898]
//        [  0.       0.       0.        1.    ]]
//   Es decir: es la matriz estándar y `matrix[i][j]` es (fila i, columna j).
//   El notebook de extracción toma `matrix[:3,:3]` y lee rot[2,0], rot[2,1],
//   rot[2,2] con esa indexación.
//
// Lado JavaScript: `data` viene en orden COLUMN-MAJOR (convención de
// MediaPipe/OpenGL), de modo que el elemento (fila i, columna j) es
// `data[j*4 + i]`. Con ese acceso, este código lee EXACTAMENTE los mismos
// elementos que Python. `verificarLayoutMatriz()` lo comprueba en tiempo de
// ejecución en el primer cuadro.
//
// Equivocar esto no rompe nada visiblemente: devuelve ángulos plausibles pero
// incorrectos, y el modelo pierde exactitud sin dar ninguna señal. Si el
// assert de abajo dispara, el arreglo es invertir el acceso a
// `matrixData[row*4 + col]`.

let layoutMatrizVerificado = false;

/**
 * Comprueba una única vez que `data` viene column-major, comparando dónde caen
 * los valores de traslación (magnitud del orden de decenas) contra los de
 * rotación (≤ 1).
 *
 * Column-major → la traslación ocupa data[12], data[13], data[14].
 * Row-major    → ocuparía data[3], data[7], data[11].
 */
function verificarLayoutMatriz(matrixData) {
  if (layoutMatrizVerificado) return;
  layoutMatrizVerificado = true;

  const mag = (...idx) => Math.max(...idx.map((i) => Math.abs(matrixData[i])));
  const columnMajor = mag(12, 13, 14);   // traslación si es column-major
  const rowMajor = mag(3, 7, 11);        // traslación si es row-major

  if (columnMajor >= rowMajor) {
    console.log(
      `[Sparkle][IA] Layout de la matriz facial verificado: COLUMN-MAJOR ` +
      `(traslación ${columnMajor.toFixed(2)} en data[12..14] vs ${rowMajor.toFixed(2)} ` +
      `en data[3,7,11]). yaw/pitch coinciden con la convención de Python.`,
    );
  } else {
    console.error(
      `[Sparkle][IA] ⚠️ La matriz facial NO viene column-major como se asumió ` +
      `(traslación ${rowMajor.toFixed(2)} en data[3,7,11] vs ${columnMajor.toFixed(2)} ` +
      `en data[12..14]). yaw y pitch están MAL: son 2 de las 22 features y el modelo ` +
      `pierde exactitud sin dar otra señal. Arreglo: en eulerFromMatrix() usar ` +
      `matrixData[row * 4 + col]. Ver VERIFICAR_yaw_pitch.md.`,
    );
  }
}

function eulerFromMatrix(matrixData) {
  verificarLayoutMatriz(matrixData);
  const at = (row, col) => matrixData[col * 4 + row];

  const r00 = at(0, 0);
  const r10 = at(1, 0);
  const r20 = at(2, 0);
  const r21 = at(2, 1);
  const r22 = at(2, 2);
  const r11 = at(1, 1);
  const r12 = at(1, 2);

  const sy = Math.hypot(r00, r10);
  const singular = sy < 1e-6;

  const toDeg = (rad) => (rad * 180) / Math.PI;
  const pitch = singular ? toDeg(Math.atan2(-r12, r11)) : toDeg(Math.atan2(r21, r22));
  const yaw = toDeg(Math.atan2(-r20, sy));
  return { yaw, pitch };
}

/**
 * Convierte un resultado de FaceLandmarker en el vector de 22 features.
 * Devuelve un Float32Array con NaN en todas las posiciones si no se detectó
 * rostro — mismo criterio que la extracción del dataset, donde esos cuadros se
 * interpolan después (ver `preprocessing.js`).
 *
 * @param {object} result - FaceLandmarkerResult de @mediapipe/tasks-vision
 * @param {number} w - ancho del cuadro en píxeles
 * @param {number} h - alto del cuadro en píxeles
 */
export function featuresFromResult(result, w, h) {
  const out = new Float32Array(N_FEATURES).fill(NaN);

  const landmarks = result?.faceLandmarks?.[0];
  if (!landmarks || landmarks.length === 0) return out;

  const earR = eyeAspectRatio(landmarks, RIGHT_EYE, w, h);
  const earL = eyeAspectRatio(landmarks, LEFT_EYE, w, h);

  out[0] = (earR + earL) / 2;
  out[1] = earL;
  out[2] = earR;

  const matrix = result?.facialTransformationMatrixes?.[0];
  if (matrix?.data) {
    const { yaw, pitch } = eulerFromMatrix(matrix.data);
    out[3] = yaw;
    out[4] = pitch;
  }

  out[5] = mouthAspectRatio(landmarks, w, h);

  // Los blendshapes llegan como una lista de categorías; se indexan por nombre
  // porque el orden que devuelve MediaPipe no tiene por qué coincidir con el
  // de `BLENDSHAPES_OF_INTEREST` (y de hecho no coincide: MediaPipe los emite
  // en su propio orden alfabético interno).
  const categories = result?.faceBlendshapes?.[0]?.categories;
  if (categories) {
    const porNombre = new Map(categories.map((c) => [c.categoryName, c.score]));
    for (let i = 0; i < BLENDSHAPES_OF_INTEREST.length; i += 1) {
      const score = porNombre.get(BLENDSHAPES_OF_INTEREST[i]);
      out[6 + i] = score === undefined ? NaN : score;
    }
  }

  return out;
}

/**
 * Recorte cuadrado del rostro para la rama de apariencia — port de
 * `crop_face_from_landmarks` (Fase 3.2a): bounding box a partir del mínimo y
 * máximo de TODOS los landmarks, margen relativo del 25 %, recorte cuadrado
 * (para no distorsionar el rostro) y redimensionado a `size`×`size`.
 *
 * Dibuja sobre un canvas que se recibe por parámetro en vez de crear uno nuevo
 * por llamada: esto se ejecuta ~1,6 veces por segundo de forma indefinida, y
 * crear un canvas por cuadro genera basura que el GC tiene que limpiar.
 *
 * @returns {ImageData|null} recorte RGBA de size×size, o null si no hay rostro
 */
/**
 * Ancho aparente del rostro en PÍXELES, medido sobre los extremos de la malla.
 *
 * POR QUÉ SE MIDE. La tasa de detección de MediaPipe correlaciona con el tamaño
 * aparente del rostro (rho = +0,745 sobre 24 sujetos de BIWI): por debajo de
 * ~70 px cae a menos de la mitad. La `Enmienda_2` §4bis.6 pide medirlo
 * DIRECTAMENTE en el pipeline del producto, porque el valor de referencia
 * (≥ 80 px) se derivó de forma indirecta de la óptica de otra cámara.
 *
 * ⚠️ SE REPORTA, NO SE DECIDE SOBRE ÉL. El umbral en píxeles NO está congelado
 * y esta función no lo aplica: sirve para instrumentar el pipeline y poder
 * calibrarlo con datos propios. Convertirlo en una condición de abstención
 * requiere la enmienda que fije el umbral.
 *
 * @returns {number} ancho en píxeles, o `NaN` si no hay rostro
 */
export function faceWidthFromResult(result, width, height) {
  const landmarks = result?.faceLandmarks?.[0];
  if (!landmarks || landmarks.length === 0 || !width || !height) return NaN;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const p of landmarks) {
    const px = p.x * width;
    if (px < xMin) xMin = px;
    if (px > xMax) xMax = px;
  }
  return Number.isFinite(xMin) && Number.isFinite(xMax) ? xMax - xMin : NaN;
}

export function cropFaceFromResult(source, result, canvas, size = 112, margin = 0.25) {
  const landmarks = result?.faceLandmarks?.[0];
  if (!landmarks || landmarks.length === 0) return null;

  const w = source.width || source.videoWidth;
  const h = source.height || source.videoHeight;
  if (!w || !h) return null;

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const p of landmarks) {
    const px = p.x * w;
    const py = p.y * h;
    if (px < xMin) xMin = px;
    if (px > xMax) xMax = px;
    if (py < yMin) yMin = py;
    if (py > yMax) yMax = py;
  }

  const side = Math.max(xMax - xMin, yMax - yMin) * (1 + margin);
  const cx = (xMin + xMax) / 2;
  const cy = (yMin + yMax) / 2;
  const x0 = Math.max(0, Math.round(cx - side / 2));
  const y0 = Math.max(0, Math.round(cy - side / 2));
  const x1 = Math.min(w, Math.round(cx + side / 2));
  const y1 = Math.min(h, Math.round(cy + side / 2));
  if (x1 <= x0 || y1 <= y0) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, x0, y0, x1 - x0, y1 - y0, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Convierte el recorte RGBA del canvas al tensor que espera MobileNetV2.
 * `preprocess_input` de MobileNetV2 mapea [0,255] a [-1,1]: `x/127.5 - 1`.
 * Descarta el canal alfa.
 */
export function cropToTensor(imageData, size = 112) {
  const out = new Float32Array(size * size * 3);
  const { data } = imageData;
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    out[j] = data[i] / 127.5 - 1;
    out[j + 1] = data[i + 1] / 127.5 - 1;
    out[j + 2] = data[i + 2] / 127.5 - 1;
  }
  return out;
}

/**
 * Ayuda de diagnóstico para validar el port contra Python. Imprime el vector
 * de features con sus nombres, para poder compararlo con el que produce
 * `extract_features_from_frame` sobre el mismo cuadro.
 *
 * Vale la pena hacer esta verificación UNA vez sobre un cuadro conocido: es la
 * única forma de descartar un error de layout de la matriz de rotación (ver el
 * comentario de `eulerFromMatrix`), que es silencioso por naturaleza.
 */
export function debugCompareWithPython(features) {
  const rows = FEATURE_NAMES.map((name, i) => ({
    feature: name,
    value: Number.isNaN(features[i]) ? 'NaN' : features[i].toFixed(6),
  }));
  console.table(rows);
  return rows;
}
