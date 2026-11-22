// Orquestación de la detección continua: buffers circulares de features y
// embeddings, y la decisión de cuándo predecir.
//
// El modelo se entrenó sobre clips INDEPENDIENTES de 10 segundos, muestreados
// a 60 cuadros para la rama geométrica y a 16 para la de apariencia. Acá el
// video es continuo, así que se mantiene una ventana deslizante de esos mismos
// tamaños: cada predicción usa los últimos 10 segundos. Es lo más cercano a la
// distribución de entrenamiento que se puede hacer con video en vivo.
//
// Frecuencias de muestreo, derivadas de esos números:
//   - geometría: 60 cuadros / 10 s = 6 fps  → un cuadro cada ~167 ms
//   - apariencia: 16 cuadros / 10 s = 1,6 fps → un cuadro cada ~625 ms
//
// La rama de apariencia se muestrea 3,75 veces menos seguido, así que la CNN
// (que es lo caro) corre bastante menos que el detector de landmarks.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import {
  featuresFromResult, cropFaceFromResult, cropToTensor, faceWidthFromResult, N_FEATURES,
} from './features.js';
import { evaluar as evaluarReglas, medianaFinita } from './reglas.js';
import {
  loadPreprocessing, getConfig, prepareGeometric, prepareEmbeddings,
  noFaceFraction, resumenDinamica,
} from './preprocessing.js';
import {
  startRuntime, loadModel, run, smokeTestModel,
} from './inference.js';
import { loadEnsemble, predictEnsemble, isEnsembleLoaded } from './ensemble.js';
import { aggregateWindow, pruneBuffer } from './aggregation.js';
import { createFaceScore } from './faceScore.js';
import { decideState, STATE } from './veredicto.js';

const MODELS_PATH = 'models';
const CROP_SIZE = 112;

// Umbral de decisión — Y, en el panel de ajuste rápido. Semántica: umbral
// MÍNIMO DE ATENCIÓN, no de desatención — "concentración > umbral" es lo que
// define "atento" (ver `predict()`, más abajo). Con el default (0,6): si la
// concentración (fracción 0-1, el complemento de `pInattention`) es mayor a
// 0,6, el alumno está atento; si es 0,6 o menos, desatento. Subir Y hace más
// estricta la barra para considerar "atento" (más falsos "desatento" a costa
// de menos falsos "atento"); bajarlo, al revés. NO es un hiperparámetro del
// modelo sino una decisión de producto — la curva completa de compromiso
// está en `metricas_modelos.json` (clave `umbral_modelo_A`, ahí expresada
// del lado de desatención — ver `predict()` para la conversión exacta
// entre ambos sentidos).
//
// Este Y es del ALUMNO — vive acá, en el documento offscreen de SU propia
// pestaña, configurable vía el panel de ajuste rápido de `App.jsx`
// (`AttentionSettingsPanel.jsx`). Es el ÚNICO Y que existe en el proyecto:
// el docente supo tener una copia propia para reclasificar `concentration`
// del lado de su panel (`attentionThreshold`, en `hooks/useLiveAttention.js`),
// pero esa variable se sacó por completo (pedido explícito) — el docente ya
// no recalcula nada, confía directo en el booleano `inattentive` que este
// umbral produce acá y viaja tal cual hasta él.
//
// `let`, no `const` — configurable en caliente vía `configure()` (panel de
// ajuste rápido del docente/QA, ver `offscreen/main.js`), sin reiniciar el
// documento offscreen ni recargar los modelos.
// VALOR: 0,5 desde el 2026-08-01 (antes 0,6). NO es una preferencia de
// producto sino el punto de operación en el que el modelo fue VALIDADO
// (`Fase3_Registro_de_Resultados.md` §16). Medido sobre ventanas de 50 s con
// predicciones out-of-fold de 79 participantes:
//
//   Y      balanced acc   detecta   marca mal a atentos
//   0,45      0,6906        49 %          11 %
//   0,50      0,7003        64 %          24 %   ← el validado
//   0,60      0,6106        92 %          70 %   ← el valor anterior
//
// Con 0,6 el sistema marcaba desatención cuando `p >= 0,40`, es decir INCLUSO
// CUANDO EL PROPIO MODELO CREÍA MÁS PROBABLE LA ATENCIÓN, y por eso marcaba
// mal al 70 % de los alumnos que sí atendían.
let threshold = 0.5;
const DEFAULT_THRESHOLD = 0.5;

// ── Ventana de decisión ──────────────────────────────────────────────────────
// El modelo se validó sobre ventanas de 5 clips de 10 s NO SOLAPADOS (50 s de
// video distinto), PROMEDIANDO PROBABILIDADES y recién después comparando
// contra la frontera. Dos detalles que no son intercambiables:
//
//   1. Promedio de probabilidades, no voto por mayoría de decisiones duras:
//      sobre validación cruzada rindió 0,6370 contra 0,6282 (§9.5).
//   2. Muestras SEPARADAS `CLIP_SPAN_MS`. Promediar las últimas 5 predicciones
//      consecutivas cubriría 18 s con 80 % de cuadros compartidos entre pares,
//      no 50 s de video distinto — ver el encabezado de `aggregation.js`.
const WINDOW_SIZE = 5;

// Duración del buffer de features de cada predicción. Es el mismo valor del que
// salen las frecuencias de muestreo (60 cuadros / 10 s y 16 / 10 s), y define
// la separación mínima entre muestras para que no se solapen.
const CLIP_SPAN_MS = 10000;

