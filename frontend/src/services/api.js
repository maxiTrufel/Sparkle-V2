// La direccion del backend NO es una constante de este modulo: sale de
// `config.js`, que combina el valor horneado en tiempo de build
// (`VITE_BACKEND_URL`) con el que pueda haber guardado la pagina de opciones
// en `chrome.storage`. Ver ese archivo para el detalle de por que hay dos
// niveles.
//
// Por eso aca se lee con `await base()` y no con una constante: `chrome.storage`
// es asincrono, y en el top-level de este modulo todavia no se resolvio.
// Todas las funciones de este archivo ya eran `async`, asi que el cambio no
// altera ninguna firma.
import { cabecerasDeApi, configuracionLista, getBackendUrl } from '../config.js';

// Memoizada del lado de `config.js`: la primera llamada espera a
// `chrome.storage`, las siguientes resuelven en un microtask.
async function base() {
  await configuracionLista;
  return getBackendUrl();
}


// Todo request contra el backend pasa por aca, y no por `fetch` pelado, por
// una sola razon: la clave compartida (§7 del plan de despliegue) tiene que
// ir en TODOS. Con 18 llamadas en este archivo, agregar el header a mano en
// cada una es una que alguien se va a olvidar, y el sintoma seria un 401 en
// una pantalla suelta.
//
// Solo agrega el header: no toca `Content-Type`, asi que las subidas con
// `FormData` siguen dejando que el navegador ponga su propio boundary.
//
// `fetch(fileData.dataUrl)` de `uploadDocument` NO pasa por aca a proposito:
// es una `data:` URL local, no el backend.
async function fetchApi(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...cabecerasDeApi(), ...(init.headers || {}) },
  });
}

// Lee el cuerpo de una respuesta del backend como JSON. Etapa 84: con
// `response.json()` pelado, una respuesta SIN cuerpo (por ejemplo, el 502
// que devuelve Caddy mientras el backend se reinicia) explotaba con
// "Unexpected end of JSON input", un mensaje que no dice qué pasó. Se vio en
// la consola, en el polling de "¿ya hay un docente?". Acá el error dice qué
// status llegó y si vino vacío o no era JSON. Quien llama sigue recibiendo
// una excepción, igual que antes: solo cambia el mensaje.
export async function leerJson(response) {
  const texto = await response.text();
  if (!texto) {
    throw new Error(`El servidor respondió sin contenido (HTTP ${response.status}).`);
  }
  try {
    return JSON.parse(texto);
  } catch {
    throw new Error(`El servidor respondió algo que no es JSON (HTTP ${response.status}).`);
  }
}


// Etapa de traducción (Paso 3/4) — el contrato de red (rutas, campos del
// body/query, campos de la respuesta) ya está en inglés, traducido de forma
// atómica junto con el backend (ver DOCUMENTACION.md, Etapa 4).

// role: "profesor" | "alumno". El rol es específico por reunión, no global
// por cuenta (Etapa 17): crea el usuario/la reunión si hace falta, y hace
// upsert del rol para esa combinación puntual.
export async function registerMeetingRole(meetingCode, email, role) {
  const response = await fetchApi(`${await base()}/api/meetings/register-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, role }),
  });
  return leerJson(response);
}

// role devuelto: "profesor" | "alumno" | null (nunca participó en esta
// reunión puntual — puede tener otro rol en otra reunión distinta).
// `name` (Etapa 68) solo viene completo cuando `role === "alumno"` — las
// filas de "profesor" nunca tienen nombre (ver DOCUMENTACION.md).
export async function getMeetingRole(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const response = await fetchApi(`${await base()}/api/meetings/role?${params.toString()}`);
  return leerJson(response);
}

// Etapa 68, Cambio 1 — registra el rol "alumno" y el nombre EN LA MISMA
// operación: a diferencia de "profesor" (`registerMeetingRole`, se registra
// apenas se elige el rol), acá no hay ningún rol asignado para esta reunión
// hasta que este endpoint responde 200. Puede devolver 409 si el nombre ya
// está en uso en esta reunión puntual — `response.json()` siempre se
// devuelve igual (con `.error` en ese caso), es quien llama el que mira el
// status para decidir qué mostrar (ver `StudentName.jsx`).
export async function registerStudent(meetingCode, email, name) {
  const response = await fetchApi(`${await base()}/api/meetings/register-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, name }),
  });
  const body = await leerJson(response);
  return { status: response.status, body };
}

