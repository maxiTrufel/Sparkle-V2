// Copia a `dist/` los binarios que la detección de atención necesita cargar
// por URL en tiempo de ejecución.
//
// Ninguno de estos archivos puede pasar por el bundler: MediaPipe y LiteRT.js
// no los importan, los descargan con `fetch` desde una ruta que se les pasa
// (`FilesetResolver.forVisionTasks(...)`, `loadLiteRt(...)`), así que tienen
// que existir como archivos sueltos dentro del paquete de la extensión.
//
// Los `.wasm` se toman de `node_modules` en vez de versionarlos en el repo:
// así quedan siempre atados a la versión de la librería que declara
// `package.json`, sin riesgo de que el binario y el JS se desincronicen.
//
// Los modelos (`models/`) NO se copian desde node_modules: los produce el
// notebook `Sparkle_V2_Fase3_3_Modelo_Final.ipynb` y hay que colocarlos a mano
// en `public/models/` (ver el README de esa carpeta). Este script solo verifica
// que estén, y avisa con claridad si faltan — sin ellos la extensión compila
// igual pero la detección falla al arrancar.

import { existsSync, mkdirSync, cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(raiz, 'dist');

const COPIAS = [
  {
    desde: join(raiz, 'node_modules/@mediapipe/tasks-vision/wasm'),
    hacia: join(dist, 'mediapipe-wasm'),
    que: 'WASM de MediaPipe Tasks Vision',
  },
  {
    desde: join(raiz, 'node_modules/@litertjs/core/wasm'),
    hacia: join(dist, 'litert-wasm'),
    que: 'WASM de LiteRT.js',
  },
  {
    desde: join(raiz, 'public/models'),
    hacia: join(dist, 'models'),
    que: 'modelos de detección de atención',
  },
  {
    desde: join(raiz, 'public/manifest.json'),
    hacia: join(dist, 'manifest.json'),
    que: 'manifest',
  },
  {
    desde: join(raiz, 'public/icons'),
    hacia: join(dist, 'icons'),
    que: 'iconos de la extension',
  },
  {
    desde: join(raiz, 'public/offscreen.html'),
    hacia: join(dist, 'offscreen.html'),
    que: 'documento offscreen',
  },
  {
    desde: join(raiz, 'public/permission.html'),
    hacia: join(dist, 'permission.html'),
    que: 'pagina de permiso de camara',
  },
];

// Archivos que la detección necesita sí o sí para arrancar. Se listan por
// separado del chequeo de carpeta porque `public/models/` puede existir vacía.
const MODELOS_REQUERIDOS = [
  'preprocesamiento.json',
  'cnn_extractor.tflite',
  'modelo_A_resumen_lineal.tflite',
  'face_landmarker.task',
];

function tamano(ruta) {
  if (!existsSync(ruta)) return 0;
  const s = statSync(ruta);
  if (s.isFile()) return s.size;
  return readdirSync(ruta).reduce((total, f) => total + tamano(join(ruta, f)), 0);
}

mkdirSync(dist, { recursive: true });

let faltantes = 0;
for (const { desde, hacia, que } of COPIAS) {
  if (!existsSync(desde)) {
    console.warn(`[copy-model-assets] FALTA ${que}: ${desde}`);
    faltantes += 1;
    continue;
  }
  cpSync(desde, hacia, { recursive: true });
  console.log(`[copy-model-assets] ${que} → ${hacia.replace(raiz, '.')} (${(tamano(hacia) / 1024).toFixed(0)} kB)`);
}

// Los paquetes de LiteRT.js y MediaPipe traen un build de WASM por cada
// backend soportado (CPU con y sin SIMD, WebGPU, WebNN, variantes con JSPI), y
// juntos pesan decenas de megabytes descomprimidos. Esta extensión usa el
// backend de CPU (ver `ACELERADOR` en src/offscreen/inference.js), así que la
// mayoría de esos binarios se empaquetan sin usarse nunca.
//
// No se filtran automáticamente porque los nombres de archivo cambian entre
// versiones y un filtro equivocado rompe la carga con un error críptico. En
// cambio se listan acá: si el tamaño del paquete llega a ser un problema, este
// inventario dice exactamente qué se puede sacar.
const UMBRAL_AVISO_MB = 25;
const totalMB = tamano(dist) / 1024 / 1024;
console.log(`\n[copy-model-assets] dist/ pesa ${totalMB.toFixed(1)} MB`);

if (totalMB > UMBRAL_AVISO_MB) {
  console.log('[copy-model-assets] Desglose de los binarios de WASM:');
  for (const carpeta of ['mediapipe-wasm', 'litert-wasm']) {
    const ruta = join(dist, carpeta);
    if (!existsSync(ruta)) continue;
    const archivos = readdirSync(ruta)
      .map((f) => ({ f, kb: tamano(join(ruta, f)) / 1024 }))
      .sort((a, b) => b.kb - a.kb);
    console.log(`  ${carpeta}/`);
    for (const { f, kb } of archivos) {
      console.log(`    ${kb.toFixed(0).padStart(7)} kB  ${f}`);
    }
  }
  console.log(
    '\n  La extensión funciona igual con este tamaño (el límite de la Chrome Web\n'
    + '  Store está muy por encima), pero si molesta se pueden borrar de dist/ los\n'
    + '  builds de backends que no se usan — con la extensión ya andando, para\n'
    + '  poder verificar que no se rompió nada.\n',
  );
}

const dirModelos = join(raiz, 'public/models');
const sinModelo = MODELOS_REQUERIDOS.filter((f) => !existsSync(join(dirModelos, f)));
if (sinModelo.length > 0) {
  console.warn(
    '\n[copy-model-assets] La extensión va a compilar, pero la detección de atención '
    + 'NO va a arrancar: faltan estos archivos en public/models/\n'
    + sinModelo.map((f) => `  - ${f}`).join('\n')
    + '\n\nLos tres primeros los genera Sparkle_V2_Fase3_3_Modelo_Final.ipynb (carpeta '
    + 'modelo_final/ en Drive).\nface_landmarker.task se baja de '
    + 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task'
    + '\nVer public/models/README.md\n',
  );
}

if (faltantes > 0) {
  console.warn(`[copy-model-assets] ${faltantes} origen(es) sin copiar — revisar si falta "npm install".`);
}
