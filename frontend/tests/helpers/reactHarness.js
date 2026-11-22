// Harness compartido para probar componentes React REALES (no mocks a
// mano) contra un DOM real de `jsdom` — mismo patrón que se usó en
// etapas anteriores del proyecto para `App.jsx` (ver DOCUMENTACION.md,
// Etapas 47/48/50/51: "bundleados con esbuild sobre jsdom"), ahora dejado
// como archivo persistente en vez de un script ad-hoc de una sola vez.
//
// Por qué esbuild: Node no interpreta JSX de forma nativa. `esbuild` ya es
// una dependencia (la usa `vite` para el build real de la extensión), así
// que bundlear `App.jsx` con él para un test no suma ninguna herramienta
// nueva al proyecto — solo la reutiliza en otro contexto.
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');

// Namespaced por PID (Etapa 64): `node --test` corre cada ARCHIVO de test
// en su propio subproceso, así que `process.pid` es un identificador único
// por archivo dentro de la misma corrida de `npm test`. Antes, todos los
// archivos de test compartían el mismo `tests/.tmp/` -- inofensivo mientras
// cada uno corría solo, pero al correr la batería completa (varios archivos
// en paralelo, cada uno con su propio `test.after()` haciendo
// `fs.rm(tests/.tmp, {recursive:true})`), un archivo podía borrar el
// directorio entero MIENTRAS otro todavía estaba escribiendo/leyendo su
// propio bundle temporal ahí adentro -- una carrera real, confirmada
// reproduciendo el fallo (`ENOENT`/"Could not resolve" intermitente) varias
// corridas seguidas de la batería completa. Con un subdirectorio propio por
// PID, la limpieza de un archivo nunca puede pisar el bundle en vuelo de
// otro.
const TMP_DIR = path.join(FRONTEND_ROOT, 'tests', `.tmp-${process.pid}`);

// Cobertura (`npm run test:coverage`): c8 corre los tests con
// NODE_V8_COVERAGE seteado. Solo en ese caso el bundle lleva source map, que
// es lo que permite atribuir cada línea ejecutada a su archivo de `src/`.
const MIDIENDO_COBERTURA = Boolean(process.env.NODE_V8_COVERAGE);

// Bundlea un componente (ej. `src/App.jsx`) a un único archivo
// CJS autocontenido (React/ReactDOM incluidos adentro, `bundle: true` —
// nada que resolver por `require` en tiempo de ejecución salvo módulos
// nativos de Node, que este código no usa) — un wrapper chiquito alrededor
// del componente expone `mount(container)`/`unmount()` usando
// `react-dom/client` (`createRoot`), así React/ReactDOM quedan incluidos en
// el MISMO bundle que el componente en vez de tener que resolverlos aparte.
// Se escribe a un archivo temporal real (no se evalúa el string en
// memoria) para poder usar el `require()` normal de Node — más simple y
// más fiel que manipular el `vm` de Node a mano.
export async function bundleAppForTest(entryRelativePath) {
  const entryPath = path.resolve(FRONTEND_ROOT, entryRelativePath);
  const wrapperSrc = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import App from ${JSON.stringify(entryPath)};

    let root = null;
    export function mount(container) {
      root = createRoot(container);
      root.render(React.createElement(App));
    }
    export function unmount() {
      root?.unmount();
      root = null;
    }
  `;
  // Se escribe DENTRO de `frontend/` (no en el tmpdir del SO) a propósito:
  // la resolución de `node_modules` de esbuild para un entry point sube de
  // directorio en directorio desde donde vive el archivo — si el wrapper
  // viviera fuera del proyecto, "react"/"react-dom/client" no se
  // encontrarían nunca sin agregar configuración extra de resolución.
  const tmpDir = TMP_DIR;
  await fs.mkdir(tmpDir, { recursive: true });
  const wrapperPath = path.join(tmpDir, `wrapper-${Date.now()}-${Math.random().toString(36).slice(2)}.jsx`);
  await fs.writeFile(wrapperPath, wrapperSrc);

  const result = await build({
    entryPoints: [wrapperPath],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'react',
    sourcemap: MIDIENDO_COBERTURA ? 'inline' : false,
    outdir: tmpDir, // las rutas del source map se calculan desde acá
    absWorkingDir: FRONTEND_ROOT, // para que 'react'/'react-dom/client' resuelvan contra frontend/node_modules
    define: { 'process.env.NODE_ENV': '"development"' }, // React en sí lee esto; sin definirlo, "process" no existe fuera de Node
  });
  await fs.unlink(wrapperPath);

  const outFile = path.join(tmpDir, `bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  await fs.writeFile(outFile, result.outputFiles[0].text);
  return outFile;
}