// Etapa 68, Cambio 3 — historial completo de sesiones de conexión de esta
// reunión, agrupado por alumno (ver `backend/src/routes/meetings.js`,
// `/history`).
export async function getHistory(meetingCode) {
  const params = new URLSearchParams({ meetingCode });
  const response = await fetchApi(`${await base()}/api/meetings/history?${params.toString()}`);
  return leerJson(response);
}

// Etapa 71 — reemplaza a `liberarRolDocente` (Etapa 69, Cambio 3; el rol de
// docente ahora es definitivo al confirmar, así que ya no hace falta
// liberarlo — ver DOCUMENTACION.md). Devuelve `{ hasTeacher: boolean }`:
// `true` si ya hay un docente permanente registrado con un email DISTINTO
// al que se consulta. Se usa en dos momentos (`App.jsx`): al montar, para
// que `Welcome.jsx` no muestre "Soy Docente" si ya no tiene sentido (Capa
// 1); y al clickear "Soy Docente", como chequeo fresco justo antes de
// decidir si mostrar el diálogo de confirmación (Capa 2, defensiva contra
// una carrera — alguien más pudo haberse registrado como docente entre el
// montaje y el click).
export async function getHasTeacher(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const response = await fetchApi(`${await base()}/api/meetings/has-teacher?${params.toString()}`);
  return leerJson(response);
}

// Preferencia del toggle de la prueba de preview de cámara (Etapa 63, ver
// `hooks/useCameraPreference.js`): herramienta de PRUEBA, pensada para
// eliminarse por completo antes de las funcionalidades reales de IA — ver
// DOCUMENTACION.md.
export async function getCameraEnabled(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const response = await fetchApi(`${await base()}/api/meetings/camera?${params.toString()}`);
  return leerJson(response);
}

export async function updateCameraEnabled(meetingCode, email, enabled) {
  const response = await fetchApi(`${await base()}/api/meetings/camera`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, enabled }),
  });
  return leerJson(response);
}

// Preguntas en tiempo real — vista previa SIN persistir, generada por el
// proveedor activo del backend (`RandomQuestionProvider` u
// `OpenAIQuestionProvider`, ver `backend/src/services/
// questionService.generatePreview`). `GenerateQuestion.jsx` la pide al
// montar y de nuevo cada vez que el docente aprieta "Generar otra
// pregunta"; el envío real (persistencia + broadcast) ocurre por
// WebSocket, no acá (ver `sendQuestion` más abajo).
//
// `meetingCode`/`email` viajan ahora (antes este endpoint era agnóstico de
// la reunión) — el backend los necesita para validar que quien pide sea
// el docente de esa reunión y, con el resumen con IA activo, para armar
// el contexto (temas del documento, transcripción) sin exponerlo a
// cualquiera que adivine un `meetingCode`.
//
// `discardedPrompts` (opcional) — los enunciados de los previews que
// `GenerateQuestion.jsx` ya generó y descartó en la tanda actual (sin
// enviar ninguno todavía), para que el proveedor de IA no repita tema —
// ver `backend/src/services/questionService.generatePreview`. POST (no
// GET, ver `backend/src/routes/meetings.js`): un array de texto
// arbitrario no encaja bien en query string.
export async function generateQuestion(meetingCode, email, discardedPrompts = []) {
  const response = await fetchApi(`${await base()}/api/meetings/generate-question`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingCode, email, discardedPrompts }),
  });
  return leerJson(response);
}

// Historial de preguntas FINALIZADAS de la reunión — "Preguntas
// realizadas" del panel del docente (ver
// `backend/src/services/questionService.getFinishedQuestionsForMeeting`).
// El backend valida que `email` sea de verdad el docente de esta reunión
// (403 si no) — acá no hace falta duplicar ese chequeo, solo propagar la
// respuesta tal cual (incluido el `.error` si lo hubiera).
export async function getQuestionsHistory(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const response = await fetchApi(`${await base()}/api/meetings/questions/history?${params.toString()}`);
  return leerJson(response);
}

