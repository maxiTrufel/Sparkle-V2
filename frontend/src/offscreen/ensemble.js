// Cabeza de decisión del modelo: 8 regresiones logísticas promediadas.
//
// POR QUÉ NO ES UN .tflite
// ------------------------
// Son 776 parámetros (8 cabezas × 96 pesos + sesgo). En JSON quedan auditables
// en texto plano y se elimina el riesgo del orden de entradas/salidas de
// TFLite, que en este proyecto ya produjo dos errores silenciosos: la cabeza
// binaria quedó en el índice 1 y no en el 0 declarado, y en el modelo de fusión
// se invirtió el orden de las entradas. El extractor CNN sigue en TFLite, que
// es donde está el costo real de cómputo — esto es una multiplicación de 8×96
// y una sigmoide.
//
// EL EXTRACTOR NO CAMBIA
// ----------------------
// Las 8 proyecciones son los bloques disjuntos de 16 columnas de la matriz de
// 128 que el extractor ya aplica (su salida es `raw1280 @ W + b`). El bloque j
// es literalmente un slice de columnas 16j..16j+15 de esa salida.
//
// ⚠️ LA RAMA DE APARIENCIA VA CRUDA
// ---------------------------------
// El ensemble NO estandariza los embeddings con `emb_scaler` antes de
// resumirlos: estandariza el vector de resumen ya concatenado, con un escalador
// propio por cabeza. Pasarle la salida de `prepareEmbeddings()` daría un modelo
// distinto y el error sería silencioso — números plausibles, modelo equivocado.
// Por eso `predictEnsemble()` recibe la salida CRUDA del extractor.

let model = null;

/**
 * Carga y valida `modelo_ensemble.json`.
 * @param {string} url
 */
export async function loadEnsemble(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo cargar el ensemble: ${res.status} ${url}`);
  const cfg = await res.json();

  if (cfg.formato !== 'sparkle-ensemble-v1') {
    throw new Error(`Formato de ensemble desconocido: "${cfg.formato}"`);
  }
  if (!Array.isArray(cfg.cabezas) || cfg.cabezas.length !== cfg.n_cabezas) {
    throw new Error(`El JSON declara ${cfg.n_cabezas} cabezas y trae ${cfg.cabezas?.length}`);
  }
  // La rama de apariencia tiene que ir cruda; si el export dijera lo contrario,
  // es que se generó con otro pipeline y este código no lo reproduce.
  if (cfg.usa_emb_scaler) {
    throw new Error('El ensemble declara usa_emb_scaler=true; este código espera la salida cruda');
  }

  const nEntradas = cfg.n_geom * 2 + cfg.d_bloque * 2;
  cfg.cabezas.forEach((h, j) => {
    const largos = [h.coef.length, h.scaler_mean.length, h.scaler_scale.length];
    if (largos.some((n) => n !== nEntradas)) {
      throw new Error(
        `cabeza ${j}: coef/scaler de largos ${largos} y se esperaban ${nEntradas}`,
      );
    }
    if (h.scaler_scale.some((s) => !Number.isFinite(s) || s === 0)) {
      throw new Error(`cabeza ${j}: scaler_scale con ceros o no finitos (división por cero)`);
    }
    const [a, b] = h.bloque;
    if (b - a !== cfg.d_bloque || b > cfg.emb_dim) {
      throw new Error(`cabeza ${j}: bloque [${a},${b}] inválido para emb_dim ${cfg.emb_dim}`);
    }
  });

  model = {
    ...cfg,
    cabezas: cfg.cabezas.map((h) => ({
      bloque: h.bloque,
      scalerMean: Float64Array.from(h.scaler_mean),
      scalerScale: Float64Array.from(h.scaler_scale),
      coef: Float64Array.from(h.coef),
      intercept: h.intercept,
    })),
  };
  return model;
}

export function isEnsembleLoaded() {
  return model !== null;
}

export function getEnsembleConfig() {
  if (!model) throw new Error('Ensemble no cargado — llamar a loadEnsemble() primero');
  return model;
}

/**
 * Media y desvío estándar POBLACIONAL (divisor N, igual que numpy `.std()`)
 * sobre el eje temporal de una matriz aplanada por filas.
 *
 * El divisor importa: numpy usa N por defecto y el modelo se ajustó con esos
 * valores. Usar N−1 (la convención de muchas librerías de estadística) daría un
 * resumen levemente distinto y un modelo desalineado con el entrenado.
 *
 * @param {Float32Array|Float64Array|number[]} seq - T×C en row-major
 * @param {number} T - pasos temporales
 * @param {number} C - columnas
 * @param {number} colFrom - primera columna a incluir
 * @param {number} colTo - primera columna EXCLUIDA
 * @returns {Float64Array} de largo 2*(colTo-colFrom): medias y después desvíos
 */
export function summarize(seq, T, C, colFrom = 0, colTo = C) {
  const n = colTo - colFrom;
  const out = new Float64Array(n * 2);
  for (let c = colFrom; c < colTo; c += 1) {
    let sum = 0;
    for (let t = 0; t < T; t += 1) {
      const v = seq[t * C + c];
      sum += Number.isFinite(v) ? v : 0;
    }
    const mean = sum / T;
    let acc = 0;
    for (let t = 0; t < T; t += 1) {
      const v = seq[t * C + c];
      const d = (Number.isFinite(v) ? v : 0) - mean;
      acc += d * d;
    }
    out[c - colFrom] = mean;
    out[n + (c - colFrom)] = Math.sqrt(acc / T);
  }
  return out;
}

/**
 * Probabilidad de desatención para una ventana de 10 s.
 *
 * @param {Float32Array} geomStandardized - 60×32 YA estandarizada (salida de
 *   `prepareGeometric()`).
 * @param {Float32Array} embRaw - 16×128 CRUDA, tal cual sale del extractor.
 *   NO pasar por `prepareEmbeddings()`: ver la nota del encabezado.
 * @returns {{p: number, perHead: number[]}}
 */
export function predictEnsemble(geomStandardized, embRaw) {
  if (!model) throw new Error('Ensemble no cargado — llamar a loadEnsemble() primero');
  const { n_frames: T, n_geom: G, n_emb_frames: TE, emb_dim: D } = model;

  const geomSummary = summarize(geomStandardized, T, G);        // 2*G
  const perHead = model.cabezas.map((h) => {
    const [a, b] = h.bloque;
    const embSummary = summarize(embRaw, TE, D, a, b);           // 2*(b-a)
    let logit = h.intercept;
    for (let i = 0; i < geomSummary.length; i += 1) {
      logit += ((geomSummary[i] - h.scalerMean[i]) / h.scalerScale[i]) * h.coef[i];
    }
    const off = geomSummary.length;
    for (let i = 0; i < embSummary.length; i += 1) {
      const k = off + i;
      logit += ((embSummary[i] - h.scalerMean[k]) / h.scalerScale[k]) * h.coef[k];
    }
    return 1 / (1 + Math.exp(-logit));
  });

  return { p: perHead.reduce((s, v) => s + v, 0) / perHead.length, perHead };
}