// ── Abstención ───────────────────────────────────────────────────────────────
// El sistema NO emite juicio cuando su confianza es baja. La confianza es la
// distancia de la probabilidad promediada a la frontera de decisión, que está
// en `1 - threshold` y por lo tanto SIGUE AL MODO ACTIVO — no está fija en 0,5.
//
// El margen tiene que corresponder a una cobertura de 0,60 (el sistema opina en
// el 60 % de las ventanas), que es el punto reportado: 76,1 % de exactitud
// sobre la partición de prueba oficial. SIN abstención el sistema opera a
// cobertura total, donde la exactitud medida es 68,7 %.
//
// Mostrar un porcentaje que el modelo no sostiene es peor que no mostrar nada:
// el destinatario no puede distinguir una predicción firme de una que está a
// un punto de la frontera.
//
// ⚠️ ESTE VALOR NO SE ELIGE A OJO. Es el percentil 40 de |p_ventana − (1−Y)|
// sobre las predicciones de validación:
//
//     np.percentile(np.abs(p_w - (1 - Y)), 40)   →  0,0839
//
// medido el 2026-08-01 en `Sparkle_V2_Fase3_7_Modos_de_Clase.ipynb` sobre 974
// ventanas de 79 participantes.
//
// ⚠️ EL MARGEN Y EL MODELO VAN JUNTOS. Está calibrado sobre las predicciones
// del modelo ENSEMBLE (8 cabezas, `modelo_final_ensemble.npz`), cuya
// distribución de probabilidades no es la del modelo A de 321 parámetros que
// está desplegado hoy. Activarlo con el modelo viejo daría una cobertura
// distinta de 0,60 y el 76,1 % reportado dejaría de describir al sistema.
const CONFIDENCE_MARGIN_ENSEMBLE = 0.0839;

// El margen se activa SOLO si el ensemble está cargado. Con el modelo A de
// reserva vale `null` ⇒ el sistema no se abstiene y opera a cobertura total,
// que es el fallo seguro: exactitud medida de 68,7 % en lugar de 76,1 %, pero
// ningún juicio silenciado sin respaldo. El acoplamiento es explícito porque
// margen y modelo NO son separables.
function confidenceMargin() {
  return isEnsembleLoaded() ? CONFIDENCE_MARGIN_ENSEMBLE : null;
}

// Fracción máxima de cuadros sin rostro tolerada en una ventana. Por encima de
// esto no se emite predicción: en el entrenamiento se descartaban los clips con
// más del 30 % de cuadros sin rostro, así que una ventana peor que eso está
// fuera de la distribución que el modelo vio.
const MAX_NO_FACE_FRACTION = 0.30;

// ── Capa de reglas geométricas ──────────────────────────────────────────────
// Ver `reglas.js` para qué son y por qué sus umbrales no se ajustan sobre datos.
//
// PRIORIDAD (`Protocolo_Reglas_Geometricas.md` §2.4): si R1 o R2 se activan, la
// ventana es desatención aunque el puntaje de cara diga atento (ver
// `veredicto.js`). El modelo SE CONSULTA IGUAL: su opinión se registra
// (confirma o no la desatención) y su ventana de 50 s sigue llenándose, así
// que al terminar el episodio de regla no hay que esperar a re-llenarla.
//
// Índices dentro del vector de 22 features (ver `FEATURE_NAMES` en features.js).
const IDX_EAR_AVG = 0;
const IDX_YAW = 3;

// Buffers circulares propios de las reglas. NO se reusa `geomBuf` porque ese
// cubre 10 s (la ventana del modelo) y R1 decide sobre 50 s: la fracción de
// cuadros desviados sobre 10 s no es la magnitud que el protocolo congeló.
let ruleYawBuf = null;    // WINDOW_SIZE * nFrames = 300 cuadros = 50 s a 6 fps
let ruleEarBuf = null;
let ruleWriteIdx = 0;
let ruleFrameCount = 0;

// Línea base de EAR del propio sujeto, para R2. La normalización por sujeto no
// es un refinamiento sino un requisito: la razón entre la apertura mediana del
// sujeto más abierto y la del más cerrado es 2,07, de modo que un umbral
// absoluto de EAR no significaría nada.
//
// CALIBRACIÓN: 30 s (`Enmienda_5`, 2026-08-23). El plan original suponía ~3 min
// sin haberlo medido, lo que dejaba a R2 inoperante durante los primeros tres
// minutos de CADA sesión — justo cuando el alumno se acomoda. Medido sobre 74
// sujetos y 1.208 ventanas, la decisión de R2 cambia en UNA sola ventana al
// bajar a 30 s, y el control negativo sobre DAiSEE da idéntico (6 de 975 con
// ambas calibraciones, 0 ventanas cambian de veredicto).
let baselineSamples = [];
let baselineEar = null;
let baselineFrames = 0;   // se fija en init(): 30 s a 6 fps

// Último ancho de rostro medido, en píxeles. INSTRUMENTACIÓN, no decisión:
// el umbral de observabilidad mínima NO está congelado (`Enmienda_2` §4bis.6) y
// acá no se abstiene por él. Se expone para poder calibrarlo con datos propios.
let lastFaceWidthPx = NaN;

// Última detección de la rama geométrica, con su instante. INSTRUMENTACIÓN, no
// decisión: la lee el banco de prueba para registrar por cuadro los ángulos y
// coeficientes que usa el puntaje de cara. Nada del producto la consulta.
let lastGeomDetection = null;   // { result, t }

