// Falla el build si el paquete de la extensión trae una URL remota de script.
//
// Existe por un rechazo real de la Chrome Web Store: la v0.1.2 volvió con la
// violación "Blue Argon" — `Including remotely hosted code in a Manifest V3
// item` — por una URL de cdnjs que venía adentro de jsPDF, en una rama que el
// código nunca ejecuta. Manifest V3 no admite código remoto ni siquiera muerto:
// el revisor mira lo que hay en el ZIP.
//
// El chequeo mira las URLs que terminan en .js, .mjs o .wasm — las decenas de
// URLs de documentación que traen las librerías en sus comentarios (RFCs,
// issues de GitHub, MDN) no terminan en una extensión de código y no lo
// disparan. Las pocas que sí lo hacen están en `ATRIBUCIONES_CONOCIDAS`, una
// por una y con su motivo: son créditos y enlaces a documentación dentro de
// comentarios, no cargas. La lista es corta a propósito — cualquier URL nueva
// frena el build y la mira una persona, que es justamente el punto.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(raiz, 'dist');

const EXTENSIONES_DE_TEXTO = new Set(['.js', '.mjs', '.html', '.css', '.json']);
const URL_DE_SCRIPT = /https?:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+\.(?:js|mjs|wasm)\b/gi;

// Verificadas a mano una por una: las tres viven dentro de comentarios y
// ninguna se carga. Si aparece una cuarta, revisala antes de agregarla acá.
const ATRIBUCIONES_CONOCIDAS = new Map([
  // Crédito al autor del MD5 que jsPDF incluye copiado en su propio código.
  ['http://www.myersdaily.org/joseph/javascript/md5.js', 'atribución en jsPDF'],
  // Cabecera de referencias del cifrado de PDF de jsPDF.
  ['https://github.com/foliojs/pdfkit/blob/master/lib/security.js', 'referencia en jsPDF'],
  // Enlace a la documentación de Emscripten en el preámbulo que genera para
  // el pegamento JS de todos los .wasm de MediaPipe y LiteRT.
  ['http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js', 'documentación de Emscripten'],
]);

function archivos(carpeta) {
  return readdirSync(carpeta).flatMap((nombre) => {
    const ruta = join(carpeta, nombre);
    return statSync(ruta).isDirectory() ? archivos(ruta) : [ruta];
  });
}

const hallazgos = [];
for (const ruta of archivos(dist)) {
  const ext = ruta.slice(ruta.lastIndexOf('.'));
  if (!EXTENSIONES_DE_TEXTO.has(ext)) continue;
  const contenido = readFileSync(ruta, 'utf8');
  for (const url of contenido.match(URL_DE_SCRIPT) ?? []) {
    if (ATRIBUCIONES_CONOCIDAS.has(url)) continue;
    hallazgos.push({ archivo: relative(raiz, ruta), url });
  }
}

if (hallazgos.length > 0) {
  console.error(
    '\n[verificar-sin-codigo-remoto] El paquete trae código remoto. La Chrome Web\n'
    + 'Store lo va a rechazar con la violación "Blue Argon":\n'
    + hallazgos.map(({ archivo, url }) => `  ${archivo}\n    ${url}`).join('\n')
    + '\n\nSi la URL se carga de verdad: cuando viene de una dependencia, agregá el\n'
    + 'literal al plugin `sinCodigoRemoto()` de vite.config.js; si es código\n'
    + 'nuestro, empaquetá el archivo adentro de la extensión. Si es solo una\n'
    + 'atribución o un enlace a documentación dentro de un comentario, sumala a\n'
    + '`ATRIBUCIONES_CONOCIDAS` de este script, con el motivo.\n',
  );
  process.exit(1);
}

console.log('[verificar-sin-codigo-remoto] dist/ no carga ningún script remoto — OK');