// Historial PERSONAL de respuestas — "Preguntas respondidas" del panel del
// alumno (ver `backend/src/services/questionService.
// getAnsweredQuestionsForStudent`). Nunca incluye preguntas todavía
// activas (la opción correcta no se revela hasta que finalizan).
export async function getMyQuestionAnswers(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const response = await fetchApi(`${await base()}/api/meetings/questions/my-answers?${params.toString()}`);
  return leerJson(response);
}

// Estadísticas agregadas POR ALUMNO ("X/Y respuestas correctas" en la tab
// "Alumnos" del docente, ver `backend/src/services/questionService.
// getStudentStatsForMeeting`). Nunca trae qué opción eligió cada alumno,
// solo los contadores agregados.
export async function getStudentStats(meetingCode, email) {
  const params = new URLSearchParams({ meetingCode, email });
  const response = await fetchApi(`${await base()}/api/meetings/questions/student-stats?${params.toString()}`);
  return leerJson(response);
}

// Carga de documentos (PDF) desde el panel del docente. `fileData` llega
// como `{ name, type, size, dataUrl }` (no un `File` directo, ni tampoco
// un `ArrayBuffer`): el content script no puede hacer este fetch (Private
// Network Access, ver el comentario de `services/backendMessaging.js`),
// así que el archivo viaja hasta acá como mensaje de `chrome.runtime` —
// y ESE CANAL SERIALIZA CON JSON, no con structured clone (a diferencia
// de `window.postMessage` entre ventanas). Un `ArrayBuffer`/`Blob` no
// sobrevive un `JSON.stringify` (queda en `{}`, vacío) — así se manifestó
// originalmente este bug: el archivo llegaba al backend como un `Blob` de
// 15 bytes con el contenido literal `"[object Object]"` (el resultado de
// stringificar ese `{}` vacío). `dataUrl` es un string (base64) — SÍ
// sobrevive el JSON intacto —, generado del lado de React con
// `FileReader.readAsDataURL` (ver `hooks/useDocumentUpload.js`). Recién
// acá, ya en el service worker, se reconstruye como `Blob` con
// `fetch(dataUrl).blob()` (decodifica el base64 nativo, sin código a
// mano). Sin header `Content-Type` a mano: `fetch` arma el boundary de
// `multipart/form-data` solo a partir del `FormData`. Mismo patrón que
// `registerStudent` — devuelve `{ status, body }` (no solo el body) para
// que quien llama distinga 201 (cargado) de un 400/403/413 con mensaje
// claro.
// Documento vigente de una reunión (o `null` si todavía no se cargó
// ninguno) — lo pide `hooks/useDocumentUpload.js` al montar el panel del
// docente, para recuperar el estado sin depender de la sesión de React
// (ni el panel ni la extensión sobreviven un F5/recarga). Mismo patrón
// simple que `getQuestionsHistory`/`getStudentStats` (sin envolver en
// `{status, body}`): quien llama distingue error de éxito mirando
// `.error` en el body, nunca el status HTTP.
export async function getCurrentDocument(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const response = await fetchApi(`${await base()}/api/meetings/${encodeURIComponent(meetingCode)}/documents?${params.toString()}`);
  return leerJson(response);
}

// Resumen de la clase (alumno) — "Obtener resumen de la clase" en
// `ClassSummary.jsx` (ver `backend/src/services/classSummaryService.js`).
// Solo disponible con la clase ya finalizada — el backend devuelve un
// `.error` con status 409 mientras siga en curso, 503 si
// `ENABLE_AI_CLASS_SUMMARY` está apagado, o 502 si falló la llamada a
// OpenAI (ver ese mismo archivo); en los tres casos `response.json()` trae
// igual el body con `.error`, quien llama decide qué mostrar mirando el
// status.
export async function getClassSummary(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const response = await fetchApi(`${await base()}/api/meetings/${encodeURIComponent(meetingCode)}/summary?${params.toString()}`);
  const body = await leerJson(response);
  return { status: response.status, body };
}

// "Recuperar contenido" (alumno) — botón de la alerta de fatiga
// (`ui/FatigueAlert.jsx`/`screens/RecoverySummary.jsx`), ver
// `backend/src/services/recoverySummaryService.js`. A diferencia de
// `getClassSummary` de arriba, no exige que la clase haya terminado — el
// backend devuelve 200 con `aiSummaryAvailable: false` (nunca un error)
// tanto si la IA está apagada como si no hubo contenido real en la
// ventana reciente; 502 solo si falló la llamada a OpenAI en sí.
export async function getRecoverySummary(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const response = await fetchApi(
    `${await base()}/api/meetings/${encodeURIComponent(meetingCode)}/recovery-summary?${params.toString()}`
  );
  const body = await leerJson(response);
  return { status: response.status, body };
}