// Limpieza de los bundles temporales de ESTE archivo de test (Etapa 64):
// cada archivo debe llamar a esto en su propio `test.after()`, en vez de
// borrar `tests/.tmp` a mano — ver el comentario de `TMP_DIR` más arriba
// sobre por qué el directorio ya no se comparte entre archivos.
export async function cleanupTestBundles() {
  // Midiendo cobertura (`npm run test:coverage`, c8 setea NODE_V8_COVERAGE)
  // los bundles tienen que seguir en disco hasta el reporte: c8 los lee para
  // traducir, con el source map embebido, cada línea al archivo de `src/`
  // original. Los borra el propio script al terminar.
  if (MIDIENDO_COBERTURA) return;
  await fs.rm(TMP_DIR, { recursive: true, force: true });
}

// Arma un `jsdom` real y lo instala en los globals de Node (`window`,
// `document`, `navigator`, `MutationObserver`, etc.) — el código bajo
// prueba (`App.jsx` y todo lo que importa) los usa como variables
// globales del navegador, exactamente como corren dentro de la extensión.
// `html`/`url` arman el DOM de partida (ej. con el botón de "salir de la
// llamada" ya presente, para que `callStage.js` resuelva 'in-call' de
// entrada — ver `Etapa 24/36` en DOCUMENTACION.md).
export function installDom({ url, html = '<!doctype html><html><body></body></html>' }) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });

  global.window = dom.window;
  global.document = dom.window.document;
  // `navigator` en Node moderno (21+) ya es un global propio, de solo
  // lectura (`Cannot set property navigator ... which has only a getter`)
  // — hace falta `defineProperty` para pisarlo, una asignación directa no
  // alcanza.
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.MutationObserver = dom.window.MutationObserver;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = dom.window.requestAnimationFrame
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame
    ? dom.window.cancelAnimationFrame.bind(dom.window)
    : clearTimeout;
  // React (createRoot) usa `alert` solo si el código bajo prueba lo llama
  // (acá: `App.jsx`, para el alumno) — jsdom no lo implementa y tira "Not
  // implemented" por consola si no se pisa.
  dom.window.alert = () => {};
  global.alert = dom.window.alert;

  return dom;
}

// Mock de `chrome.runtime`/`chrome.tabs` — el content script (App.jsx vía
// `backendMessaging.js`) nunca llama al backend directamente, siempre le
// pide el trabajo al background por mensaje (ver DOCUMENTACION.md, Etapa
// 8). Acá se responde cada tipo de mensaje a mano, sin tocar ningún
// background/backend real — es lo mismo que ya hacían los tests
// ad-hoc de etapas anteriores. `handleMessage(type, payload)` lo define
// cada test según qué escenario quiere simular; debe devolver la `data` de
// una respuesta exitosa (un `throw` se traduce a `{ success: false }`).
export function installChromeMock(handleMessage) {
  const listeners = new Set();

  global.chrome = {
    // `ToggleTab.jsx` (siempre montado junto al panel, ver `App.jsx`) usa
    // `chrome.storage.local` para la posición arrastrable del botón (Etapa
    // 12) — sin este mock, el efecto que la lee revienta al montar
    // cualquier escenario, no solo los que de verdad ejercitan esa
    // funcionalidad.
    storage: {
      local: {
        get(_keys, callback) {
          callback({});
        },
        set() {},
        // `hooks/useAttentionHistory.js` (vía `utils/attentionHistoryStorage.js`)
        // la usa para limpiar el historial guardado ante un "class_started"
        // genuino — mismo criterio que `.get`/`.set` de arriba: sin este
        // mock, cualquier escenario que llegue a disparar ese reset revienta
        // al no encontrar la función, no solo los que ejercitan el
        // historial de atención a propósito.
        remove() {},
      },
    },
    runtime: {
      sendMessage(message, callback) {
        Promise.resolve()
          .then(() => handleMessage(message.type, message.payload))
          .then(
            (data) => callback({ success: true, data }),
            (err) => callback({ success: false, error: err.message })
          );
      },
      onMessage: {
        addListener(fn) {
          listeners.add(fn);
        },
        removeListener(fn) {
          listeners.delete(fn);
        },
      },
      lastError: undefined,
    },
  };

  // Simula un mensaje que el background le manda a ESTA pestaña (eventos
  // WS reenviados, o el aviso local de conexión) — invoca a todos los
  // listeners registrados, igual que haría `chrome.runtime.onMessage`.
  function emitFromBackground(message) {
    for (const listener of [...listeners]) listener(message);
  }

  return { emitFromBackground, listeners };
}

