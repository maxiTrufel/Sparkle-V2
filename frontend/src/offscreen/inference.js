// Capa de inferencia sobre LiteRT.js — carga los tres `.tflite` y resuelve
// entradas y salidas POR FORMA, nunca por índice.
//
// Ese detalle no es estilístico. Durante el desarrollo del modelo se verificó
// empíricamente que el conversor de TFLite NO preserva el orden en que se
// declaran las entradas ni las salidas del modelo Keras: en el modelo de
// fusión el orden de las dos entradas quedó invertido respecto de los
// `keras.Input`, y en el modelo con cabeza ordinal la salida binaria terminó
// en el índice 1 y no en el 0. Asumir el orden declarado produce un error
// silencioso — se lee la cabeza equivocada y las predicciones son basura sin
// que nada falle.
//
// Los modelos están cuantizados a int8 internamente, pero sus entradas y
// salidas son float32 (comportamiento por defecto de `Optimize.DEFAULT` con
// dataset representativo, verificado sobre el intérprete de Python). Eso es
// obligatorio acá: LiteRT.js solo admite tensores float32 e int32 en la
// frontera del modelo.

import { loadLiteRt, loadAndCompile } from '@litertjs/core';
import { runWithTfjsTensors } from '@litertjs/tfjs-interop';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';

const WASM_PATH = 'litert-wasm/';

// El acelerador por defecto es 'wasm' (CPU con XNNPACK) a propósito, no por
// conservadurismo: los tres modelos suman menos de un megabyte y la
// inferencia tarda milisegundos, así que WebGPU no aporta nada medible y sí
// agrega superficie de fallo — LiteRT.js no soporta delegación parcial, con
// lo cual una sola operación no cubierta por el backend de GPU tira toda la
// carga del modelo. `webgpu` queda disponible por si en el futuro entra un
// modelo más pesado.
const ACCELERATOR = 'wasm';

let started = false;
const models = new Map();

export async function startRuntime(wasmPath = WASM_PATH) {
  if (started) return;
  await tf.setBackend('cpu');
  await tf.ready();
  await loadLiteRt(chrome.runtime.getURL(wasmPath));
  started = true;
}

/**
 * Carga un `.tflite` y cachea sus detalles de entrada y salida indexados por
 * forma, para poder resolverlos sin depender del orden.
 */
export async function loadModel(name, relativePath) {
  if (models.has(name)) return models.get(name);

  const model = await loadAndCompile(chrome.runtime.getURL(relativePath), {
    accelerator: ACCELERATOR,
  });

  const inputs = model.getInputDetails();
  const outputs = model.getOutputDetails();

  const record = {
    name,
    model,
    inputs,
    outputs,
    // clave = dimensiones sin el batch, unidas por "x" (p. ej. "60x32")
    inputByShape: new Map(inputs.map((d, i) => [shapeKey(d.shape), i])),
    outputByShape: new Map(outputs.map((d, i) => [shapeKey(d.shape), i])),
  };

  console.log(
    `[Sparkle][IA] Modelo "${name}" cargado — `
    + `entradas: ${inputs.map((d) => shapeKey(d.shape)).join(', ')} | `
    + `salidas: ${outputs.map((d) => shapeKey(d.shape)).join(', ')}`,
  );

  models.set(name, record);
  return record;
}

function shapeKey(shape) {
  return Array.from(shape).slice(1).join('x');
}

/**
 * Ejecuta un modelo resolviendo las entradas por forma.
 *
 * @param {string} name - modelo ya cargado con `loadModel`
 * @param {Object<string, {data: Float32Array, shape: number[]}>} inputsByShape
 *        mapa clave-de-forma → tensor, p. ej. { '60x32': {...}, '16x128': {...} }
 * @returns {Promise<Object<string, Float32Array>>} salidas indexadas por clave de forma
 */
export async function run(name, inputsByShape) {
  const record = models.get(name);
  if (!record) throw new Error(`Modelo "${name}" sin cargar`);

  // Arma el array de entradas en el orden que el modelo REALMENTE espera
  const tensors = new Array(record.inputs.length);
  for (const [key, index] of record.inputByShape) {
    const input = inputsByShape[key];
    if (!input) {
      throw new Error(`Falta la entrada de forma ${key} para el modelo "${name}"`);
    }
    tensors[index] = tf.tensor(input.data, input.shape, 'float32');
  }

  const outputTensors = await runWithTfjsTensors(record.model, tensors);

  const result = {};
  for (const [key, index] of record.outputByShape) {
    // `data()` es asincrónico y no bloquea; `dataSync` tiene penalización
    // fuerte con backends acelerados (ver la doc de LiteRT.js)
    result[key] = await outputTensors[index].data();
  }

  tf.dispose(tensors);
  tf.dispose(outputTensors);
  return result;
}

/**
 * Prueba de humo con entradas sintéticas. Conviene correrla al arrancar: si un
 * modelo tiene una operación que el backend no soporta, falla acá con un error
 * claro y no en medio de una clase con la cámara prendida.
 */
export async function smokeTestModel(name) {
  const record = models.get(name);
  if (!record) throw new Error(`Modelo "${name}" sin cargar`);

  const inputs = {};
  for (const detail of record.inputs) {
    const key = shapeKey(detail.shape);
    const total = Array.from(detail.shape).reduce((a, b) => a * b, 1);
    inputs[key] = { data: new Float32Array(total), shape: Array.from(detail.shape) };
  }
  const t0 = performance.now();
  const outputs = await run(name, inputs);
  const ms = performance.now() - t0;
  console.log(`[Sparkle][IA] Prueba de "${name}" OK en ${ms.toFixed(1)} ms`);
  return { ok: true, ms, keys: Object.keys(outputs) };
}

export function isModelLoaded(name) {
  return models.has(name);
}