// "Quiz final" (alumno, clase detenida) — `screens/FinalQuiz.jsx`, ver
// `backend/src/services/finalQuizService.js`. Mismo patrón `{status, body}`:
// 200 con `quizAvailable` true/false (IA apagada o sin contenido no son
// errores), 502 solo si falló la llamada a OpenAI.
export async function getFinalQuiz(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const response = await fetchApi(
    `${await base()}/api/meetings/${encodeURIComponent(meetingCode)}/final-quiz?${params.toString()}`
  );
  const body = await leerJson(response);
  return { status: response.status, body };
}

// Historial de atención grupal (docente) — `screens/ConcentrationStats.jsx`,
// base histórica de la línea temporal/mapa de calor/"momento de mayor
// desatención", ver `backend/src/services/attentionSnapshotService.js`.
export async function getAttentionSnapshots(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const response = await fetchApi(
    `${await base()}/api/meetings/${encodeURIComponent(meetingCode)}/attention-snapshots?${params.toString()}`
  );
  const body = await leerJson(response);
  return { status: response.status, body };
}

// Análisis con IA del reporte PDF de fin de clase (docente) — ver
// `backend/src/services/classReportService.js`. Mismo patrón `{status,
// body}` que `getAttentionSnapshots`/`getRecoverySummary`: con
// `ENABLE_AI_CLASS_REPORT` apagado, el backend devuelve 200 con
// `aiAnalysisAvailable: false` (nunca un error) — 502 solo si falló la
// llamada a OpenAI en sí.
export async function getClassReportAnalysis(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const response = await fetchApi(
    `${await base()}/api/meetings/${encodeURIComponent(meetingCode)}/report/ai-analysis?${params.toString()}`
  );
  const body = await leerJson(response);
  return { status: response.status, body };
}

// Temas abordados según el documento cargado por el docente (reporte PDF
// de fin de clase, sección "Resumen de la clase") — ver
// `backend/src/services/classReportService.getDocumentTopics`. Mismo
// patrón `{status, body}` que `getClassReportAnalysis`.
export async function getReportDocumentTopics(meetingCode, email) {
  const params = new URLSearchParams({ email });
  const response = await fetchApi(
    `${await base()}/api/meetings/${encodeURIComponent(meetingCode)}/report/document-topics?${params.toString()}`
  );
  const body = await leerJson(response);
  return { status: response.status, body };
}

export async function uploadDocument(meetingCode, email, fileData) {
  const blob = await (await fetch(fileData.dataUrl)).blob();

  // Chequeo defensivo — el bug original (el archivo llegando al backend
  // como 15 bytes de `"[object Object]"`) era invisible del lado del
  // frontend: el `Blob` se armaba "bien" a partir de un valor ya
  // corrompido, sin tirar ningún error acá. La decodificación de un data
  // URL es SIN PÉRDIDA (base64 es reversible byte a byte) — si el `Blob`
  // resultante no mide EXACTAMENTE lo mismo que `selectedFile.size` (leído
  // directo del `File` original, ver `hooks/useDocumentUpload.js`), algo
  // se corrompió en el camino (acá o en el mensaje de `chrome.runtime`) y
  // no tiene sentido seguir mandando ese archivo al backend.
  if (blob.size === 0) {
    throw new Error(`El archivo "${fileData.name}" se leyó vacío (0 bytes) — no se va a subir.`);
  }
  if (blob.size !== fileData.size) {
    throw new Error(
      `El archivo "${fileData.name}" no se pudo preparar para la carga: se esperaban ${fileData.size} bytes ` +
        `y se generaron ${blob.size}.`
    );
  }

  const formData = new FormData();
  formData.append('email', email);
  formData.append('file', blob, fileData.name);

  const response = await fetchApi(`${await base()}/api/meetings/${encodeURIComponent(meetingCode)}/documents`, {
    method: 'POST',
    body: formData,
  });
  const body = await leerJson(response);
  return { status: response.status, body };
}