// Puntaje por orientación de cabeza, mirada y ojos (ver `faceScore.js`). Decide
// atento o desatento en `predict()` (ver `veredicto.js`) y lee la misma
// detección de cada cuadro.
const faceScore = createFaceScore();

let landmarker = null;
let ready = false;
let running = false;

// Buffers circulares. Se reservan una sola vez y se sobrescriben in place: a 6
// fps de forma indefinida, reasignar arrays en cada cuadro genera basura
// constante para el recolector.
let geomBuf = null;   // 60 × 22
let embBuf = null;    // 16 × 128
let geomWriteIdx = 0;
let embWriteIdx = 0;
let geomFrameCount = 0;  // cuántas posiciones del buffer tienen datos reales
let embFrameCount = 0;

let lastGeomSampleAt = 0;
let lastEmbSampleAt = 0;
let lastPredictionAt = 0;

// Historial de `{p, ts}` de las últimas predicciones, más reciente al final.
// Guarda más de WINDOW_SIZE porque la ventana toma muestras SEPARADAS
// CLIP_SPAN_MS entre sí, no las últimas consecutivas (ver `aggregation.js`).
// Se vacía en `reset()` junto con los buffers de features, para no mezclar dos
// momentos separados por un corte de cámara.
const recentPredictions = [];

let cropCanvas = null;
let cfg = null;

function log(message) {
  console.log(`[Sparkle][IA][detector] ${message}`);
}

// Cada cuánto se emite una predicción. Más corto = señal más reactiva y más
// CPU; más largo = más barato. 2 s da una señal continua sin recalcular sobre
// una ventana casi idéntica a la anterior.
//
// OJO: esto NO es la frecuencia a la que se capturan cuadros de la cámara —
// esa (6 fps geometría / 1,6 fps apariencia, ver el comentario del principio
// del archivo) está atada al tamaño de ventana con el que se entrenó el
// modelo y NO se puede cambiar sin reentrenarlo. Lo que sí es una perilla de
// producto es cada cuánto se emite una predicción NUEVA a partir de la
// ventana ya llena — eso es lo que ajusta `configure()`.
let predictionIntervalMs = 2000;
const DEFAULT_PREDICTION_INTERVAL_MS = 2000;
const MIN_PREDICTION_INTERVAL_MS = 250; // tope defensivo: por debajo de esto no aporta señal nueva real

/**
 * Ajusta umbral y/o cadencia de predicción en caliente — sin recargar
 * MediaPipe ni los modelos `.tflite` (eso solo pasa una vez, en
 * `initialize()`). Pensado para el panel de ajuste rápido DEL ALUMNO
 * (`ui/AttentionSettingsPanel.jsx` — corrección: esto decía "docente/QA",
 * desactualizado desde que el Y del docente se sacó por completo del
 * proyecto; el único Y que queda es este). Cada valor se valida por
 * separado y uno inválido no pisa el otro ni el que ya estaba configurado
 * — un `threshold` fuera de `(0, 1)` (ej. exactamente 0 o 1, ambos alcanzables
 * arrastrando el slider a un extremo) se IGNORA en silencio, sin lanzar ni
 * loguear un error: quien llama tiene que leer el valor de `return` (nunca
 * asumir que quedó aplicado el que mandó) para saber qué es lo que
 * realmente quedó vigente — ver `App.jsx#handleAttentionConfigChange`, que
 * reconcilia su estado con esto exactamente por esta razón.
 *
 * @param {{threshold?: number, predictionIntervalMs?: number}} config
 * @returns {{threshold: number, predictionIntervalMs: number}} configuración REALMENTE vigente
 */
export function configure({ threshold: newThreshold, predictionIntervalMs: newInterval } = {}) {
  if (typeof newThreshold === 'number' && newThreshold > 0 && newThreshold < 1) {
    threshold = newThreshold;
  }
  if (typeof newInterval === 'number' && newInterval >= MIN_PREDICTION_INTERVAL_MS) {
    predictionIntervalMs = newInterval;
  }
  log(`Configuración actualizada — threshold=${threshold}, predictionIntervalMs=${predictionIntervalMs}`);
  return getConfiguration();
}

export function getConfiguration() {
  return {
    threshold,
    predictionIntervalMs,
    defaultThreshold: DEFAULT_THRESHOLD,
    defaultPredictionIntervalMs: DEFAULT_PREDICTION_INTERVAL_MS,
  };
}

// MediaPipe y LiteRT.js vuelcan logs internos de inicialización por dos vías
// distintas de Emscripten, y las dos terminan en la consola:
//   - MediaPipe (mediapipe-wasm) llama al shim de debug de Emscripten
//     directo, que mapea a console.warn (p. ej. "Sets FaceBlendshapesGraph
//     acceleration to xnnpack by default").
//   - LiteRT.js (litert-wasm) escribe por stdout/stderr del módulo WASM vía
//     fd_write → put_char → out()/err(), que Emscripten mapea a console.log
//     (líneas "INFO:") y console.warn (líneas "WARNING:") respectivamente
//     — de ahí mensajes como "accelerator_registry.cc" o "npu_registry.cc".
// Ninguno es un error de la extensión, pero ensucian la consola en cada
// inicialización. Se filtran por contenido, no silenciando console.warn ni
// console.log enteros, para no tragarse un log real que caiga en la misma
// ventana de tiempo.
const MEDIAPIPE_NOISE = [
  'FaceBlendshapesGraph',
  'xnnpack',
  'gl_context',
  'OpenGL error checking',
  'NPU accelerator',
  'RegisterAccelerator',
  'LiteRT',
  'TensorFlow Lite',
  'XNNPACK',
  'compiled_model',
  'accelerator_registry',
  'gpu_registry',
  'cpu_registry',
  'environment.cc',
  'gpu_environment',
  'litert-wasm',
  'LiteRtEnvironment',
  'npu_registry',
  'kLiteRtStatus',
];

