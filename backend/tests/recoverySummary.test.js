// Tests de "Recuperar contenido" (alumno, botón de la alerta de fatiga) —
// mismas capas que `classSummary.test.js`:
//   1. `OpenAIRecoverySummaryProvider` — unitario, con el `client` de
//      OpenAI reemplazado por un stub (nunca llama a la red real).
//   2. `recoverySummaryService` + el endpoint `/recovery-summary` — contra
//      la base real, con `openAIRecoverySummaryProvider.summarize` mockeado.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-fake-key-para-este-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const pool = require('../src/db');
const meetingsRouter = require('../src/routes/meetings');
const transcriptRepository = require('../src/repositories/transcriptRepository');
const documentAnalysisService = require('../src/services/documentAnalysisService');
const { openAIRecoverySummaryProvider } = require('../src/providers');
const { OpenAIRecoverySummaryProvider } = require('../src/providers/openAIRecoverySummaryProvider');
const { RecoverySummaryProvider } = require('../src/providers/recoverySummaryProvider');

let server;
let apiUrl;
let originalSummarize;
let originalGetAnalysisSummary;
const envPrevio = {};
const VARIABLES = ['RECOVERY_SUMMARY_ENABLED', 'OPENAI_RECOVERY_SUMMARY_MIN_CHARS', 'OPENAI_RECOVERY_SUMMARY_MAX_CHARS', 'OPENAI_RECOVERY_SUMMARY_MODEL'];

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiUrl = `http://localhost:${server.address().port}`;

  originalSummarize = openAIRecoverySummaryProvider.summarize;
  originalGetAnalysisSummary = documentAnalysisService.getAnalysisSummary;
  for (const nombre of VARIABLES) envPrevio[nombre] = process.env[nombre];
});

