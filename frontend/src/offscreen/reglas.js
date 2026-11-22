// Reglas geométricas de desatención observable — R1 y R2.
//
// QUÉ SON Y POR QUÉ ESTÁN SEPARADAS DEL MODELO
// --------------------------------------------
// El clasificador estadístico se entrenó sobre DAiSEE, un conjunto en el que
// las conductas de desatención manifiesta ESTÁN AUSENTES: 0,9 % de cuadros con
// la cabeza desviada, racha máxima de 0,07 s, cero bostezos. Por eso el modelo
// no reacciona cuando el alumno mira a un costado — no es un umbral mal puesto
// ni un bug: nunca vio ese comportamiento.
//
// Estas reglas cubren ese hueco. Su propiedad distintiva es que NINGÚN umbral
// se ajustó sobre datos:
//
//   - R1 (20°) sale de GEOMETRÍA: la semi-anchura angular de una pantalla de
//     notebook a ~55 cm es ≈ 17°; se exige superarla con margen.
//   - R2 (PERCLOS > 0,15) sale de LITERATURA: Dinges & Grace (1998),
//     FHWA-MCRT-98-006. No es un número propio del proyecto.
//
// Los datasets se usan para VALIDARLAS, no para derivarlas. De ahí que su techo
// de exactitud sea 1,0 y no 0,729 (el que el ruido de anotación de DAiSEE le
// impone al clasificador), y que no exista riesgo de sobreajuste.
//
// ⚠️ UMBRALES CONGELADOS — `Protocolo_Reglas_Geometricas.md` §2 (2026-08-07).
// No se tocan sin enmienda fechada que responda las tres preguntas del §9 del
// protocolo: qué defecto se descubrió, por qué el cambio no es de conveniencia
// y qué riesgo se acepta.
//
// EQUIVALENCIA CON LA IMPLEMENTACIÓN DE REFERENCIA
// -----------------------------------------------
// Este módulo es la traducción de `analisis/reglas_geometricas.py`, con el que
// se midieron la especificidad sobre DAiSEE (0 activaciones de R1 en 975
// ventanas de 79 sujetos) y sobre EngageNet (0 en 842 clips de 11 sujetos).
// Las decisiones tienen que coincidir cuadro a cuadro; los tests de
// `tests/reglas.*.test.js` fijan esa equivalencia con los casos de borde que
// la versión de Python define (fracción sobre cuadros FINITOS, racha contada
// sobre la ventana completa).

// Tasa de muestreo de la rama geométrica: 60 cuadros por clip de 10 s.
export const FPS = 6.0;

// ── R1 — Mirada fuera de pantalla ───────────────────────────────────────────
// Primario 20°. La grilla de sensibilidad {15, 20, 25, 30} está declarada a
// priori en el protocolo y se reporta completa; el primario NO se sustituye
// después de ver resultados.
export const YAW_GRADOS = 20.0;
// 0,50 desde la Enmienda 9 (2026-09-27): "más de la mitad de la ventana
// mirando fuera de la pantalla". El 0,30 original se había tomado prestado de
// `MAX_NO_FACE_FRACTION` sin otro fundamento, y marcaba con ~15 s de desvío en
// 50 s; un alumno desconectado suele estar fuera bastante más que eso. Subirla
// sólo puede apagar activaciones, así que la especificidad medida con 0,30 (0
// en 975 ventanas de DAiSEE) sigue valiendo. Como efecto lateral, R1 suelta
// antes cuando el alumno vuelve a mirar: ~(1 − 0,50) de la ventana en lugar de
// ~(1 − 0,30).
export const FRAC_VENTANA = 0.50;

// ── R2 — Somnolencia ────────────────────────────────────────────────────────
export const PERCLOS_UMBRAL = 0.15;    // Dinges & Grace (1998)
export const EAR_FRAC_CIERRE = 0.30;   // PERCLOS-70: párpado ≥ 70 % cerrado
export const MICROSUENO_SEG = 2.0;     // definición operativa de microsueño
// El microsueño se busca sólo en los últimos 10 s de la ventana (Enmienda 10,
// 2026-09-27). Buscado en los 50 s enteros, un único cierre de 2 s dejaba la
// regla activa ~1 minuto aunque el alumno ya tuviera los ojos abiertos. El
// PERCLOS (Dinges & Grace) sigue sobre la ventana completa. Mirar menos tiempo
// sólo puede apagar activaciones, así que la especificidad medida sigue valiendo.
export const MICROSUENO_VENTANA_SEG = 10.0;

/**
 * Longitud de la racha contigua más larga de `true`, en cuadros.
 * @param {Uint8Array|boolean[]} mask
 * @returns {number}
 */
export function rachaMax(mask) {
  let mejor = 0;
  let actual = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      actual += 1;
      if (actual > mejor) mejor = actual;
    } else {
      actual = 0;
    }
  }
  return mejor;
}

/**
 * Mediana de los valores finitos. `NaN` si no hay ninguno.
 * @param {ArrayLike<number>} values
 * @returns {number}
 */
export function medianaFinita(values) {
  const ok = [];
  for (let i = 0; i < values.length; i += 1) {
    if (Number.isFinite(values[i])) ok.push(values[i]);
  }
  if (ok.length === 0) return NaN;
  ok.sort((a, b) => a - b);
  const mid = ok.length >> 1;
  return ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2;
}