// Agrega al DOM las señales mínimas para que, en el primer render:
// - `detectGoogleAccountEmail()` (Estrategia 1, aria-label con "@")
//   encuentre `email` de inmediato, sin reintentos.
// - `detectCallStage()` resuelva 'in-call' de una (botón de salir
//   presente, sin texto de lobby/salida en el body).
export function addActiveCallSignals(document, email) {
  const account = document.createElement('div');
  account.setAttribute('aria-label', `Cuenta de Google: Test (${email})`);
  document.body.appendChild(account);

  const exitButton = document.createElement('button');
  exitButton.setAttribute('aria-label', 'Leave call');
  document.body.appendChild(exitButton);

  // `callStage.js` (Etapa 43) descarta a propósito la primera evaluación
  // si el texto combinado del body tiene menos de 100 caracteres —
  // protección contra evaluar sobre un DOM de Meet todavía casi vacío
  // (ver `MIN_RELIABLE_TEXT`/`INITIAL_WINDOW_MS` ahí) — así que sin esto,
  // CUALQUIER test contra un DOM mínimo como el de acá quedaría pegado en
  // 'undetermined' durante `INITIAL_WINDOW_MS` (1000ms) antes de resolver
  // 'in-call' de verdad, sumando una demora fija e irrelevante para lo que
  // cada test puntual quiere medir. Un bloque de texto visible (`display`
  // normal, no oculto) de sobra supera ese umbral, simulando el contenido
  // real que ya tendría una página de Meet renderizada.
  const filler = document.createElement('div');
  filler.textContent =
    'Contenido de relleno para simular una página de Meet ya renderizada, con ' +
    'suficiente texto visible como para no disparar la ventana de gracia de ' +
    'callStage.js pensada para un DOM recién montado y todavía casi vacío.';
  document.body.appendChild(filler);
}

