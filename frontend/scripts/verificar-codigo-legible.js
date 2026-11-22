// Falla el build si el paquete de la extensión trae código minificado.
//
// Existe por un rechazo real de la Chrome Web Store: la v0.1.7 volvió con la
// violación "Red Titanium" — `Having obfuscated code in the package` — por un
// fragmento de core-js (llega adentro de jsPDF) al que el minificador de Vite
// le había dejado variables de una o dos letras. El revisor no distingue
// minificado de ofuscado. Ver `minify: false` y `sinDecodificadorWebP()` en
// vite.config.js.
//
// El síntoma que se busca es una línea de código muy larga: el código
// minificado se escribe en pocas líneas enormes, y el escrito por personas no.
// Las líneas largas que son datos no cuentan: los estilos del panel y las
// tablas en base64 de html2canvas son la asignación de un solo string, y las
// tablas de Unicode de jsPDF o de MediaPipe son arrays de números o de textos,
// que casi no tienen llamadas a funciones.
//
// Uso: `node scripts/verificar-codigo-legible.js [carpeta]` (por defecto dist/).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const carpeta = process.argv[2] ? resolve(process.argv[2]) : join(raiz, 'dist');

const LARGO_MAXIMO = 2000;
// Una línea de datos casi no llama funciones; una de código minificado, cientos.
const LLAMADAS_MAXIMAS = 20;
const ASIGNACION_DE_UN_LITERAL = /^\s*(?:var|let|const)\s+[\w$]+\s*=\s*["'`[]/;

function archivos(dir) {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    return statSync(ruta).isDirectory() ? archivos(ruta) : [ruta];
  });
}

function esCodigoMinificado(linea) {
  if (linea.length <= LARGO_MAXIMO) return false;
  if (ASIGNACION_DE_UN_LITERAL.test(linea)) return false;
  return (linea.match(/\(/g) ?? []).length > LLAMADAS_MAXIMAS;
}

// Patrones que el revisor lee como código escondido aunque esté legible. La
// v0.1.9 volvió rechazada con "Red Titanium" por el polyfill de
// `Object.create` de core-js (llegaba con canvg, adentro de jsPDF), que usa
// `ActiveXObject`, un iframe con `src = "javascript:"` y `document.write`. Ver
// `sinCargasOpcionalesDeJsPDF()` y `sinSalidasAVentanaNueva()` en
// vite.config.js. Si una dependencia nueva trae algo de esto, se frena acá.
const PATRONES_SOSPECHOSOS = [
  { nombre: 'core-js', patron: /__core-js_shared__/ },
  { nombre: 'ActiveXObject', patron: /ActiveXObject/ },
  { nombre: 'document.write', patron: /document\.write/ },
  { nombre: 'una URL "javascript:"', patron: /["'`]javascript:/ },
  { nombre: 'eval()', patron: /(?<![\w$.])eval\s*\(/ },
  { nombre: 'new Function()', patron: /new Function\s*\(/ },
  // MediaPipe arma un <script> en el offscreen para cargar su motor, que es
  // un archivo local del paquete. En cualquier otro lado no tiene por qué haber.
  {
    nombre: 'un <script> armado a mano',
    patron: /createElement\(\s*["']script["']\s*\)/,
    permitidoEn: /(^|\/)offscreen(\.js$|-chunks\/)/,
  },
];

const hallazgos = [];
for (const ruta of archivos(carpeta)) {
  if (!/\.m?js$/.test(ruta)) continue;
  const contenido = readFileSync(ruta, 'utf8');
  const archivo = relative(raiz, ruta);
  for (const { nombre, patron, permitidoEn } of PATRONES_SOSPECHOSOS) {
    if (permitidoEn?.test(archivo)) continue;
    if (patron.test(contenido)) hallazgos.push(`  ${archivo}: trae ${nombre}, que se ve como código escondido`);
  }
  contenido.split('\n').forEach((linea, i) => {
    if (esCodigoMinificado(linea)) {
      hallazgos.push(`  ${relative(raiz, ruta)}:${i + 1} (${linea.length} caracteres)\n    ${linea.trim().slice(0, 100)}…`);
    }
  });
}

if (hallazgos.length > 0) {
  console.error(
    '\n[verificar-codigo-legible] El paquete trae código minificado o que parece\n'
    + 'escondido. La Chrome Web Store lo va a rechazar con la violación "Red Titanium":\n'
    + hallazgos.slice(0, 10).join('\n')
    + (hallazgos.length > 10 ? `\n  … y ${hallazgos.length - 10} líneas más` : '')
    + '\n\nSi es nuestro build: revisar que `minify` siga en false en vite.config.js.\n'
    + 'Si viene de una dependencia que publica su código ya minificado: apuntar\n'
    + 'a su versión legible con un `resolve.alias` (como se hizo con jsPDF).\n',
  );
  process.exit(1);
}

console.log('[verificar-codigo-legible] dist/ no trae código minificado — OK');