test.after(async () => {
  openAIRecoverySummaryProvider.summarize = originalSummarize;
  documentAnalysisService.getAnalysisSummary = originalGetAnalysisSummary;
  for (const nombre of VARIABLES) {
    if (envPrevio[nombre] === undefined) delete process.env[nombre];
    else process.env[nombre] = envPrevio[nombre];
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test.afterEach(() => {
  openAIRecoverySummaryProvider.summarize = originalSummarize;
  documentAnalysisService.getAnalysisSummary = originalGetAnalysisSummary;
});

function nuevoMeetingCode(etiqueta) {
  return `test-recuperar-${etiqueta}-${crypto.randomBytes(4).toString('hex')}`;
}

async function limpiarReunion(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

async function registrarRol(meetingCode, email, role) {
  await fetch(`${apiUrl}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role }),
  });
}

async function pedirRecuperacion(meetingCode, email) {
  const query = email === undefined ? '' : `?${new URLSearchParams({ email })}`;
  const resp = await fetch(`${apiUrl}/api/meetings/${encodeURIComponent(meetingCode)}/recovery-summary${query}`);
  return { status: resp.status, body: await resp.json() };
}

// `offsetSeconds` negativo = hace cuánto se dijo (la ventana es de 3 min).
async function sembrarSegmento(meetingCode, text, offsetSeconds) {
  await pool.query(
    `INSERT INTO transcript_segments (meeting_code, speaker, text, absolute_start_time, segment_id)
     VALUES (?, 'Docente', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), ?)`,
    [meetingCode, text, offsetSeconds, `${meetingCode}-${offsetSeconds}`]
  );
}

function respuestaDeOpenAI(content) {
  return {
    model: 'gpt-4o-mini',
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  };
}

// ─── 1. Proveedor (unitario, sin red) ───────────────────────────────────

test('RecoverySummaryProvider (contrato base) exige implementar summarize()', async () => {
  await assert.rejects(() => new RecoverySummaryProvider().summarize({}), /no está implementado/);
});

test('OpenAIRecoverySummaryProvider.summarize(): instrucciones en "system", temas + fragmento en "user", bullets filtrados', async () => {
  const provider = new OpenAIRecoverySummaryProvider();
  let params;
  provider.client = {
    chat: {
      completions: {
        create: async (p) => {
          params = p;
          return respuestaDeOpenAI(JSON.stringify({ bullets: ['Se explicó la fotosíntesis.', '   ', 42] }));
        },
      },
    },
  };
  delete process.env.OPENAI_RECOVERY_SUMMARY_MODEL;

  const result = await provider.summarize({
    mainTopics: ['Fotosíntesis'],
    keyConcepts: [{ term: 'Clorofila', definition: 'Pigmento verde.' }],
    transcriptSegments: [{ speaker: 'Docente', text: 'La clorofila absorbe luz.' }, { speaker: null, text: 'Pregunta.' }],
    windowMinutes: 3,
  });

  assert.equal(params.messages[0].role, 'system');
  assert.equal(params.messages[1].role, 'user');
  assert.equal(params.model, 'gpt-4o-mini');
  assert.match(params.messages[1].content, /- Fotosíntesis/);
  assert.match(params.messages[1].content, /- Clorofila: Pigmento verde\./);
  assert.match(params.messages[1].content, /\[Docente\]: La clorofila absorbe luz\./);
  assert.match(params.messages[1].content, /\[Desconocido\]: Pregunta\./);
  assert.match(params.messages[1].content, /ÚLTIMOS 3 MINUTOS/);
  assert.deepEqual(result.bullets, ['Se explicó la fotosíntesis.']);
  assert.equal(result.inputTokens, 120);
  assert.equal(result.outputTokens, 40);
});

test('OpenAIRecoverySummaryProvider.summarize(): sin datos usa los textos de reserva y respeta el tope de caracteres', async () => {
  const provider = new OpenAIRecoverySummaryProvider();
  const mensajes = [];
  provider.client = {
    chat: { completions: { create: async (p) => { mensajes.push(p.messages[1].content); return respuestaDeOpenAI('{"bullets": []}'); } } },
  };

  const sinNada = await provider.summarize();
  assert.deepEqual(sinNada.bullets, []);
  assert.match(mensajes[0], /\(sin temas disponibles\)/);
  assert.match(mensajes[0], /\(sin conceptos disponibles\)/);
  assert.match(mensajes[0], /No hay transcripción disponible para este tramo\./);

  process.env.OPENAI_RECOVERY_SUMMARY_MAX_CHARS = '30';
  try {
    await provider.summarize({ transcriptSegments: [{ speaker: 'Docente', text: 'x'.repeat(500) }], windowMinutes: 2 });
  } finally {
    delete process.env.OPENAI_RECOVERY_SUMMARY_MAX_CHARS;
  }
  const fragmento = mensajes[1].split('ES LA FUENTE PRINCIPAL):\n')[1];
  assert.equal(fragmento.length, 30, 'el fragmento se recorta al tope configurado');
});

test('OpenAIRecoverySummaryProvider.summarize(): una respuesta sin "bullets" se vuelve a pedir; si nunca sale, error para el usuario', async () => {
  const provider = new OpenAIRecoverySummaryProvider();
  let llamadas = 0;
  provider.client = {
    chat: {
      completions: {
        create: async () => {
          llamadas += 1;
          return respuestaDeOpenAI(llamadas === 1 ? '{roto' : '{"resumen": "sin bullets"}');
        },
      },
    },
  };
  await assert.rejects(() => provider.summarize({}), /No se pudo generar el resumen con IA/);
  assert.equal(llamadas, 3);
});

// ─── 2. Servicio + endpoint (base real, proveedor mockeado) ─────────────

test('GET /recovery-summary: 400 sin email y 403 a quien no participó de la clase', async () => {
  const meetingCode = nuevoMeetingCode('auth');
  await registrarRol(meetingCode, 'alumno@test.com', 'student');
  try {
    assert.equal((await pedirRecuperacion(meetingCode)).status, 400);
    const ajeno = await pedirRecuperacion(meetingCode, 'otro@test.com');
    assert.equal(ajeno.status, 403);
  } finally {
    await limpiarReunion(meetingCode);
  }
});

test('GET /recovery-summary con el flag apagado responde 200 con aiSummaryAvailable=false (ai_disabled)', async () => {
  const meetingCode = nuevoMeetingCode('flag-off');
  await registrarRol(meetingCode, 'alumno@test.com', 'student');
  process.env.RECOVERY_SUMMARY_ENABLED = 'false';
  let llamadas = 0;
  openAIRecoverySummaryProvider.summarize = async () => { llamadas += 1; return { bullets: ['x'] }; };
  try {
    const { status, body } = await pedirRecuperacion(meetingCode, 'alumno@test.com');
    assert.equal(status, 200);
    assert.equal(body.aiSummaryAvailable, false);
    assert.equal(body.unavailableReason, 'ai_disabled');
    assert.equal(body.windowMinutes, 3);
    assert.equal(llamadas, 0);
  } finally {
    await limpiarReunion(meetingCode);
  }
});

test('GET /recovery-summary sin transcripción suficiente ni documento: insufficient_content, sin llamar a la IA', async () => {
  const meetingCode = nuevoMeetingCode('sin-contenido');
  await registrarRol(meetingCode, 'alumno@test.com', 'student');
  process.env.RECOVERY_SUMMARY_ENABLED = 'true';
  documentAnalysisService.getAnalysisSummary = async () => null;
  let llamadas = 0;
  openAIRecoverySummaryProvider.summarize = async () => { llamadas += 1; return { bullets: ['x'] }; };
  try {
    await sembrarSegmento(meetingCode, 'Hola.', -20);
    const { status, body } = await pedirRecuperacion(meetingCode, 'alumno@test.com');
    assert.equal(status, 200);
    assert.equal(body.aiSummaryAvailable, false);
    assert.equal(body.unavailableReason, 'insufficient_content');
    assert.equal(llamadas, 0);
  } finally {
    await limpiarReunion(meetingCode);
  }
});

test('GET /recovery-summary resume SOLO lo dicho en los últimos minutos (también para el docente)', async () => {
  const meetingCode = nuevoMeetingCode('ventana');
  await registrarRol(meetingCode, 'docente@test.com', 'teacher');
  process.env.RECOVERY_SUMMARY_ENABLED = 'true';
  documentAnalysisService.getAnalysisSummary = async () => ({ mainTopics: ['Células'], keyConcepts: [] });
  let recibido;
  openAIRecoverySummaryProvider.summarize = async (args) => {
    recibido = args;
    return { bullets: ['La membrana regula lo que entra a la célula.'] };
  };
  try {
    await sembrarSegmento(meetingCode, 'Esto se dijo hace diez minutos, fuera de la ventana.', -600);
    await sembrarSegmento(meetingCode, 'La membrana celular regula el paso de sustancias hacia adentro.', -30);

    const { status, body } = await pedirRecuperacion(meetingCode, 'docente@test.com');
    assert.equal(status, 200);
    assert.equal(body.aiSummaryAvailable, true);
    assert.deepEqual(body.bullets, ['La membrana regula lo que entra a la célula.']);
    assert.ok(body.generatedAt);
    assert.deepEqual(recibido.mainTopics, ['Células']);
    assert.equal(recibido.transcriptSegments.length, 1, 'solo el segmento dentro de la ventana de 3 minutos');
    assert.match(recibido.transcriptSegments[0].text, /membrana/);
  } finally {
    await limpiarReunion(meetingCode);
  }
});

test('GET /recovery-summary: bullets vacíos = insufficient_content; un fallo de la IA = 502', async () => {
  const meetingCode = nuevoMeetingCode('ia-vacia');
  await registrarRol(meetingCode, 'alumno@test.com', 'student');
  process.env.RECOVERY_SUMMARY_ENABLED = 'true';
  documentAnalysisService.getAnalysisSummary = async () => ({ mainTopics: [], keyConcepts: [{ term: 'ADN', definition: 'Ácido.' }] });
  try {
    openAIRecoverySummaryProvider.summarize = async () => ({ bullets: [] });
    const vacio = await pedirRecuperacion(meetingCode, 'alumno@test.com');
    assert.equal(vacio.status, 200);
    assert.equal(vacio.body.aiSummaryAvailable, false);
    assert.equal(vacio.body.unavailableReason, 'insufficient_content');
    assert.ok(vacio.body.generatedAt);

    openAIRecoverySummaryProvider.summarize = async () => { throw new Error('No se pudo generar el resumen con IA.'); };
    const falla = await pedirRecuperacion(meetingCode, 'alumno@test.com');
    assert.equal(falla.status, 502);
    assert.match(falla.body.error, /No se pudo generar el resumen/);
  } finally {
    await limpiarReunion(meetingCode);
  }
});

test('transcriptRepository.getSegmentsSince devuelve los segmentos posteriores al corte, en orden', async () => {
  const meetingCode = nuevoMeetingCode('repo');
  await registrarRol(meetingCode, 'alumno@test.com', 'student');
  try {
    await sembrarSegmento(meetingCode, 'segundo', -10);
    await sembrarSegmento(meetingCode, 'primero', -40);
    await sembrarSegmento(meetingCode, 'viejo', -900);
    const segmentos = await transcriptRepository.getSegmentsSince(meetingCode, new Date(Date.now() - 60 * 1000));
    assert.deepEqual(segmentos.map((s) => s.text), ['primero', 'segundo']);
  } finally {
    await limpiarReunion(meetingCode);
  }
});
