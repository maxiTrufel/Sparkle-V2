// Preprocesamiento de las secuencias antes de la inferencia — port de la
// función `preparar_geometricas`/`preparar_embeddings` del notebook de
// inferencia (`Sparkle_V2_Inferencia_End2End.ipynb`).
//
// Los estadísticos (medianas e escaladores) NO están hardcodeados acá: se
// cargan de `models/preprocesamiento.json`, que produce el notebook de modelo
// final a partir de los mismos vectores que se ajustaron sobre el conjunto de
// entrenamiento. Si esos números no coinciden con los del entrenamiento, el
// modelo recibe entradas fuera de la distribución que vio y devuelve
// predicciones arbitrarias — sin dar ningún error.

import { FEATURE_NAMES, N_FEATURES } from './features.js';

let config = null;

/**
 * Carga y valida `preprocesamiento.json`. La validación no es paranoia: el
 * JSON y este código son dos artefactos que se generan por separado (uno en
 * Colab, el otro acá), así que pueden desincronizarse. Un desfase en el ORDEN
 * de las features es el peor caso posible, porque no rompe nada — solo produce
 * predicciones malas de forma indetectable.
 */
export async function loadPreprocessing(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`No se pudo cargar preprocesamiento.json (HTTP ${response.status})`);
  }
  const cfg = await response.json();

  if (!Array.isArray(cfg.feature_names_22) || cfg.feature_names_22.length !== N_FEATURES) {
    throw new Error(
      `preprocesamiento.json declara ${cfg.feature_names_22?.length} features y este código espera ${N_FEATURES}`,
    );
  }
  for (let i = 0; i < N_FEATURES; i += 1) {
    if (cfg.feature_names_22[i] !== FEATURE_NAMES[i]) {
      throw new Error(
        `Desfase en el orden de features en la posición ${i}: `
        + `el entrenamiento usó "${cfg.feature_names_22[i]}" y este código produce "${FEATURE_NAMES[i]}". `
        + 'Con este desfase el modelo recibiría columnas cruzadas.',
      );
    }
  }

  config = {
    nFrames: cfg.n_frames,
    nEmbFrames: cfg.n_emb_frames,
    embDim: cfg.emb_dim,
    geomMedians: Float32Array.from(cfg.geom_medians),
    embMedians: Float32Array.from(cfg.emb_medians),
    geomMean: Float32Array.from(cfg.geom_scaler_mean),
    geomScale: Float32Array.from(cfg.geom_scaler_scale),
    embMean: Float32Array.from(cfg.emb_scaler_mean),
    embScale: Float32Array.from(cfg.emb_scaler_scale),
    // Índices de las features a las que se les calcula delta de primer orden.
    // Se derivan del JSON, no se hardcodean: así el orden queda atado al del
    // entrenamiento y no a una lista escrita a mano en dos lugares.
    deltaIdx: cfg.delta_features.map((name) => {
      const idx = FEATURE_NAMES.indexOf(name);
      if (idx < 0) throw new Error(`Delta feature desconocida: ${name}`);
      return idx;
    }),
  };
  return config;
}

export function getConfig() {
  if (!config) throw new Error('Preprocesamiento sin cargar: llamar a loadPreprocessing primero');
  return config;
}

/**
 * Interpolación lineal de NaN a lo largo del eje temporal, columna por
 * columna, con relleno hacia adelante y hacia atrás en los extremos. Replica
 * `DataFrame.interpolate(method='linear', limit_direction='both').ffill().bfill()`.
 *
 * Opera in place sobre `seq` (Float32Array de nFrames × nCols en orden por
 * filas) para no duplicar memoria en cada predicción.
 */
