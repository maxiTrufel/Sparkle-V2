import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La Chrome Web Store rechazó la v0.1.2 con la violación "Blue Argon"
// (`Including remotely hosted code in a Manifest V3 item`), señalando esta URL
// dentro de `content.js`:
//
//   https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js
//
// No es código nuestro ni código que se ejecute: viene adentro de jsPDF, en la
// rama `output('pdfobjectnewwindow')`, que abre una ventana nueva y le inyecta
// PDFObject desde ese CDN. Esta extensión nunca la invoca — el informe del
// docente se genera con `doc.save()` en `generateClassReport.js` — pero el
// revisor de Google mira el paquete, no el flujo: si la URL de un `<script
// src>` remoto está en el bundle, el ítem es rechazado, esté viva o muerta.
//
// Se borra el literal en tiempo de build en vez de parchear node_modules o
// cambiar de librería: es un solo string, en una rama que no se usa, y la
// alternativa (un `patch-package` o un fork de jsPDF) agrega mantenimiento
// permanente para el mismo resultado. `scripts/verificar-sin-codigo-remoto.js`
// corre después del build y falla si vuelve a aparecer una URL remota de
// script — así el día que jsPDF cambie ese código, se entera el build y no la
// revisión de Google.
const URL_CODIGO_REMOTO_JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js';

function sinCodigoRemoto() {
  return {
    name: 'sparkle-sin-codigo-remoto',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('jspdf') || !code.includes(URL_CODIGO_REMOTO_JSPDF)) return null;
      return { code: code.split(URL_CODIGO_REMOTO_JSPDF).join(''), map: null };
    },
  };
}

// Segunda parte del rechazo "Red Titanium" de la v0.1.7 (ver `minify` más
// abajo): aun usando la versión legible de jsPDF, adentro viene su decodificador
// de WebP — un port de libwebp escrito con variables de dos o tres letras, en
// líneas de miles de caracteres —, que para el revisor es indistinguible de
// código ofuscado. La extensión no pone imágenes en el PDF (el informe del
// docente es texto y tablas, ver `generateClassReport.js`), así que la función
// entera se reemplaza por una que avisa si alguna vez se llega a usar. Si
// jsPDF cambia ese código y los marcadores dejan de aparecer, el build falla
// en vez de dejarlo pasar sin que nadie lo note.
const INICIO_DECODIFICADOR_WEBP = 'function WebPDecoder(imageData) {';
const FIN_DECODIFICADOR_WEBP = 'WebPDecoder.prototype.getData = function () {\n  return this.data;\n};';
const DECODIFICADOR_WEBP_VACIO = 'function WebPDecoder() {\n'
  + '  throw new Error("Sparkle no incluye el decodificador de WebP de jsPDF (ver vite.config.js)");\n'
  + '}';

function sinDecodificadorWebP() {
  return {
    name: 'sparkle-sin-decodificador-webp',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('jspdf/dist/jspdf.es.js')) return null;
      const inicio = code.indexOf(INICIO_DECODIFICADOR_WEBP);
      const fin = code.indexOf(FIN_DECODIFICADOR_WEBP, inicio);
      if (inicio === -1 || fin === -1) {
        this.error('No se encontró el decodificador de WebP dentro de jsPDF: revisar sinDecodificadorWebP() en vite.config.js');
      }
      return {
        code: code.slice(0, inicio) + DECODIFICADOR_WEBP_VACIO + code.slice(fin + FIN_DECODIFICADOR_WEBP.length),
        map: null,
      };
    },
  };
}

// La Chrome Web Store rechazó la v0.1.9 otra vez con "Red Titanium", ahora con
// el código ya sin minificar: señaló el polyfill de `Object.create` de core-js
// (`NullProtoObjectViaActiveX`, un iframe con `src = "javascript:"` y
// `document.write`). core-js no lo usa jsPDF directamente: llega con canvg, que
// jsPDF carga con `import('canvg')` solo para `addSvgAsImage()`. Lo mismo
// pasa con html2canvas y DOMPurify, que carga solo para `doc.html()`. El
// informe del docente no usa ninguna de las dos (es texto y tablas, ver
// `generateClassReport.js`), así que esos tres `import()` se reemplazan por un
// error claro y las tres librerías no entran al paquete. Si jsPDF cambia ese
// código y los marcadores dejan de aparecer, el build falla.
// `scripts/verificar-codigo-legible.js` también frena el build si vuelve a
// aparecer core-js.
const CARGAS_OPCIONALES_JSPDF = ['canvg', 'html2canvas', 'dompurify'];

function sinCargasOpcionalesDeJsPDF() {
  return {
    name: 'sparkle-sin-cargas-opcionales-jspdf',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('jspdf/dist/jspdf.es.js')) return null;
      let resultado = code;
      for (const libreria of CARGAS_OPCIONALES_JSPDF) {
        const carga = `return import('${libreria}');`;
        if (!resultado.includes(carga)) {
          this.error(`No se encontró ${carga} dentro de jsPDF: revisar sinCargasOpcionalesDeJsPDF() en vite.config.js`);
        }
        resultado = resultado.split(carga).join(
          `return Promise.reject(new Error("Sparkle no incluye ${libreria} (ver vite.config.js)"));`,
        );
      }
      return { code: resultado, map: null };
    },
  };
}

