// Reporte PDF de fin de clase (`utils/generateClassReport.js`, botón
// "Descargar reporte" del docente). Se arma el PDF REAL con jsPDF dentro de
// jsdom y se intercepta la descarga (`saveAs`, que jsPDF busca en el ámbito
// global antes de usar su propio mecanismo) para inspeccionar el archivo:
// jsPDF guarda el texto sin comprimir, así que cada sección se puede buscar
// en el contenido crudo del PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  bundleAppForTest,
  installDom,
  installChromeMock,
  waitUntil,
  cleanupTestBundles,
} from './helpers/reactHarness.js';

const require = createRequire(import.meta.url);

let descargas = [];
let respuestas = {};
let unmount;

test.before(async () => {
  const dom = installDom({ url: 'https://meet.google.com/abc-defg-hij' });
  installChromeMock((type) => {
    const respuesta = respuestas[type];
    if (respuesta instanceof Error) throw respuesta;
    return respuesta;
  });
  const saveAs = (blob, nombre) => { descargas.push({ blob, nombre }); };
  global.saveAs = saveAs;
  dom.window.saveAs = saveAs;

  const bundle = require(await bundleAppForTest('tests/fixtures/reporteHarness.jsx'));
  unmount = bundle.unmount;
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  bundle.mount(container);
  await waitUntil(() => typeof global.window.__generateClassReport === 'function');
});

test.after(async () => {
  unmount?.();
  await cleanupTestBundles();
});

test.beforeEach(() => {
  descargas = [];
});

function distribucion(porcentajes, correcta) {
  return porcentajes.map((percent, i) => ({
    label: `Opción ${'ABCD'[i]}`, count: percent / 10, percent, correct: i === correcta,
  }));
}

function datosCompletos() {
  const alumnos = [
    ['Ana', 10, 10, 0], ['Beto', 8, 10, 1], ['Ceci', 6, 10, 0], ['Dani', 2, 10, 6], ['Ema', 0, 0, 0],
  ].map(([name, correctAnswers, totalFinishedQuestions, skippedQuestions], i) => ({
    email: `alumno${i}@test.com`, name: i === 4 ? null : name, correctAnswers, totalFinishedQuestions, skippedQuestions,
  }));
  const preguntas = Array.from({ length: 14 }, (_, i) => ({
    id: i + 1,
    prompt: `Pregunta numero ${i + 1} sobre fotosintesis y respiracion celular`,
    correctOptionIndex: 0,
    optionDistribution: i % 2 === 0 ? distribucion([40, 50, 10, 0], 0) : distribucion([100, 0, 0, 0], 0),
    avgResponseTimeSeconds: i % 3 === 0 ? null : 12,
  }));
  const lista = (prefijo, n) => Array.from({ length: n }, (_, i) => `${prefijo} ${i + 1}: texto largo para forzar el salto de pagina del reporte`);
  return {
    SPARKLE_GET_STUDENT_STATS: { students: alumnos },
    SPARKLE_GET_QUESTIONS_HISTORY: { questions: preguntas },
    SPARKLE_GET_REPORT_DOCUMENT_TOPICS: { status: 200, body: { topics: lista('Tema', 9) } },
    SPARKLE_GET_CLASS_REPORT_ANALYSIS: {
      status: 200,
      body: {
        aiAnalysisAvailable: true,
        strengths: lista('Fortaleza', 6),
        weaknesses: lista('Debilidad', 6),
        questionDiagnostics: [
          { questionId: 1, diagnosis: 'pregunta_confusa', explanation: 'La mayoria eligio la B.' },
          { questionId: 99, diagnosis: 'dificultad_tema', explanation: 'Respuestas dispersas.' },
        ],
        studentRecommendations: lista('Recomendacion', 8).map((recommendation, i) => ({ name: `Alumno ${i}`, recommendation })),
        suggestedTopics: lista('Sugerido', 6),
      },
    },
  };
}

async function contenidoDelPdf() {
  assert.equal(descargas.length, 1, 'se descargó exactamente un PDF');
  return Buffer.from(await descargas[0].blob.arrayBuffer()).toString('latin1');
}

