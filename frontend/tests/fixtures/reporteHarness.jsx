// Expone `generateClassReport` (utils/generateClassReport.js) en
// `window.__generateClassReport` para probarlo empaquetado con esbuild sobre
// jsdom: el módulo importa sin extensión (como lo resuelve Vite), así que
// Node no lo puede importar directo.
import { generateClassReport } from '../../src/utils/generateClassReport.js';

export default function ReporteHarness() {
  window.__generateClassReport = generateClassReport;
  return null;
}
