// Contrato entre el service worker y el backend (`services/api.js`): cada
// función arma la URL, el verbo y el cuerpo que espera
// `backend/src/routes/meetings.js`, y devuelve la respuesta con la forma que
// espera quien la llama (el JSON tal cual, o `{ status, body }`). Se prueba
// con un `fetch` simulado que registra cada pedido — sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/services/api.js';
import { getBackendUrl } from '../src/config.js';

const BASE = getBackendUrl();
let pedidos = [];
let respuesta = { status: 200, body: { ok: true } };

const fetchOriginal = globalThis.fetch;
test.before(() => {
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('data:')) return fetchOriginal(url);
    pedidos.push({ url: String(url), init });
    return new Response(JSON.stringify(respuesta.body), { status: respuesta.status });
  };
});
test.after(() => {
  globalThis.fetch = fetchOriginal;
});
test.beforeEach(() => {
  pedidos = [];
  respuesta = { status: 200, body: { ok: true } };
});

const MC = 'abc-defg-hij';
const EMAIL = 'ana@test.com';

// [función, args, método, path esperado (sin base), body esperado | undefined, devuelve {status, body}]
const CASOS = [
  ['registerMeetingRole', [MC, EMAIL, 'teacher'], 'POST', '/api/meetings/register-role', { meetingCode: MC, email: EMAIL, role: 'teacher' }, false],
  ['getMeetingRole', [MC, EMAIL], 'GET', `/api/meetings/role?meetingCode=${MC}&email=ana%40test.com`, undefined, false],
  ['registerStudent', [MC, EMAIL, 'Ana'], 'POST', '/api/meetings/register-student', { meetingCode: MC, email: EMAIL, name: 'Ana' }, true],
  ['getHistory', [MC], 'GET', `/api/meetings/history?meetingCode=${MC}`, undefined, false],
  ['getHasTeacher', [MC, EMAIL], 'GET', `/api/meetings/has-teacher?meetingCode=${MC}&email=ana%40test.com`, undefined, false],
  ['getCameraEnabled', [MC, EMAIL], 'GET', `/api/meetings/camera?meetingCode=${MC}&email=ana%40test.com`, undefined, false],
  ['updateCameraEnabled', [MC, EMAIL, true], 'POST', '/api/meetings/camera', { meetingCode: MC, email: EMAIL, enabled: true }, false],
  ['generateQuestion', [MC, EMAIL, ['¿Vieja?']], 'POST', '/api/meetings/generate-question', { meetingCode: MC, email: EMAIL, discardedPrompts: ['¿Vieja?'] }, false],
  ['getQuestionsHistory', [MC, EMAIL], 'GET', `/api/meetings/questions/history?meetingCode=${MC}&email=ana%40test.com`, undefined, false],
  ['getMyQuestionAnswers', [MC, EMAIL], 'GET', `/api/meetings/questions/my-answers?meetingCode=${MC}&email=ana%40test.com`, undefined, false],
  ['getStudentStats', [MC, EMAIL], 'GET', `/api/meetings/questions/student-stats?meetingCode=${MC}&email=ana%40test.com`, undefined, false],
  ['getCurrentDocument', [MC, EMAIL], 'GET', `/api/meetings/${MC}/documents?email=ana%40test.com`, undefined, false],
  ['getClassSummary', [MC, EMAIL], 'GET', `/api/meetings/${MC}/summary?email=ana%40test.com`, undefined, true],
  ['getRecoverySummary', [MC, EMAIL], 'GET', `/api/meetings/${MC}/recovery-summary?email=ana%40test.com`, undefined, true],
  ['getFinalQuiz', [MC, EMAIL], 'GET', `/api/meetings/${MC}/final-quiz?email=ana%40test.com`, undefined, true],
  ['getAttentionSnapshots', [MC, EMAIL], 'GET', `/api/meetings/${MC}/attention-snapshots?email=ana%40test.com`, undefined, true],
  ['getClassReportAnalysis', [MC, EMAIL], 'GET', `/api/meetings/${MC}/report/ai-analysis?email=ana%40test.com`, undefined, true],
  ['getReportDocumentTopics', [MC, EMAIL], 'GET', `/api/meetings/${MC}/report/document-topics?email=ana%40test.com`, undefined, true],
];

for (const [nombre, args, metodo, path, body, conStatus] of CASOS) {
  test(`${nombre}: ${metodo} ${path.split('?')[0]}`, async () => {
    respuesta = { status: 201, body: { resultado: nombre } };
    const resultado = await api[nombre](...args);

    assert.equal(pedidos.length, 1);
    const [{ url, init }] = pedidos;
    assert.equal(url, `${BASE}${path}`);
    assert.equal(init.method || 'GET', metodo);
    if (body !== undefined) {
      assert.deepEqual(JSON.parse(init.body), body);
      assert.equal(init.headers['Content-Type'], 'application/json');
    }
    if (conStatus) assert.deepEqual(resultado, { status: 201, body: { resultado: nombre } });
    else assert.deepEqual(resultado, { resultado: nombre });
  });
}

test('generateQuestion sin descartes manda una lista vacía', async () => {
  await api.generateQuestion(MC, EMAIL);
  assert.deepEqual(JSON.parse(pedidos[0].init.body).discardedPrompts, []);
});

test('el código de la reunión se escapa en la URL', async () => {
  await api.getClassSummary('a b/c', EMAIL);
  assert.ok(pedidos[0].url.includes('/api/meetings/a%20b%2Fc/summary'));
});

function archivo(contenido, { size } = {}) {
  const base64 = Buffer.from(contenido).toString('base64');
  return { name: 'material.pdf', dataUrl: `data:application/pdf;base64,${base64}`, size: size ?? Buffer.byteLength(contenido) };
}

test('uploadDocument reconstruye el archivo, lo manda como multipart con el email y devuelve { status, body }', async () => {
  respuesta = { status: 201, body: { document: { id: 1 } } };
  const resultado = await api.uploadDocument(MC, EMAIL, archivo('%PDF-1.4 contenido'));
  assert.deepEqual(resultado, { status: 201, body: { document: { id: 1 } } });
  const [{ url, init }] = pedidos;
  assert.equal(url, `${BASE}/api/meetings/${MC}/documents`);
  assert.equal(init.method, 'POST');
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('email'), EMAIL);
  const enviado = init.body.get('file');
  assert.equal(enviado.name, 'material.pdf');
  assert.equal(await enviado.text(), '%PDF-1.4 contenido');
});

test('uploadDocument no sube un archivo vacío ni uno que no coincide con el tamaño original', async () => {
  await assert.rejects(() => api.uploadDocument(MC, EMAIL, archivo('')), /se leyó vacío \(0 bytes\)/);
  await assert.rejects(() => api.uploadDocument(MC, EMAIL, archivo('abc', { size: 10 })), /se esperaban 10 bytes y se generaron 3/);
  assert.equal(pedidos.length, 0, 'ningún pedido llegó al backend');
});