test('Con datos completos arma todas las secciones, en varias páginas, y lo descarga con nombre de archivo saneado', async () => {
  respuestas = datosCompletos();
  await global.window.__generateClassReport({ meetingCode: 'ABC/def ghi', email: 'docente@test.com' });

  assert.match(descargas[0].nombre, /^reporte-clase-ABC-def-ghi-\d{4}-\d{2}-\d{2}\.pdf$/);
  const pdf = await contenidoDelPdf();
  assert.ok(pdf.startsWith('%PDF-'));
  for (const texto of ['Excelente', 'Bien', 'Regular', 'Necesita apoyo', 'Fortaleza 1', 'Debilidad 6',
    'posible pregunta confusa', 'dificultad del tema', 'Pregunta #99', 'Recomendacion 8', 'Sugerido 6',
    'alumno4@test.com', 'Opci']) {
    assert.ok(pdf.includes(texto), `el PDF debería contener "${texto}"`);
  }
  const paginas = (pdf.match(/\/Type \/Page\b/g) || []).length;
  assert.ok(paginas >= 4, `se esperaban varias páginas y hay ${paginas}`);
  assert.ok(!/\bIA\b|OpenAI|inteligencia artificial/i.test(pdf), 'el reporte nunca menciona que el análisis viene de una IA');
});

test('Sin temas del documento usa los enunciados de las preguntas; sin análisis disponible lo dice', async () => {
  respuestas = {
    ...datosCompletos(),
    SPARKLE_GET_REPORT_DOCUMENT_TOPICS: new Error('falló la red'),
    SPARKLE_GET_CLASS_REPORT_ANALYSIS: { status: 200, body: { aiAnalysisAvailable: false } },
  };
  await global.window.__generateClassReport({ meetingCode: 'abc', email: 'docente@test.com' });
  const pdf = await contenidoDelPdf();
  assert.ok(pdf.includes('Pregunta numero 1 sobre'));
  assert.ok(pdf.includes('no est'), 'aviso de análisis no disponible');
});

test('Un análisis que falla (status distinto de 200 o error de red) no impide generar el resto del reporte', async () => {
  for (const analisis of [{ status: 502, body: { error: 'x' } }, new Error('sin conexión')]) {
    descargas = [];
    respuestas = { ...datosCompletos(), SPARKLE_GET_CLASS_REPORT_ANALYSIS: analisis, SPARKLE_GET_REPORT_DOCUMENT_TOPICS: { status: 500 } };
    await global.window.__generateClassReport({ meetingCode: 'abc', email: 'docente@test.com' });
    const pdf = await contenidoDelPdf();
    assert.ok(pdf.includes('Necesita apoyo'));
  }
});

test('Con pocos datos (un alumno, una pregunta, análisis vacío) el reporte sale igual, en menos páginas', async () => {
  respuestas = {
    SPARKLE_GET_STUDENT_STATS: { students: [{ email: 'a@test.com', name: 'Ana', correctAnswers: 1, totalFinishedQuestions: 1, skippedQuestions: 0 }] },
    SPARKLE_GET_QUESTIONS_HISTORY: { questions: [{ id: 1, prompt: 'Unica', correctOptionIndex: 0, optionDistribution: null }] },
    SPARKLE_GET_REPORT_DOCUMENT_TOPICS: { status: 200, body: {} },
    SPARKLE_GET_CLASS_REPORT_ANALYSIS: { status: 200, body: { aiAnalysisAvailable: true } },
  };
  await global.window.__generateClassReport({ meetingCode: 'abc', email: 'docente@test.com' });
  const pdf = await contenidoDelPdf();
  assert.ok(pdf.includes('Excelente'));
  assert.ok(!pdf.includes('saltearon'), 'sin alumnos que saltean mucho no aparece esa sección');
});

test('Sin alumnos o sin preguntas no genera nada y avisa que no hay datos suficientes', async () => {
  respuestas = { ...datosCompletos(), SPARKLE_GET_QUESTIONS_HISTORY: { questions: [] } };
  await assert.rejects(
    () => global.window.__generateClassReport({ meetingCode: 'abc', email: 'docente@test.com' }),
    (err) => err.code === 'INSUFFICIENT_DATA' && /No hay suficiente información/.test(err.message)
  );
  respuestas = { ...datosCompletos(), SPARKLE_GET_STUDENT_STATS: {} };
  await assert.rejects(() => global.window.__generateClassReport({ meetingCode: 'abc', email: 'docente@test.com' }), /No hay suficiente/);
  assert.equal(descargas.length, 0);
});

test('Si el backend devuelve un error en las estadísticas o en el historial, el error llega tal cual', async () => {
  respuestas = { ...datosCompletos(), SPARKLE_GET_STUDENT_STATS: { error: 'Solo el docente puede ver esto.' } };
  await assert.rejects(() => global.window.__generateClassReport({ meetingCode: 'abc', email: 'x@test.com' }), /Solo el docente/);
  respuestas = { ...datosCompletos(), SPARKLE_GET_QUESTIONS_HISTORY: { error: 'Historial no disponible.' } };
  await assert.rejects(() => global.window.__generateClassReport({ meetingCode: 'abc', email: 'x@test.com' }), /Historial no disponible/);
});
