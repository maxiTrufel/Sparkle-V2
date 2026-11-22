// Agregación temporal de predicciones — la ventana sobre la que se decide.
//
// POR QUÉ ESTE MÓDULO EXISTE APARTE
// ---------------------------------
// Es fácil de implementar mal de una forma que parece correcta. El detector
// emite una predicción cada `predictionIntervalMs` (2 s por defecto), pero cada
// predicción se calcula sobre un buffer de features de 10 s. Promediar las
// últimas 5 predicciones consecutivas NO equivale a promediar 5 clips de 10 s:
//
//   predicciones a t, t+2, t+4, t+6, t+8  →  buffers [t-10, t] … [t-2, t+8]
//   = 18 s de video, y cada par consecutivo comparte el 80 % de los cuadros.
//
// El modelo se validó promediando **5 clips de 10 s NO SOLAPADOS** (50 s de
// video distinto). Promediar predicciones correlacionadas reduce mucho menos la
// varianza, así que el 76,1 % reportado no aplicaría.
//
// Por eso la ventana se arma tomando predicciones **separadas al menos
// `clipSpanMs`** entre sí, hacia atrás desde la más reciente: se sigue
// actualizando cada 2 s, pero las 5 muestras promediadas provienen de tramos de
// video disjuntos, igual que en la validación.

/**
 * Elige hasta `size` predicciones separadas al menos `clipSpanMs`, empezando
 * por la más reciente y caminando hacia atrás.
 *
 * @param {{p: number, ts: number}[]} buffer - ordenado por `ts` ascendente
 * @param {number} size
 * @param {number} clipSpanMs - separación mínima entre muestras
 * @returns {{p: number, ts: number}[]} de la más reciente a la más antigua
 */
export function selectSpacedSamples(buffer, size, clipSpanMs) {
  const out = [];
  let limit = Infinity;
  for (let i = buffer.length - 1; i >= 0 && out.length < size; i -= 1) {
    const item = buffer[i];
    if (item.ts <= limit) {
      out.push(item);
      limit = item.ts - clipSpanMs;
    }
  }
  return out;
}

/**
 * Descarta del buffer lo que ya no puede entrar en ninguna ventana futura.
 * Muta el array (es el buffer vivo del detector).
 *
 * @param {{p: number, ts: number}[]} buffer
 * @param {number} now
 * @param {number} size
 * @param {number} clipSpanMs
 */
export function pruneBuffer(buffer, now, size, clipSpanMs) {
  // Margen de una muestra: si el intervalo de predicción no divide exacto al
  // span, la muestra más antigua útil puede quedar apenas fuera del corte.
  const oldest = now - (size + 1) * clipSpanMs;
  while (buffer.length > 0 && buffer[0].ts < oldest) buffer.shift();
}

/**
 * Probabilidad agregada de la ventana.
 *
 * @returns {{p: number, samples: number, filled: boolean, spanMs: number}}
 *   `p` es el promedio; `filled` indica si se juntaron las `size` muestras
 *   (antes de eso la estimación es más ruidosa y no es la validada);
 *   `spanMs` es el tramo temporal que efectivamente cubre la ventana.
 */
export function aggregateWindow(buffer, size, clipSpanMs) {
  const sel = selectSpacedSamples(buffer, size, clipSpanMs);
  if (sel.length === 0) return { p: NaN, samples: 0, filled: false, spanMs: 0 };
  const p = sel.reduce((s, it) => s + it.p, 0) / sel.length;
  const spanMs = sel.length > 1 ? sel[0].ts - sel[sel.length - 1].ts + clipSpanMs : clipSpanMs;
  return { p, samples: sel.length, filled: sel.length >= size, spanMs };
}