function silenceNoise(original) {
  return (...args) => {
    const msg = args.join(' ');
    if (MEDIAPIPE_NOISE.some((token) => msg.includes(token))) return;
    original.apply(console, args);
  };
}

// El patch de consola de arriba (console.warn/console.log dinámicos) sólo
// atrapa al shim de debug de MediaPipe (custom_dbg, que hace
// console.warn.apply en cada llamada). NO alcanza al resto: tanto
// mediapipe-wasm como litert-wasm escriben stdout/stderr por el shim
// estándar de Emscripten (fd_write → put_char → out()/err()), y AMBOS builds
// atan esas dos funciones a console.log / console.error UNA SOLA VEZ, al
// instanciar el módulo WASM (`var out = console.log.bind(console); var err =
// console.error.bind(console);` — idéntico en vision_wasm_internal.js y en
// litert_wasm_internal.js). Parchear console.log/console.error desde afuera
// después no sirve porque el `.bind` ya capturó la referencia original — por
// eso mensajes como "Created TensorFlow Lite XNNPACK delegate for CPU."
// (MediaPipe) o "accelerator_registry.cc" (LiteRT) seguían apareciendo
// igual, incluso en chrome://extensions → Errors, que lee console.error.
//
// El único hook soportado en los dos es Module['print']/Module['printErr'],
// leído una sola vez por el bloque ATMODULES del factory al construir el
// módulo. Y la única forma de inyectarlo es pre-setear `globalThis.Module`
// justo antes de que el módulo se instancie:
//   - MediaPipe lo hace dentro de FaceLandmarker.createFromOptions() (no en
//     FilesetResolver.forVisionTasks(), que sólo resuelve rutas — rastreado
//     en el bundle: createFromOptions → cc → aa → self.ModuleFactory(...)).
//   - LiteRT.js lo hace dentro de startRuntime() (loadLiteRt()); loadModel()
//     reutiliza esa misma instancia, así que no necesita su propio filtro.
// Las dos librerías consumen y limpian `globalThis.Module` solas apenas
// terminan (`self.ModuleFactory = self.Module = void 0`); el finally de
// withSilencedNoiseAsync es sólo por si la llamada explota antes de llegar a
// consumirlo.
function installEmscriptenLoggingFilter() {
  const isNoise = (msg) => MEDIAPIPE_NOISE.some((token) => msg.includes(token));
  globalThis.Module = {
    print: (msg) => { if (!isNoise(msg)) console.log(msg); },
    // No baja a console.warn: este es el mismo canal por el que saldría un
    // problema real, y perderlo de chrome://extensions → Errors sería peor
    // que el ruido que se está filtrando.
    printErr: (msg) => { if (!isNoise(msg)) console.error(msg); },
  };
}

async function withSilencedNoiseAsync(fn) {
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = silenceNoise(originalWarn);
  console.log = silenceNoise(originalLog);
  installEmscriptenLoggingFilter();
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    delete globalThis.Module;
  }
}

