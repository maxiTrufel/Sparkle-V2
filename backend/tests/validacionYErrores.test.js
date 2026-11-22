// Contrato de errores de la capa de controladores (`controllers/*.js` y la
// ruta de transcripción de `routes/meetings.js`), endpoint por endpoint:
//   - 400 cuando falta un parámetro obligatorio (antes de tocar la base).
//   - el `.status` de un error "conocido" del service se respeta tal cual.
//   - 500 con un mensaje genérico ante un error inesperado del service,
//     sin filtrar el detalle técnico al cliente.
// Los services se reemplazan por funciones que fallan a propósito: lo que se
// prueba acá es la traducción a HTTP, no la lógica (que tiene sus propios
// tests contra la base real).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');
const roleService = require('../src/services/roleService');
const sessionService = require('../src/services/sessionService');
const cameraService = require('../src/services/cameraService');
const questionService = require('../src/services/questionService');
const classSummaryService = require('../src/services/classSummaryService');
const recoverySummaryService = require('../src/services/recoverySummaryService');
const finalQuizService = require('../src/services/finalQuizService');
const attentionSnapshotService = require('../src/services/attentionSnapshotService');
const classReportService = require('../src/services/classReportService');
const documentService = require('../src/services/documentService');
const vexaService = require('../src/services/vexaService');
const { UPLOAD_DIR } = require('../src/utils/uploadStorage');

let server;
let apiUrl;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function pedir(metodo, path, body) {
  const opciones = { method: metodo };
  if (body !== undefined) {
    opciones.headers = { 'Content-Type': 'application/json' };
    opciones.body = JSON.stringify(body);
  }
  const resp = await fetch(`${apiUrl}/api/meetings${path}`, opciones);
  return { status: resp.status, body: await resp.json() };
}

// Reemplaza `modulo[nombre]` mientras corre `fn` y lo restaura siempre.
async function conServicio(modulo, nombre, reemplazo, fn) {
  const original = modulo[nombre];
  modulo[nombre] = reemplazo;
  try {
    return await fn();
  } finally {
    modulo[nombre] = original;
  }
}

const falla = async () => { throw new Error('detalle técnico que no debe llegar al cliente'); };
const fallaConocida = (status) => async () => { throw Object.assign(new Error(`error conocido ${status}`), { status }); };

const MC = 'test-validacion-abc';
const q = (params) => `?${new URLSearchParams(params)}`;

// [método, path, body, servicio, función] — el pedido es VÁLIDO en forma:
// lo único que falla es el service.
const ENDPOINTS = [
  ['POST', '/register-role', { meetingCode: MC, email: 'a@test.com', role: 'teacher' }, roleService, 'registerRole'],
  ['GET', `/has-teacher${q({ meetingCode: MC, email: 'a@test.com' })}`, undefined, roleService, 'otherTeacherExists'],
  ['GET', `/role${q({ meetingCode: MC, email: 'a@test.com' })}`, undefined, roleService, 'getRole'],
  ['POST', '/register-student', { meetingCode: MC, email: 'a@test.com', name: 'Ana' }, roleService, 'registerStudent'],
  ['GET', `/history${q({ meetingCode: MC })}`, undefined, sessionService, 'getHistoryByMeeting'],
  ['POST', '/camera', { meetingCode: MC, email: 'a@test.com', enabled: true }, cameraService, 'updatePreference'],
  ['GET', `/camera${q({ meetingCode: MC, email: 'a@test.com' })}`, undefined, cameraService, 'getPreference'],
  ['POST', '/generate-question', { meetingCode: MC, email: 'a@test.com' }, questionService, 'generatePreview'],
  ['GET', `/questions/history${q({ meetingCode: MC, email: 'a@test.com' })}`, undefined, questionService, 'getFinishedQuestionsForMeeting'],
  ['GET', `/questions/my-answers${q({ meetingCode: MC, email: 'a@test.com' })}`, undefined, questionService, 'getStudentQuestionHistory'],
  ['GET', `/questions/student-stats${q({ meetingCode: MC, email: 'a@test.com' })}`, undefined, questionService, 'getStudentStatsForMeeting'],
  ['GET', `/${MC}/summary${q({ email: 'a@test.com' })}`, undefined, classSummaryService, 'getClassSummary'],
  ['GET', `/${MC}/recovery-summary${q({ email: 'a@test.com' })}`, undefined, recoverySummaryService, 'getRecoverySummary'],
  ['GET', `/${MC}/final-quiz${q({ email: 'a@test.com' })}`, undefined, finalQuizService, 'getFinalQuiz'],
  ['GET', `/${MC}/attention-snapshots${q({ email: 'a@test.com' })}`, undefined, attentionSnapshotService, 'getAttentionSnapshots'],
  ['GET', `/${MC}/report/ai-analysis${q({ email: 'a@test.com' })}`, undefined, classReportService, 'getAIAnalysis'],
  ['GET', `/${MC}/report/document-topics${q({ email: 'a@test.com' })}`, undefined, classReportService, 'getDocumentTopics'],
  ['GET', `/${MC}/documents${q({ email: 'a@test.com' })}`, undefined, documentService, 'getCurrentDocument'],
];