// Puente "de background real" para tests de integración de punta a punta
// (Fix 2/Fix 3 — investigación de las regresiones reportadas tras probar en
// Chrome real): a diferencia de `installChromeMock`, donde CADA test decide
// a mano qué eventos "SPARKLE_WS_EVENT" simular, acá el `chrome` mock de
// verdad abre una conexión WebSocket NATIVA (Node 22+ trae `WebSocket` como
// global, sin ninguna librería) contra un servidor backend REAL (ver
// `backend/src/ws`, levantado en un puerto efímero por el propio test) y
// reenvía los mensajes que le llegan, tal cual, al `chrome.runtime.onMessage`
// de `App.jsx` — el mismo camino exacto que recorre `services/wsClient.js`
// en producción, solo que sin toda su lógica de reconexión/zombie-detection
// (irrelevante para lo que estos tests puntuales quieren probar: si el
// PROTOCOLO real de ida y vuelta con el servidor real termina reflejado
// correctamente en la UI). Con esto, un test que dispara clicks reales sobre
// botones reales de `TeacherPanel.jsx` efectivamente ejercita: click → comando
// real por WS → servidor real (`backend/src/ws/index.js`, con DB real) →
// evento real de vuelta → listener real de `App.jsx` → render real —
// sin ningún atajo que "simule" un paso intermedio a mano (ese atajo fue
// justamente lo que dejó pasar sin detectar las regresiones reportadas: un
// test anterior emitía `join_rejected` DIRECTAMENTE, sin haber disparado
// nunca un conflicto real de dos conexiones "profesor" contra el servidor).
//
// Etapa de traducción (Paso 3/4) — tanto los `type` de los mensajes
// `chrome.runtime` (`SPARKLE_WS_*`) como el PROTOCOLO WS en sí (`type:
// 'join'`/`'start_class'`/etc., campo `role`) ya usan los nombres nuevos en
// inglés, traducidos de forma atómica junto con el backend real.
export function createRealWsBridge({ wsUrl }) {
  let socket = null;
  let currentMeetingCode = null;
  let emitter = () => {};

  // Mantener 1:1 con `TYPES_TO_FORWARD` en `frontend/src/services/wsClient.js`
  // -- un tipo real que falte acá es invisible para cualquier test que use
  // este bridge (el mensaje llega del servidor pero nunca se reenvía a
  // `App.jsx`), así que un bug que solo se dispara al procesar ESE tipo
  // puntual queda sin cobertura sin que ningún test lo note. Fue
  // exactamente lo que pasó con 'attention_mode_updated': el bridge no lo
  // reenviaba, así que ningún test de integración real llegó a ejercitar
  // el `ReferenceError` de `handleAttentionModeChange` (ver
  // `App.regresionCrashModoAtencion.test.js`) hasta reproducirlo a mano.
  const TYPES_TO_FORWARD = [
    'class_status',
    'class_started',
    'class_ended',
    'class_resumable',
    'class_resumed',
    'class_start_rejected',
    'students_updated',
    'join_rejected',
    'question_state',
    'question_started',
    'question_finished',
    'question_stats_updated',
    'question_send_rejected',
    'answer_accepted',
    'answer_rejected',
    'attention_roster_updated',
    'attention_mode_updated',
  ];

  function openIfNeeded(meetingCode) {
    if (socket && currentMeetingCode === meetingCode && socket.readyState !== WebSocket.CLOSED) return socket;
    socket = new WebSocket(wsUrl);
    currentMeetingCode = meetingCode;
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (TYPES_TO_FORWARD.includes(message.type)) emitter({ type: 'SPARKLE_WS_EVENT', payload: message });
    });
    // Espejo de `notifyConnection()` en `services/wsClient.js`: sin este
    // aviso, `wsConnected` en App.jsx se queda en `false` para siempre (su
    // valor inicial) y los tres botones de `TeacherPanel.jsx` quedan
    // deshabilitados aunque la conexión real esté perfectamente arriba —
    // un `.click()` de test sobre un botón disabled no dispara nada, así
    // que sin esto cualquier test que dependa de clicks reales se queda
    // colgado esperando un cambio de vista que nunca llega (encontrado
    // investigando el Problema 2 reportado: el primer intento de este
    // mismo test fallaba clickeando "Comenzar Clase" sin efecto alguno).
    socket.addEventListener('open', () => emitter({ type: 'SPARKLE_WS_CONNECTION', meetingCode, connected: true }));
    socket.addEventListener('close', () => emitter({ type: 'SPARKLE_WS_CONNECTION', meetingCode, connected: false }));
    return socket;
  }

  function waitOpen(s) {
    if (s.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => s.addEventListener('open', () => resolve(), { once: true }));
  }

  async function handleWsCommand(type, payload) {
    if (type === 'SPARKLE_WS_JOIN_ROOM' || type === 'SPARKLE_WS_KEEP_ALIVE') {
      const s = openIfNeeded(payload.meetingCode);
      await waitOpen(s);
      s.send(JSON.stringify({ type: 'join', meetingCode: payload.meetingCode, role: payload.role, email: payload.email }));
      return { ok: true };
    }
    if (type === 'SPARKLE_WS_LEAVE_ROOM') {
      socket?.close();
      return { ok: true };
    }
    if (type === 'SPARKLE_WS_START_CLASS') {
      await waitOpen(socket);
      socket.send(JSON.stringify({ type: 'start_class', meetingCode: currentMeetingCode }));
      return { ok: true };
    }
    if (type === 'SPARKLE_WS_END_CLASS') {
      await waitOpen(socket);
      socket.send(JSON.stringify({ type: 'end_class', meetingCode: currentMeetingCode }));
      return { ok: true };
    }
    if (type === 'SPARKLE_WS_RESUME_CLASS') {
      await waitOpen(socket);
      socket.send(JSON.stringify({ type: 'resume_class', meetingCode: currentMeetingCode }));
      return { ok: true };
    }
    if (type === 'SPARKLE_WS_SET_ATTENTION_MODE') {
      await waitOpen(socket);
      socket.send(JSON.stringify({ type: 'set_attention_mode', meetingCode: currentMeetingCode, modeId: payload.modeId }));
      return { ok: true };
    }
    return undefined; // no es un comando WS -- quien llama decide qué hacer
  }

  return {
    handleWsCommand,
    setEmitter(fn) {
      emitter = fn;
    },
    close() {
      socket?.close();
    },
  };
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Requisito de producto — el docente no puede "Comenzar Clase" sin un
// documento (PDF/DOCX) asociado a la reunión (ver
// `frontend/src/hooks/useDocumentUpload.js` del lado del cliente,
// `backend/src/ws/handlers.js#handleStartClass` del lado del servidor,
// autoritativo). Sube un documento REAL por REST (multipart), contra el
// backend de prueba levantado por cada archivo de test de integración
// real — requiere que el docente YA esté registrado
// (`role='teacher'` para esa reunión), mismo chequeo de autorización que
// usa el endpoint real (`documentService.saveTeacherDocument`), así que
// tiene que llamarse DESPUÉS de registrar/confirmar ese rol.
//
// Se sube por fetch directo (no simulando el selector de archivos en
// `jsdom`, cuyo soporte de `File`/`DataTransfer`/`Blob.arrayBuffer()` es
// poco confiable) — quien llama decide CUÁNDO hacerlo visible para una
// instancia de `App.jsx` ya montada: `useDocumentUpload` hace polling
// mientras el análisis siga en curso, pero la consulta INICIAL solo corre
// una vez, al montar `TeacherPanel` — si el upload ocurre después de que
// ese panel ya montó, hay que desmontar y volver a montar para que esa
// primera consulta lo encuentre. Ese mismo remount es, a la vez, la forma
// más fiel de ejercitar el requisito "el documento se recupera al volver a
// abrir el panel".
//
// `pool` (opcional) — el docente no puede "Comenzar Clase" hasta que el
// análisis con IA del documento termine en 'processed' (ver
// `backend/src/services/documentAnalysisService.js`,
// `backend/src/ws/handlers.js#handleStartClass`). Estos tests de
// integración NO tienen `OPENAI_API_KEY` configurada — ni deberían
// necesitarla, no son tests DE la integración con OpenAI en sí (esos viven
// en `backend/tests/documentAnalysis.test.js`, con el provider mockeado) —
// así que el análisis real disparado en background por la carga termina en
// 'failed' de inmediato. Si se pasa `pool` (el mismo que ya requiere cada
// archivo de test contra `backend/src/db.js`), se ESPERA a que ese
// análisis real termine (sea 'processed' o 'failed', cualquiera de los dos
// ESTADOS TERMINALES) y recién ahí se fuerza 'processed' por SQL directo —
// forzarlo ANTES de que termine es una carrera real (confirmada): el
// propio análisis en curso puede sobreescribir el forzado un instante
// después, dejando 'failed' de nuevo.
// PDF mínimo pero ESTRUCTURALMENTE VÁLIDO — header, 5 objetos (catálogo,
// páginas, página, fuente, stream de contenido con una línea de texto) y
// xref/trailer con offsets REALES, calculados a partir del contenido en
// vez de hardcodeados a mano (nunca un relleno de bytes basura para
// superar el mínimo de tamaño de `assertValidDocumentContent`) — cada
// entrada del xref necesita 20 bytes exactos (`nnnnnnnnnn ggggg n \n`,
// con el espacio final incluido, spec de PDF), que un editor/formatter
// podría pisar en silencio si viviera como texto literal con espacios de
// más al final de línea; se arma en código para no depender de eso.
// Verificado contra la misma librería que usa el backend para extraer
// texto (`pdf-parse`, ver `backend/src/providers/
// pdfTextExtractionProvider.js`): parsea OK y devuelve "Documento de
// prueba" como texto extraído — a diferencia del fixture viejo
// (`'%PDF-1.4 contenido de prueba'`, 29 bytes), que ni siquiera pasaba el
// chequeo de tamaño mínimo (100 bytes), y aunque lo hubiera pasado, no es
// un PDF real (pdf-parse lo rechaza con "Invalid PDF structure").
function buildMinimalValidPdf(text) {
  const stream = `BT /F1 18 Tf 10 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += xref;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}

const MINIMAL_VALID_PDF = buildMinimalValidPdf('Documento de prueba');

export async function uploadRealDocument(apiUrl, meetingCode, email, { pool } = {}) {
  const blob = new Blob([MINIMAL_VALID_PDF], { type: 'application/pdf' });
  const formData = new FormData();
  formData.append('email', email);
  formData.append('file', blob, 'material-de-prueba.pdf');
  const resp = await fetch(`${apiUrl}/api/meetings/${meetingCode}/documents`, { method: 'POST', body: formData });
  if (resp.status !== 201) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(`No se pudo pre-cargar el documento de prueba (status ${resp.status}): ${JSON.stringify(body)}`);
  }
  const body = await resp.json();

  if (pool) {
    const deadline = Date.now() + 4000;
    let status = 'uploaded';
    while (Date.now() < deadline) {
      const [rows] = await pool.query(
        `SELECT analysis_status FROM files WHERE meeting_id = (SELECT id FROM meetings WHERE meeting_code = ?)`,
        [meetingCode]
      );
      status = rows[0]?.analysis_status;
      if (status === 'processed' || status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await pool.query(
      `UPDATE files SET analysis_status = 'processed', analysis_error = NULL
       WHERE meeting_id = (SELECT id FROM meetings WHERE meeting_code = ?)`,
      [meetingCode]
    );
  }

  return body;
}

// Los runners de GitHub Actions son bastante más lentos que una notebook, y
// este job además levanta MariaDB, Express y el WebSocket reales en el mismo
// proceso. Una espera que acá sobra puede quedar justa allá: el test del
// historial "Sin responder" tarda ~270 ms local y en CI se comió los 3000 ms
// del `timeoutMs` explícito de su llamada, fallando 2 de 3 corridas seguidas.
//
// El factor multiplica CUALQUIER timeout, incluidos los 88 que las llamadas
// pasan a mano — subir solo el default no habría arreglado justamente el caso
// que falla. Local queda idéntico, así que una espera de verdad rota se sigue
// notando enseguida mientras se desarrolla.
//
// Lo que NO cambia: las pocas esperas que se usan para afirmar que algo NO
// aparece van a tardar el tiempo completo en CI. Son 9 y ninguna mira el valor
// de retorno, así que el costo son segundos, no minutos.
const FACTOR_DE_ESPERA = process.env.CI ? 5 : 1;

// Sondea `condition()` hasta que devuelva `true` o venza `timeoutMs` — para
// esperar una actualización de React que depende de microtasks/timers
// reales (el mock de `chrome.runtime.sendMessage` de arriba resuelve por
// `Promise.resolve().then(...)`, no de forma sincrónica) sin acoplarse a
// un número mágico de reintentos.
//
// ⚠️ Devuelve `false` cuando se agota; NO lanza. Un `await waitUntil(...)`
// suelto y sin mirar el resultado deja seguir al test, y el assert que viene
// después falla con un mensaje que habla del contenido y no del timeout — que
// es exactamente lo que hizo perder tiempo depurando este caso. Si te importa
// que la espera se haya cumplido, guardá el resultado y afirmalo.
export async function waitUntil(condition, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs * FACTOR_DE_ESPERA;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await wait(intervalMs);
  }
  return condition();
}

// El modo de clase pasa a ser OBLIGATORIO (pedido explícito, ver
// `ui/AttentionModeSelector.jsx`/`screens/TeacherPanel.jsx`): "Comenzar
// Clase" queda deshabilitado hasta que se elija una opción REAL del
// `<select id="sparkle-mode-select">` (nunca el placeholder, `value=""`,
// deshabilitado a propósito). Cualquier test que quiera llegar a "Comenzar
// Clase" habilitado tiene que pasar por acá primero -- elige la PRIMERA
// opción real (siempre "Por Defecto", el orden de `ATTENTION_MODES` es
// fijo), sin importar cuál sea; a estos tests no les interesa QUÉ modo,
// solo que haya uno elegido.
//
// Simula la interacción de un `<select>` real: asignar `.value` y disparar
// 'change' (a diferencia de un `<input>` de texto, `HTMLSelectElement` no
// necesita el truco del setter nativo de `HTMLInputElement.prototype.value`
// para que React detecte el cambio -- alcanza con el evento).
//
// Async, con espera propia (no un `querySelector` sincrónico): la pantalla
// idle del docente (donde vive el selector) puede tardar un instante en
// aparecer tras un mount/remount -- el rol todavía se está resolviendo por
// REST, o el "join" WS todavía no completó -- así que el `<select>` puede
// no existir todavía en el DOM en el instante exacto en que un test llega
// hasta acá.
export async function chooseAttentionMode(container, { timeoutMs = 4000 } = {}) {
  const found = await waitUntil(() => Boolean(container.querySelector('#sparkle-mode-select')), { timeoutMs });
  if (!found) throw new Error('No se encontró el selector de modo de clase (#sparkle-mode-select) para elegir una opción.');
  const select = container.querySelector('#sparkle-mode-select');
  const firstRealOption = [...select.options].find((option) => option.value);
  if (!firstRealOption) throw new Error('El selector de modo de clase no tiene ninguna opción real (además del placeholder).');
  select.value = firstRealOption.value;
  select.dispatchEvent(new global.window.Event('change', { bubbles: true }));
}