export async function initialize({ onStatus } = {}) {
  if (ready) return;

  const notify = (message) => {
    console.log(`[Sparkle][IA] ${message}`);
    onStatus?.(message);
  };

  notify('Cargando preprocesamiento…');
  cfg = await loadPreprocessing(chrome.runtime.getURL(`${MODELS_PATH}/preprocesamiento.json`));

  notify('Iniciando MediaPipe…');
  const fileset = await withSilencedNoiseAsync(
    () => FilesetResolver.forVisionTasks(chrome.runtime.getURL('mediapipe-wasm')),
  );

  const landmarkerOptions = (delegate) => ({
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL(`${MODELS_PATH}/face_landmarker.task`),
      delegate,
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    // Las dos salidas que necesitan las features: sin ellas faltarían los 16
    // blendshapes y los ángulos de cabeza, o sea 18 de las 22 columnas.
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });

  // GPU primero porque el detector de landmarks es lo más caro del pipeline,
  // pero con caída a CPU: un documento offscreen no siempre consigue contexto
  // WebGL (Chrome puede negárselo según el estado de la GPU), y sin este
  // fallback la detección quedaría muerta en esas máquinas en vez de andar
  // más lenta.
  try {
    landmarker = await withSilencedNoiseAsync(
      () => FaceLandmarker.createFromOptions(fileset, landmarkerOptions('GPU')),
    );
  } catch (err) {
    log(`MediaPipe sin GPU (${err.message}); usando CPU`);
    notify('Iniciando MediaPipe (CPU)…');
    landmarker = await withSilencedNoiseAsync(
      () => FaceLandmarker.createFromOptions(fileset, landmarkerOptions('CPU')),
    );
  }

  // Cabeza de decisión: el ensemble validado si está presente, con caída al
  // modelo A. Es un JSON de 776 parámetros, no un .tflite — ver `ensemble.js`.
  try {
    const ens = await loadEnsemble(chrome.runtime.getURL(`${MODELS_PATH}/modelo_ensemble.json`));
    notify(`Ensemble cargado (${ens.n_cabezas} cabezas)`);
  } catch (err) {
    log(`Sin ensemble (${err.message}); se usa el modelo A de reserva. `
      + 'La abstención queda DESACTIVADA: el margen de confianza está calibrado '
      + 'para el ensemble y con otro modelo no daría la cobertura de 0,60.');
  }

  notify('Cargando modelos…');
  // startRuntime() (loadLiteRt) y loadModel() (loadAndCompile) son los puntos
  // reales donde LiteRT.js inicializa litert-wasm y sus registries de
  // acelerador — no FilesetResolver.forVisionTasks(), que es exclusivo de
  // MediaPipe. El módulo WASM se instancia una única vez, dentro de
  // startRuntime(); loadModel() reutiliza esa misma instancia para compilar
  // cada .tflite, así que el filtro instalado ahí ya cubre ambas llamadas.
  await withSilencedNoiseAsync(() => startRuntime());
  await withSilencedNoiseAsync(async () => {
    await loadModel('extractor', `${MODELS_PATH}/cnn_extractor.tflite`);
    await loadModel('decision', `${MODELS_PATH}/modelo_A_resumen_lineal.tflite`);
  });

  // Prueba de humo con entradas sintéticas: si alguna operación no está
  // soportada por el backend, se entera acá y no en medio de una clase.
  await smokeTestModel('extractor');
  await smokeTestModel('decision');

  geomBuf = new Float32Array(cfg.nFrames * N_FEATURES).fill(NaN);
  embBuf = new Float32Array(cfg.nEmbFrames * cfg.embDim).fill(NaN);

  // Ventana de las reglas: los mismos 50 s sobre los que se midió la
  // especificidad (0 activaciones de R1 en 975 ventanas de 79 sujetos).
  const ruleFrames = cfg.nFrames * WINDOW_SIZE;
  ruleYawBuf = new Float32Array(ruleFrames).fill(NaN);
  ruleEarBuf = new Float32Array(ruleFrames).fill(NaN);
  baselineFrames = cfg.nFrames * 3;   // 3 clips de 10 s = 30 s (`Enmienda_5`)

  cropCanvas = new OffscreenCanvas(CROP_SIZE, CROP_SIZE);

  ready = true;
  notify('Detector listo');
}

export function isReady() {
  return ready;
}

/**
 * Procesa un cuadro. Se llama tan seguido como llegue video; internamente
 * decide si toca muestrear cada rama según los intervalos de arriba, así que
 * es barato llamarla de más.
 *
 * @param {ImageBitmap|HTMLVideoElement} source
 * @param {number} now - timestamp en ms (performance.now del emisor)
 * @returns {object|null} predicción, o null si todavía no corresponde emitir una
 */
export async function processFrame(source, now) {
  if (!ready || running) return null;

  const geomInterval = 10000 / cfg.nFrames;      // ~167 ms
  const embInterval = 10000 / cfg.nEmbFrames;    // ~625 ms

  const dueGeom = now - lastGeomSampleAt >= geomInterval;
  const dueEmb = now - lastEmbSampleAt >= embInterval;
  if (!dueGeom && !dueEmb) return null;

  running = true;
  try {
    const width = source.width || source.videoWidth;
    const height = source.height || source.videoHeight;

    // Una sola detección de MediaPipe por cuadro, reutilizada por las dos
    // ramas. En la extracción del dataset el detector corría dos veces sobre
    // cada video (una para geometría en Fase 2, otra para los recortes en Fase
    // 3.2a); acá eso sería tirar la mitad del presupuesto de CPU.
    const result = landmarker.detectForVideo(source, now);

    if (dueGeom) {
      const features = featuresFromResult(result, width, height);
      geomBuf.set(features, geomWriteIdx * N_FEATURES);
      geomWriteIdx = (geomWriteIdx + 1) % cfg.nFrames;
      geomFrameCount = Math.min(geomFrameCount + 1, cfg.nFrames);
      lastGeomSampleAt = now;

      // Mismo cuadro, mismas features: las reglas leen de la misma detección de
      // MediaPipe, no vuelven a correr nada.
      const yaw = features[IDX_YAW];
      const ear = features[IDX_EAR_AVG];
      ruleYawBuf[ruleWriteIdx] = yaw;
      ruleEarBuf[ruleWriteIdx] = ear;
      ruleWriteIdx = (ruleWriteIdx + 1) % ruleYawBuf.length;
      ruleFrameCount = Math.min(ruleFrameCount + 1, ruleYawBuf.length);

      // Línea base de R2: se acumula hasta completar la calibración y se fija
      // una sola vez. No se recalcula después — una línea base móvil daría
      // cobertura inmediata y precisión creciente, pero su efecto sobre la
      // estabilidad de la decisión NO está medido (`Enmienda_5` §3.3) y
      // adoptarla sin medirla repetiría el defecto que esa enmienda corrige.
      if (baselineEar === null && Number.isFinite(ear)) {
        baselineSamples.push(ear);
        if (baselineSamples.length >= baselineFrames) {
          const m = medianaFinita(baselineSamples);
          if (Number.isFinite(m) && m > 0) {
            baselineEar = m;
            log(`Línea base de EAR calibrada: ${m.toFixed(4)} (${baselineSamples.length} cuadros, ~${Math.round(baselineSamples.length / 6)} s)`);
          }
          baselineSamples = [];
        }
      }

      lastFaceWidthPx = faceWidthFromResult(result, width, height);
      faceScore.record(result, now);
      lastGeomDetection = { result, t: now };
    }

    if (dueEmb) {
      const crop = cropFaceFromResult(source, result, cropCanvas, CROP_SIZE);
      const dest = embWriteIdx * cfg.embDim;
      if (crop) {
        const tensor = cropToTensor(crop, CROP_SIZE);
        const output = await run('extractor', {
          [`${CROP_SIZE}x${CROP_SIZE}x3`]: {
            data: tensor,
            shape: [1, CROP_SIZE, CROP_SIZE, 3],
          },
        });
        const embedding = output[`${cfg.embDim}`];
        embBuf.set(embedding, dest);
      } else {
        // Sin rostro: NaN, que la interpolación resolverá si son pocos
        embBuf.fill(NaN, dest, dest + cfg.embDim);
      }
      embWriteIdx = (embWriteIdx + 1) % cfg.nEmbFrames;
      embFrameCount = Math.min(embFrameCount + 1, cfg.nEmbFrames);
      lastEmbSampleAt = now;
    }

    // Solo se predice con la ventana COMPLETA: con menos de 10 segundos de
    // historia, la media y el desvío temporal que consume el modelo se
    // calcularían sobre una ventana más corta que la del entrenamiento.
    const windowComplete = geomFrameCount >= cfg.nFrames && embFrameCount >= cfg.nEmbFrames;
    if (!windowComplete || now - lastPredictionAt < predictionIntervalMs) {
      return null;
    }
    lastPredictionAt = now;
    return await predict(now);
  } finally {
    running = false;
  }
}