/**
 * R1 — Mirada fuera de pantalla.
 *
 * Marca la ventana cuando la fracción de cuadros con |yaw| > `yawGrados`
 * supera `frac`. La fracción se calcula sobre los cuadros FINITOS (los cuadros
 * sin rostro no cuentan ni a favor ni en contra); la racha, en cambio, se
 * cuenta sobre la ventana completa, de modo que un tramo sin rostro corta la
 * racha en lugar de prolongarla. Es la misma convención que la referencia.
 *
 * @param {Float32Array|number[]} yaw - grados, un valor por cuadro
 * @param {{yawGrados?: number, frac?: number}} [opts]
 * @returns {{dispara: boolean, fracDesviado: number, rachaSeg: number, cuadros: number}}
 */
export function r1MiradaFuera(yaw, { yawGrados = YAW_GRADOS, frac = FRAC_VENTANA } = {}) {
  const desv = new Uint8Array(yaw.length);
  let nOk = 0;
  let nDesv = 0;
  for (let i = 0; i < yaw.length; i += 1) {
    if (!Number.isFinite(yaw[i])) continue;
    nOk += 1;
    if (Math.abs(yaw[i]) > yawGrados) {
      desv[i] = 1;
      nDesv += 1;
    }
  }
  if (nOk === 0) {
    return { dispara: false, fracDesviado: NaN, rachaSeg: NaN, cuadros: 0 };
  }
  const f = nDesv / nOk;
  return {
    dispara: f > frac,
    fracDesviado: f,
    rachaSeg: rachaMax(desv) / FPS,
    cuadros: nOk,
  };
}

/**
 * R2 — Somnolencia por PERCLOS-70 con línea base propia del sujeto.
 *
 * La normalización por sujeto NO es un refinamiento sino un requisito: la razón
 * entre la apertura ocular mediana del sujeto más abierto y la del más cerrado
 * es de 2,07, de modo que el ojo completamente abierto de una persona vale casi
 * lo mismo que el ojo entrecerrado de otra. Un umbral absoluto de EAR no
 * significaría nada.
 *
 * Si no se pasa `baselineEar` se usa la mediana de la propia ventana. Eso NO es
 * el comportamiento del producto —que calibra contra la sesión, ver
 * `detector.js`— y sirve solo para evaluación fuera de línea.
 *
 * El microsueño se busca sólo en los últimos `microVentanaSeg` segundos
 * (Enmienda 10). `Infinity` lo busca en la ventana entera, como la referencia
 * de Python con la que se midió la especificidad.
 *
 * @param {Float32Array|number[]} ear - `ear_avg`, un valor por cuadro
 * @param {number|null} baselineEar
 * @param {{microVentanaSeg?: number}} [opts]
 * @returns {{dispara: boolean, perclos: number, microsuenoSeg: number, cuadros: number}}
 */
export function r2OjosCerrados(ear, baselineEar = null, { microVentanaSeg = MICROSUENO_VENTANA_SEG } = {}) {
  let nOk = 0;
  for (let i = 0; i < ear.length; i += 1) if (Number.isFinite(ear[i])) nOk += 1;
  if (nOk === 0) {
    return { dispara: false, perclos: NaN, microsuenoSeg: NaN, cuadros: 0 };
  }
  const base = baselineEar !== null && baselineEar !== undefined
    ? baselineEar
    : medianaFinita(ear);
  if (!Number.isFinite(base) || base <= 0) {
    return { dispara: false, perclos: NaN, microsuenoSeg: NaN, cuadros: nOk };
  }

  const corte = EAR_FRAC_CIERRE * base;
  const cerr = new Uint8Array(ear.length);
  let nCerr = 0;
  for (let i = 0; i < ear.length; i += 1) {
    if (!Number.isFinite(ear[i])) continue;
    if (ear[i] < corte) {
      cerr[i] = 1;
      nCerr += 1;
    }
  }
  const perclos = nCerr / nOk;
  const cuadrosMicro = Number.isFinite(microVentanaSeg) ? Math.round(microVentanaSeg * FPS) : cerr.length;
  const micro = rachaMax(cerr.subarray(Math.max(0, cerr.length - cuadrosMicro))) / FPS;
  return {
    dispara: perclos > PERCLOS_UMBRAL || micro >= MICROSUENO_SEG,
    perclos,
    microsuenoSeg: micro,
    cuadros: nOk,
  };
}

/**
 * Evalúa ambas reglas sobre una ventana.
 *
 * @param {Float32Array|number[]} yaw
 * @param {Float32Array|number[]} ear
 * @param {number|null} baselineEar
 * @returns {{
 *   dispara: boolean, fuente: 'R1'|'R2'|null,
 *   R1: ReturnType<typeof r1MiradaFuera>, R2: ReturnType<typeof r2OjosCerrados>
 * }}
 */
export function evaluar(yaw, ear, baselineEar = null) {
  const R1 = r1MiradaFuera(yaw);
  const R2 = r2OjosCerrados(ear, baselineEar);
  // R1 tiene precedencia en el ETIQUETADO cuando ambas se activan. Es solo para
  // que la alerta declare UNA fuente; ambas quedan en el detalle y el docente
  // ve las dos.
  let fuente = null;
  if (R1.dispara) fuente = 'R1';
  else if (R2.dispara) fuente = 'R2';
  return { dispara: R1.dispara || R2.dispara, fuente, R1, R2 };
}