export function interpolateNaN(seq, nFrames, nCols, medians) {
  for (let c = 0; c < nCols; c += 1) {
    // Primera pasada: buscar pares de valores válidos e interpolar el hueco
    let lastValid = -1;
    for (let f = 0; f < nFrames; f += 1) {
      const v = seq[f * nCols + c];
      if (!Number.isNaN(v)) {
        if (lastValid >= 0 && f - lastValid > 1) {
          const v0 = seq[lastValid * nCols + c];
          const step = (v - v0) / (f - lastValid);
          for (let k = lastValid + 1; k < f; k += 1) {
            seq[k * nCols + c] = v0 + step * (k - lastValid);
          }
        }
        lastValid = f;
      }
    }

    // Extremos: relleno hacia atrás (bfill) al principio y hacia adelante
    // (ffill) al final, con el primer/último valor válido de la columna
    let first = -1;
    for (let f = 0; f < nFrames; f += 1) {
      if (!Number.isNaN(seq[f * nCols + c])) { first = f; break; }
    }
    if (first < 0) {
      // Columna entera en NaN: no hay nada que interpolar, va la mediana del
      // conjunto de entrenamiento (mismo criterio que el pipeline de Python)
      const m = medians ? medians[c] : 0;
      for (let f = 0; f < nFrames; f += 1) seq[f * nCols + c] = m;
      continue;
    }
    const vFirst = seq[first * nCols + c];
    for (let f = 0; f < first; f += 1) seq[f * nCols + c] = vFirst;

    let last = nFrames - 1;
    for (let f = nFrames - 1; f >= 0; f -= 1) {
      if (!Number.isNaN(seq[f * nCols + c])) { last = f; break; }
    }
    const vLast = seq[last * nCols + c];
    for (let f = last + 1; f < nFrames; f += 1) seq[f * nCols + c] = vLast;
  }
  return seq;
}

/**
 * Pipeline geométrico completo: 22 features crudas × 60 cuadros →
 * interpolación → deltas (10 columnas más) → estandarización → (60, 32).
 *
 * @param {Float32Array} raw - 60 × 22 en orden por filas, con NaN donde no hubo rostro
 * @returns {Float32Array} 60 × 32 estandarizado, listo para el modelo
 */
/**
 * Magnitud de la DINÁMICA facial de la ventana, en unidades del desvío estándar
 * del entrenamiento.
 *
 * PARA QUÉ. Se observó (bitácora 2026-08-26) que con el sujeto sentado y quieto
 * P(desatención) sube de forma monótona —0,630 a 0,808 en 66 s—. La hipótesis a
 * verificar es que el modelo esté leyendo la QUIETUD como aburrimiento: el
 * vector incluye diez derivadas de primer orden, y un rostro cada vez más quieto
 * las lleva hacia cero. De ser cierto, el modelo penalizaría exactamente la
 * conducta de un estudiante concentrado.
 *
 * Esta función no participa de la inferencia: sólo instrumenta. Se computa sobre
 * la MISMA secuencia interpolada que consume el modelo, y cada delta se divide
 * por la escala de su columna (`geomScale`) para que las diez sean comparables
 * entre sí — mezclan grados, EAR adimensional y coeficientes de expresión.
 *
 * NO se resta la media: para una derivada el promedio de entrenamiento es ~0 y
 * lo que interesa es la MAGNITUD del movimiento, no su desvío respecto de un
 * centro.
 *
 * @returns {{dinamica: number, porColumna: number[]}} `dinamica` es el promedio
 *   sobre las diez columnas; `porColumna` permite ver cuál domina.
 */
export function resumenDinamica(raw) {
  const cfg = getConfig();
  const T = cfg.nFrames;
  const F22 = N_FEATURES;
  const nDelta = cfg.deltaIdx.length;

  const seq = Float32Array.from(raw);
  interpolateNaN(seq, T, F22, cfg.geomMedians);

  const porColumna = new Array(nDelta).fill(0);
  for (let d = 0; d < nDelta; d += 1) {
    const c = cfg.deltaIdx[d];
    const escala = cfg.geomScale[F22 + d] || 1;
    let suma = 0;
    // Desde el cuadro 1: el 0 no tiene anterior y vale 0 por construcción,
    // igual que en el entrenamiento.
    for (let f = 1; f < T; f += 1) {
      suma += Math.abs(seq[f * F22 + c] - seq[(f - 1) * F22 + c]) / escala;
    }
    porColumna[d] = T > 1 ? suma / (T - 1) : 0;
  }
  const dinamica = porColumna.reduce((a, b) => a + b, 0) / (nDelta || 1);
  return { dinamica, porColumna };
}