// Mismo criterio que el anterior: `doc.output()` de jsPDF tiene tres salidas
// que abren una ventana nueva y le meten un `<script>` (PDFObject) o un
// `iframe` (PDF.js, data URL). La extensión nunca las usa — el informe se
// descarga con `doc.save()` —, pero para un revisor es el mismo tipo de truco
// que el de core-js: código que se inyecta en otra ventana. Se reemplazan por
// un error claro; si jsPDF cambia ese código, el build falla.
const INICIO_SALIDAS_VENTANA_NUEVA = 'case "pdfobjectnewwindow":';
const FIN_SALIDAS_VENTANA_NUEVA = 'case "datauri":';
const SALIDAS_VENTANA_NUEVA_VACIAS = 'case "pdfobjectnewwindow":\n'
  + '      case "pdfjsnewwindow":\n'
  + '      case "dataurlnewwindow":\n'
  + '        throw new Error("Sparkle no incluye las salidas de jsPDF a una ventana nueva (ver vite.config.js)");\n'
  + '      ';

function sinSalidasAVentanaNueva() {
  return {
    name: 'sparkle-sin-salidas-ventana-nueva',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('jspdf/dist/jspdf.es.js')) return null;
      const inicio = code.indexOf(INICIO_SALIDAS_VENTANA_NUEVA);
      const fin = code.indexOf(FIN_SALIDAS_VENTANA_NUEVA, inicio);
      const tramo = code.slice(inicio, fin);
      if (inicio === -1 || fin === -1 || !tramo.includes('case "pdfjsnewwindow":') || !tramo.includes('case "dataurlnewwindow":')) {
        this.error('No se encontraron las salidas a ventana nueva dentro de jsPDF: revisar sinSalidasAVentanaNueva() en vite.config.js');
      }
      return { code: code.slice(0, inicio) + SALIDAS_VENTANA_NUEVA_VACIAS + code.slice(fin), map: null };
    },
  };
}

// Rollup no soporta múltiples entry points en un mismo bundle IIFE (el
// content script y el service worker de la extensión se cargan como
// scripts clásicos independientes, no como módulos con code-splitting), así
// que el build corre una vez por cada entry point, elegido con --mode (ver
// los scripts "build"/"dev" en package.json). `emptyOutDir` queda en false
// acá porque limpiar dist/ es responsabilidad de los scripts "prebuild"/
// "predev" — así el segundo build no borra lo que dejó el primero.
const ENTRIES = {
  content: 'src/content/main.jsx',
  background: 'src/background/main.js',
  offscreen: 'src/offscreen/main.js',
  permission: 'src/permission/main.js',
};

// El bundle del offscreen NO puede ser IIFE como los otros dos: MediaPipe y
// LiteRT.js cargan sus binarios de WebAssembly con `import()` dinámico y con
// workers, y eso necesita un módulo ES real. Por eso `offscreen.html` lo
// incluye con `<script type="module">` y este build usa `format: 'es'`.
const ES_MODULE_ENTRIES = new Set(['offscreen', 'permission']);

export default defineConfig(({ mode }) => {
  const entryName = ENTRIES[mode] ? mode : 'content';
  const esModule = ES_MODULE_ENTRIES.has(entryName);

  return {
    plugins: [react(), sinCodigoRemoto(), sinDecodificadorWebP(), sinCargasOpcionalesDeJsPDF(), sinSalidasAVentanaNueva()],
    resolve: {
      alias: [
        // jsPDF publica por defecto un build ya minificado (`jspdf.es.min.js`),
        // con las mismas variables de una o dos letras que motivaron el
        // rechazo "Red Titanium" (ver `minify` más abajo). El paquete trae
        // también la versión legible del mismo código, y se usa esa.
        { find: /^jspdf$/, replacement: 'jspdf/dist/jspdf.es.js' },
      ],
    },
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      // La Chrome Web Store rechazó la v0.1.7 con la violación "Red Titanium"
      // (`Having obfuscated code in the package`), señalando en `content.js`
      // un fragmento como `$B = "script", j6 = mce("IE_PROTO")`. Era el
      // polyfill de `Object.create` de core-js, que llega adentro de jsPDF: el
      // minificador de Vite le había renombrado las variables a una o dos
      // letras, y el revisor no distingue eso de ofuscar. Sin minificar el
      // bundle pesa más, pero se lee con los nombres originales de cada
      // librería. `scripts/verificar-sin-codigo-remoto.js` también frena el
      // build si vuelve a salir minificado.
      minify: false,
      cssCodeSplit: false,
      // Los .wasm y .task son binarios grandes: si Vite los inlinea como
      // base64 el bundle explota y además deja de poder cargarlos por URL.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          [entryName]: ENTRIES[entryName],
        },
        output: esModule
          ? {
            format: 'es',
            entryFileNames: '[name].js',
            chunkFileNames: 'offscreen-chunks/[name]-[hash].js',
            assetFileNames: 'offscreen-chunks/[name]-[hash].[ext]',
          }
          : {
            format: 'iife',
            entryFileNames: '[name].js',
            chunkFileNames: '[name].js',
            assetFileNames: '[name].[ext]',
          },
      },
    },
  };
});