/**
 * Reordena un buffer circular a orden cronológico. El modelo espera la
 * secuencia en orden temporal, y el buffer tiene el cuadro más viejo en la
 * posición de escritura actual.
 */
function orderChronologically(buffer, numRows, numCols, writePos) {
  const out = new Float32Array(numRows * numCols);
  for (let i = 0; i < numRows; i += 1) {
    const origin = ((writePos + i) % numRows) * numCols;
    out.set(buffer.subarray(origin, origin + numCols), i * numCols);
  }
  return out;
}

async function predict(now) {
  const rawGeom = orderChronologically(geomBuf, cfg.nFrames, N_FEATURES, geomWriteIdx);
  const rawEmb = orderChronologically(embBuf, cfg.nEmbFrames, cfg.embDim, embWriteIdx);

  // Porcentaje de cara (0-100) de los últimos 10 s, o `null` si todavía no hay
  // cuadros suficientes. Es el que decide atento o desatento (`veredicto.js`),
  // y es también el `concentration` que se reporta.
  const face = faceScore.value(now);
  const pct = (v) => (v === null ? null : Math.round(v));

  const noFace = noFaceFraction(rawGeom, cfg.nFrames, N_FEATURES);
  if (noFace > MAX_NO_FACE_FRACTION) {
    return {
      type: 'no_face',
      faceConcentration: pct(face),
      noFaceFraction: noFace,
      message: 'No se detectó el rostro en una parte suficiente de la ventana',
    };
  }

  // Instrumentación, NO decisión: magnitud de la dinámica facial de la ventana.
  // Se computa ANTES del bloque de reglas a propósito: la ventana tiene una
  // dinámica medible decida quien decida, y dejarla fuera del veredicto por
  // regla la haría quedar pegada del estado anterior en el registro de sesión
  // — que es exactamente lo que pasó en la sesión del 2026-08-27.
  const dinamica = resumenDinamica(rawGeom).dinamica;

  // ── Capa de reglas geométricas — con prioridad sobre la cara ──────────────
  // `Protocolo_Reglas_Geometricas.md` §2.4: si R1 o R2 se activan, la ventana es
  // desatención. Se evalúan acá y la decisión se toma más abajo, en
  // `decideState()`, después de consultar igual al modelo.
  //
  // Las reglas cubren lo que el modelo no puede: se entrenó sobre un conjunto
  // donde la cabeza se desvía el 0,9 % de los cuadros en rachas de 0,07 s y no
  // hay un solo bostezo, de modo que no aprendió esas conductas. Sus umbrales,
  // en cambio, no salen de ningún dataset — 20° es geometría de pantalla y
  // PERCLOS > 0,15 es Dinges & Grace (1998).
  //
  // Se exige la ventana COMPLETA (50 s) antes de dejar que una regla decida. Con
  // media ventana la fracción de R1 se calcula sobre menos cuadros y se vuelve
  // mucho más fácil de superar por azar: la especificidad medida (0 activaciones
  // de R1 en 975 ventanas) vale sobre la ventana entera, no sobre un tramo.
  const ruleWindowFilled = ruleFrameCount >= ruleYawBuf.length;
  let reglas = null;
  if (ruleWindowFilled) {
    const yawWin = orderChronologically(ruleYawBuf, ruleYawBuf.length, 1, ruleWriteIdx);
    const earWin = orderChronologically(ruleEarBuf, ruleEarBuf.length, 1, ruleWriteIdx);
    reglas = evaluarReglas(yawWin, earWin, baselineEar);
  }
  const ruleFired = Boolean(reglas?.dispara);

  const geom = prepareGeometric(rawGeom);

  // Dos cabezas de decisión posibles, con pipelines de apariencia DISTINTOS.
  // El ensemble es el modelo validado (§16 del registro de resultados); el
  // modelo A queda como reserva mientras se termina la migración.
  let p;
  if (isEnsembleLoaded()) {
    // Ensemble: embeddings CRUDOS (estandariza el resumen, no los embeddings).
    const embRaw = prepareEmbeddings(rawEmb, { standardize: false });
    ({ p } = predictEnsemble(geom, embRaw));
  } else {
    // Modelo A: embeddings estandarizados con `emb_scaler`.
    const emb = prepareEmbeddings(rawEmb);
    const outputs = await run('decision', {
      [`${cfg.nFrames}x32`]: { data: geom, shape: [1, cfg.nFrames, 32] },
      [`${cfg.nEmbFrames}x${cfg.embDim}`]: { data: emb, shape: [1, cfg.nEmbFrames, cfg.embDim] },
    });
    // La cabeza binaria es la única salida escalar por muestra (forma "1")
    p = outputs['1']?.[0];
    if (p === undefined) {
      throw new Error(`El modelo no devolvió una salida escalar. Claves: ${Object.keys(outputs).join(', ')}`);
    }
  }

  // ── Ventana de decisión ────────────────────────────────────────────────────
  // La predicción de este instante entra al buffer y la opinión del modelo se
  // forma sobre el PROMEDIO de las últimas WINDOW_SIZE. Se promedian
  // PROBABILIDADES y se compara una sola vez contra la frontera; no se cuentan
  // decisiones duras (ver el comentario de WINDOW_SIZE).
  //
  // Mientras la ventana no esté llena se calcula el promedio de lo que haya,
  // pero ese promedio NO opina en el veredicto (`veredicto.js`): no es el punto
  // validado. `windowFilled` deja ver al consumidor en qué régimen está.
  const nowMs = Date.now();
  recentPredictions.push({ p, ts: nowMs });
  pruneBuffer(recentPredictions, nowMs, WINDOW_SIZE, CLIP_SPAN_MS);
  const win = aggregateWindow(recentPredictions, WINDOW_SIZE, CLIP_SPAN_MS);
  const pWindow = win.p;
  const windowFilled = win.filled;

  // Concentración en FRACCIÓN (0-1, misma magnitud que `threshold`) — nunca
  // comparar `threshold` contra el `concentration` en PORCENTAJE de más abajo
  // (0-100), sería un error de unidades de 100x.
  const concentrationFraction = 1 - pWindow;

  // ── Abstención ─────────────────────────────────────────────────────────────
  // La frontera de decisión en el espacio de probabilidad está en `1 - Y`, así
  // que la confianza se mide CONTRA ESA FRONTERA y no contra 0,5: si el modo
  // activo cambia Y, la banda de abstención lo acompaña.
  const boundary = 1 - threshold;
  const confidence = Math.abs(pWindow - boundary);
  const margin = confidenceMargin();
  const abstains = margin !== null && windowFilled && confidence < margin;

  // ── Veredicto de tres estados ──────────────────────────────────────────────
  // Reemplaza al promedio 0,9 × cara + 0,1 × modelo. Ver `veredicto.js`.
  const verdict = decideState({
    face, ruleFired, pWindow, windowFilled, abstains, threshold,
  });

  // Sin valor de cara no se emite nada, igual que durante el llenado inicial:
  // la próxima predicción llega en dos segundos. Con los buffers del modelo ya
  // llenos (condición para llegar acá) no debería pasar nunca.
  if (verdict.state === STATE.SIN_VEREDICTO) return null;

  const inattentive = verdict.state === STATE.DESATENTO;
  const modelConcentration = Math.round(concentrationFraction * 100);

  if (ruleFired) {
    return {
      type: 'rule',
      // Cada alerta declara su fuente (§2.4): el docente tiene que poder
      // distinguir "el modelo estima desatención" de "esta persona tuvo la
      // cabeza girada 18 de los últimos 50 segundos".
      source: reglas.fuente,
      state: verdict.state,
      modelOpinion: verdict.modelOpinion,
      inattentive,
      dinamica,
      // Confianza 1,0 por definición: no es una probabilidad estimada sino una
      // condición verificada sobre el video.
      confidence: 1,
      // 0 %, como antes del puntaje de cara: la regla no produce un porcentaje
      // propio, y un 0 mantiene coherentes a los consumidores que clasifican
      // por `concentration` (el color de la vista previa, la alerta de fatiga).
      // El puntaje de cara de la ventana viaja aparte, en `faceConcentration`.
      concentration: 0,
      faceConcentration: pct(face),
      modelConcentration,
      detail: {
        R1: reglas.R1.dispara,
        fracDesviado: reglas.R1.fracDesviado,
        rachaSeg: reglas.R1.rachaSeg,
        R2: reglas.R2.dispara,
        perclos: reglas.R2.perclos,
        microsuenoSeg: reglas.R2.microsuenoSeg,
        baselineEar,
      },
      message: reglas.fuente === 'R1'
        ? 'Cabeza orientada fuera de la pantalla de forma sostenida'
        : 'Signos de somnolencia sostenidos (cierre ocular)',
      noFaceFraction: noFace,
      faceWidthPx: lastFaceWidthPx,
      ts: Date.now(),
    };
  }

  if (abstains) {
    return {
      type: 'no_judgement',
      // ── Las dos causas de abstención NO se mezclan (`Enmienda_2` §4bis.4) ──
      // `low_confidence` es una propiedad DEL MODELO: observó en condiciones
      // válidas y la probabilidad quedó cerca de la frontera. Su cobertura de
      // 0,60 es lo que la tesis reporta y defiende, y sólo significa eso
      // mientras no se le sumen abstenciones de otro origen.
      //
      // La otra causa —`out_of_domain`, no poder observar en condiciones
      // válidas por encuadre insuficiente— es una propiedad de la INSTALACIÓN
      // del usuario, es la única de las dos que él puede corregir, y todavía NO
      // está implementada: su umbral en píxeles no está congelado
      // (`Enmienda_2` §4bis.6). El campo existe desde ahora para que, cuando se
      // congele, se contabilice por separado y el 0,60 conserve su significado.
      reason: 'low_confidence',
      state: verdict.state,
      modelOpinion: verdict.modelOpinion,
      dinamica,
      // Sin opinión del modelo, el estado y el porcentaje salen de la cara.
      concentration: pct(face),
      inattentive,
      faceConcentration: pct(face),
      // ¿Alcanzaron a evaluarse las reglas sobre esta ventana? Distingue
      // "se observó con las dos capas y ninguna encontró evidencia" de "todavía
      // no hay 50 s de historia geométrica". La interfaz lo necesita para
      // decidir qué mostrar cuando el modelo se abstiene (`Enmienda_7`).
      rulesEvaluated: ruleWindowFilled,
      pInattention: pWindow,
      confidence,
      confidenceMargin: margin,
      threshold,
      windowFilled,
      noFaceFraction: noFace,
      faceWidthPx: lastFaceWidthPx,
      message: 'Confianza insuficiente para emitir un juicio en esta ventana',
      ts: Date.now(),
    };
  }

  return {
    type: 'prediction',
    // Cada juicio declara su fuente, igual que las alertas de regla. El estado
    // atento/desatento lo decide el puntaje de cara; el modelo sólo agrega el
    // tercer estado (`atento_aburrimiento`).
    source: 'model',
    state: verdict.state,
    modelOpinion: verdict.modelOpinion,
    dinamica,
    rulesEvaluated: ruleWindowFilled,
    // Probabilidad PROMEDIADA sobre la ventana, que es sobre la que opina el
    // modelo.
    pInattention: pWindow,
    // La del instante, solo informativa (útil para depurar y para graficar la
    // señal cruda). NO usarla para decidir: el modelo se validó sobre el
    // promedio de la ventana.
    pInstant: p,
    // Muestras efectivamente promediadas y tramo temporal que cubren. `spanMs`
    // debería tender a WINDOW_SIZE * CLIP_SPAN_MS (50 s); si se queda corto es
    // que el buffer no tiene historia suficiente todavía.
    windowSamples: win.samples,
    windowSpanMs: win.spanMs,
    windowFilled,
    confidence,
    // Y (`threshold`) es un umbral de ATENCIÓN: "concentración > umbral" ⇒
    // atento. `<=` (no `<`) a propósito: en el límite exacto (concentración
    // == umbral) se considera desatento — ver `veredicto.js`.
    inattentive,
    // "Concentración" es lo que muestra el panel (`ConcentrationStats.jsx`
    // razona en términos de concentración, no de desatención), en PORCENTAJE:
    // es el puntaje de cara, que es el que decide.
    concentration: pct(face),
    faceConcentration: pct(face),
    modelConcentration,
    threshold,
    noFaceFraction: noFace,
    // Instrumentación para calibrar el umbral de observabilidad mínima. No se
    // decide sobre este valor (ver `faceWidthFromResult` en features.js).
    faceWidthPx: lastFaceWidthPx,
    ts: Date.now(),
  };
}