export function prepareGeometric(raw) {
  const cfg = getConfig();
  const T = cfg.nFrames;
  const F22 = N_FEATURES;
  const nDelta = cfg.deltaIdx.length;
  const F32 = F22 + nDelta;

  // Copia, porque interpolateNaN trabaja in place y el buffer circular sigue
  // siendo dueño de `raw`
  const seq = Float32Array.from(raw);
  interpolateNaN(seq, T, F22, cfg.geomMedians);

  const out = new Float32Array(T * F32);
  for (let f = 0; f < T; f += 1) {
    // 22 features base
    for (let c = 0; c < F22; c += 1) {
      out[f * F32 + c] = seq[f * F22 + c];
    }
    // 10 deltas de primer orden: el primer cuadro queda en 0 (np.diff con
    // prepend de ceros, igual que en el entrenamiento)
    for (let d = 0; d < nDelta; d += 1) {
      const c = cfg.deltaIdx[d];
      out[f * F32 + F22 + d] = f === 0 ? 0 : seq[f * F22 + c] - seq[(f - 1) * F22 + c];
    }
  }

  // Estandarización por columna con los estadísticos del entrenamiento
  for (let f = 0; f < T; f += 1) {
    for (let c = 0; c < F32; c += 1) {
      const i = f * F32 + c;
      out[i] = (out[i] - cfg.geomMean[c]) / cfg.geomScale[c];
    }
  }
  return out;
}

/**
 * Pipeline de apariencia: 16 × 128 embeddings crudos (con NaN donde no se
 * detectó rostro) → interpolación → estandarización opcional.
 *
 * ⚠️ `standardize` NO es una preferencia: los dos modelos usan pipelines
 * distintos y elegir mal produce un error SILENCIOSO (probabilidades
 * plausibles, modelo equivocado).
 *
 *   - `true`  → modelo A de 321 parámetros (`modelo_A_resumen_lineal.tflite`),
 *               que se entrenó sobre los embeddings estandarizados con
 *               `emb_scaler`.
 *   - `false` → modelo ENSEMBLE (`modelo_ensemble.json`), que estandariza el
 *               vector de RESUMEN con un escalador propio por cabeza y por lo
 *               tanto necesita los embeddings crudos.
 *
 * La interpolación se aplica en ambos casos: es lineal sobre el eje temporal y
 * conmuta con la proyección lineal del extractor, así que interpolar acá sobre
 * las 128 dimensiones equivale a haberlo hecho sobre las 1.280 originales —
 * que es lo que hizo el pipeline de entrenamiento.
 */
export function prepareEmbeddings(raw, { standardize = true } = {}) {
  const cfg = getConfig();
  const T = cfg.nEmbFrames;
  const D = cfg.embDim;

  const seq = Float32Array.from(raw);
  interpolateNaN(seq, T, D, cfg.embMedians);
  if (!standardize) return seq;

  for (let f = 0; f < T; f += 1) {
    for (let c = 0; c < D; c += 1) {
      const i = f * D + c;
      seq[i] = (seq[i] - cfg.embMean[c]) / cfg.embScale[c];
    }
  }
  return seq;
}

/**
 * Fracción de cuadros sin rostro en una secuencia cruda. Se usa para descartar
 * predicciones sobre ventanas con demasiados huecos: en el entrenamiento se
 * descartaban los clips con más del 30 % de cuadros sin rostro, y una
 * predicción sobre una ventana peor que eso no es comparable con nada de lo
 * que el modelo vio.
 */
export function noFaceFraction(raw, nFrames, nCols) {
  let noFaceCount = 0;
  for (let f = 0; f < nFrames; f += 1) {
    let anyNaN = false;
    for (let c = 0; c < nCols; c += 1) {
      if (Number.isNaN(raw[f * nCols + c])) { anyNaN = true; break; }
    }
    if (anyNaN) noFaceCount += 1;
  }
  return noFaceCount / nFrames;
}