// Endpoints de los que solo depende de la forma del pedido: sin el
// parámetro indicado tienen que dar 400 sin llamar a ningún service.
const PEDIDOS_INCOMPLETOS = [
  ['POST', '/register-role', { email: 'a@test.com', role: 'teacher' }, /meetingCode/],
  ['POST', '/register-role', { meetingCode: MC, role: 'teacher' }, /email/],
  ['POST', '/register-role', { meetingCode: MC, email: 'a@test.com', role: 'director' }, /role/],
  ['GET', `/has-teacher${q({ email: 'a@test.com' })}`, undefined, /meetingCode/],
  ['GET', `/has-teacher${q({ meetingCode: MC })}`, undefined, /email/],
  ['GET', `/role${q({ email: 'a@test.com' })}`, undefined, /meetingCode/],
  ['GET', `/role${q({ meetingCode: MC, email: '  ' })}`, undefined, /email/],
  ['POST', '/register-student', { email: 'a@test.com', name: 'Ana' }, /meetingCode/],
  ['POST', '/register-student', { meetingCode: MC, name: 'Ana' }, /email/],
  ['GET', '/history', undefined, /meetingCode/],
  ['POST', '/generate-question', { email: 'a@test.com' }, /meetingCode/],
  ['POST', '/generate-question', { meetingCode: MC }, /email/],
  ['GET', `/questions/history${q({ email: 'a@test.com' })}`, undefined, /meetingCode/],
  ['GET', `/questions/history${q({ meetingCode: MC })}`, undefined, /email/],
  ['GET', `/questions/my-answers${q({ email: 'a@test.com' })}`, undefined, /meetingCode/],
  ['GET', `/questions/my-answers${q({ meetingCode: MC })}`, undefined, /email/],
  ['GET', `/questions/student-stats${q({ email: 'a@test.com' })}`, undefined, /meetingCode/],
  ['GET', `/questions/student-stats${q({ meetingCode: MC })}`, undefined, /email/],
  ['GET', `/${MC}/summary`, undefined, /email/],
  ['GET', `/${MC}/final-quiz`, undefined, /email/],
  ['GET', `/${MC}/documents`, undefined, /email/],
];

test('Cada endpoint responde 400 con un mensaje claro cuando falta un parámetro obligatorio', async () => {
  for (const [metodo, path, body, mensaje] of PEDIDOS_INCOMPLETOS) {
    const { status, body: respuesta } = await pedir(metodo, path, body);
    assert.equal(status, 400, `${metodo} ${path}`);
    assert.match(respuesta.error, mensaje, `${metodo} ${path}`);
  }
});

test('Un body que no es un objeto JSON se trata como parámetros faltantes (400), no como error interno', async () => {
  for (const path of ['/register-role', '/register-student', '/camera', '/generate-question']) {
    const resp = await fetch(`${apiUrl}/api/meetings${path}`, { method: 'POST' });
    assert.equal(resp.status, 400, path);
  }
});