/** Vacía los buffers. Se llama al cortar la cámara, para que al reanudar no se
 *  mezclen cuadros de dos momentos distintos separados por un hueco. */
export function reset() {
  if (!ready) return;
  geomBuf.fill(NaN);
  embBuf.fill(NaN);
  geomWriteIdx = 0;
  embWriteIdx = 0;
  geomFrameCount = 0;
  embFrameCount = 0;
  lastGeomSampleAt = 0;
  lastEmbSampleAt = 0;
  lastPredictionAt = 0;
  // La ventana de decisión también: si no, al reanudar se promediarían
  // probabilidades de antes del corte con las nuevas.
  recentPredictions.length = 0;

  // Ventana de las reglas: mismo motivo. Una racha de yaw de antes del corte
  // pegada a otra de después sería una desviación sostenida que nunca ocurrió.
  ruleYawBuf.fill(NaN);
  ruleEarBuf.fill(NaN);
  ruleWriteIdx = 0;
  ruleFrameCount = 0;
  lastFaceWidthPx = NaN;
  faceScore.reset();
  lastGeomDetection = null;

  // La línea base de EAR SÍ se conserva: es una propiedad fisiológica del
  // sujeto, no del tramo de video. Recalibrar en cada corte de cámara dejaría a
  // R2 sin operar 30 s cada vez, que es justo el hueco que la `Enmienda_5`
  // vino a cerrar. Se descarta sólo al reiniciar el documento offscreen.
}

/** Instrumentación para el banco de prueba: última detección geométrica. */
export function getLastGeomDetection() {
  return lastGeomDetection;
}

export function windowProgress() {
  if (!ready) return 0;
  return Math.min(geomFrameCount / cfg.nFrames, embFrameCount / cfg.nEmbFrames);
}