test('Cada endpoint traduce un error inesperado del service a 500 genérico, sin filtrar el detalle', async () => {
  for (const [metodo, path, body, modulo, nombre] of ENDPOINTS) {
    await conServicio(modulo, nombre, falla, async () => {
      const { status, body: respuesta } = await pedir(metodo, path, body);
      assert.equal(status, 500, `${metodo} ${path}`);
      assert.match(respuesta.error, /^Error interno/, `${metodo} ${path}`);
      assert.doesNotMatch(respuesta.error, /detalle técnico/);
    });
  }
});

test('Los errores conocidos del service (con .status) se devuelven con su código y su mensaje', async () => {
  const conStatus = ENDPOINTS.filter(([, , , modulo, nombre]) => !(
    (modulo === roleService && ['otherTeacherExists', 'getRole'].includes(nombre))
    || (modulo === sessionService)
    || (modulo === cameraService && nombre === 'getPreference')
  ));
  for (const [metodo, path, body, modulo, nombre] of conStatus) {
    await conServicio(modulo, nombre, fallaConocida(409), async () => {
      const { status, body: respuesta } = await pedir(metodo, path, body);
      assert.equal(status, 409, `${metodo} ${path}`);
      assert.equal(respuesta.error, 'error conocido 409');
    });
  }
});

test('POST /register-role: un error sin status (no un 409) es un 500', async () => {
  await conServicio(roleService, 'registerRole', fallaConocida(418), async () => {
    const { status } = await pedir('POST', '/register-role', { meetingCode: MC, email: 'a@test.com', role: 'student' });
    assert.equal(status, 500, 'register-role solo traduce el 409; cualquier otro error es interno');
  });
});

test('GET /:meetingCode/transcript: trae de Vexa, guarda y devuelve lo acumulado; si Vexa falla, 500', async () => {
  const originales = {
    getTranscript: vexaService.getTranscript,
    saveSegments: vexaService.saveSegments,
    listStoredSegments: vexaService.listStoredSegments,
  };
  const guardados = [];
  try {
    vexaService.getTranscript = async () => [{ text: 'hola' }];
    vexaService.saveSegments = async (codigo, segmentos) => { guardados.push([codigo, segmentos]); };
    vexaService.listStoredSegments = async () => [{ speaker: 'Docente', text: 'hola' }];
    const ok = await pedir('GET', `/${MC}/transcript`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.segments, [{ speaker: 'Docente', text: 'hola' }]);
    assert.deepEqual(guardados, [[MC, [{ text: 'hola' }]]]);

    vexaService.getTranscript = falla;
    const error = await pedir('GET', `/${MC}/transcript`);
    assert.equal(error.status, 500);
    assert.doesNotMatch(error.body.error, /detalle técnico/);
  } finally {
    Object.assign(vexaService, originales);
  }
});

test('POST /:meetingCode/documents: un error inesperado al guardar es 500 y uno conocido conserva su status', async () => {
  const pdfMinimo = Buffer.from('%PDF-1.4\n%%EOF\n');
  const enviar = async () => {
    const form = new FormData();
    form.append('email', 'docente@test.com');
    form.append('file', new Blob([pdfMinimo], { type: 'application/pdf' }), 'material.pdf');
    const resp = await fetch(`${apiUrl}/api/meetings/${MC}/documents`, { method: 'POST', body: form });
    return { status: resp.status, body: await resp.json() };
  };

  // Con el service reemplazado nadie borra el archivo que multer ya
  // escribió: se borran a mano los que haya dejado este test.
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const previos = new Set(await fs.readdir(UPLOAD_DIR));
  try {
    await conServicio(documentService, 'saveTeacherDocument', falla, async () => {
      const { status, body } = await enviar();
      assert.equal(status, 500);
      assert.match(body.error, /^Error interno/);
    });
    await conServicio(documentService, 'saveTeacherDocument', fallaConocida(403), async () => {
      assert.equal((await enviar()).status, 403);
    });
  } finally {
    for (const nombre of await fs.readdir(UPLOAD_DIR)) {
      if (!previos.has(nombre)) await fs.unlink(`${UPLOAD_DIR}/${nombre}`);
    }
  }
});
