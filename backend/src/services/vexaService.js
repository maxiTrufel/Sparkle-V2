const pool = require('../db');

const { VEXA_API_URL, VEXA_BOT_API_KEY, VEXA_TX_API_KEY } = process.env;

// Se avisa al ARRANQUE si falta alguna, no cuando alguien use la función
// (mismo criterio que ALLOWED_EXTENSION_IDS en server.js). Sin esto, un
// .env incompleto no rompe nada visible hasta que un docente aprieta
// "iniciar transcripción" en medio de una clase: recién ahí el fetch sale
// contra "undefined/bots" y falla con un error que no menciona la causa.
// Es el tipo de desfase que aparece al desplegar, donde el .env se escribe
// a mano en el servidor y es fácil olvidarse una línea.
const VEXA_REQUIRED_VARS = {
  VEXA_API_URL,
  VEXA_BOT_API_KEY,
  VEXA_TX_API_KEY,
};

const missingVexaVars = Object.entries(VEXA_REQUIRED_VARS)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missingVexaVars.length > 0) {
  console.warn(
    `[Vexa] Faltan variables en .env: ${missingVexaVars.join(', ')}. ` +
      'La transcripción de Google Meet va a fallar al iniciarse (el bot no ' +
      'se une a la reunión). Ver .env.example.'
  );
}

function normalizeTimestamp(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  date.setUTCHours(date.getUTCHours() - 3);
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${ms}`;
}

// Integración con Vexa (bot de transcripción de Google Meet, self-hosted) —
// arranca/para el bot y persiste la transcripción que va devolviendo. Cero
// reglas de negocio de Sparkle acá, solo el llamado a la API de Vexa + su
// persistencia asociada (mismo criterio que los demás `services/*.js`).

// Momento del último `startBot` EXITOSO por reunión. Hoy es solo el PLAN B
// de `sesionVivaEnVexa` (ver abajo), para cuando no se puede consultar a
// Vexa.
//
// ⚠️ Era el criterio principal, y estaba mal. La versión anterior daba el
// 409 por fantasma si el último arranque exitoso tenía más de dos minutos,
// y eso mataba **bots sanos**: cualquier reconexión del docente pasados
// esos dos minutos —una pestaña que Chrome congela, un F5, un microcorte—
// entraba por acá, sacaba de la reunión a un bot que estaba transcribiendo
// perfecto y pedía uno nuevo, que encima tiene que ser admitido de nuevo en
// Meet. Visto en la reunión "kge-hipa-pgx" (6/9/2026): bot activo a las
// 02:41:14, el docente reconecta a las 02:43:08, y el bot se va a las
// 02:43:09 sin que nadie lo pidiera. El alumno seguía conectado todo el
// tiempo, así que no tenía nada que ver con la sala vacía.
const lastSuccessfulStartAt = new Map();

// Ventana del plan B: sin poder consultar a Vexa, un 409 dentro de estos
// dos minutos se asume legítimo.
const GHOST_SESSION_THRESHOLD_MS = 2 * 60 * 1000;

// Estados de Vexa en los que una sesión todavía cuenta como "hay un bot
// para esta reunión". `stopping` queda afuera a propósito: es un bot que ya
// se está yendo.
const ESTADOS_VIVOS = new Set(['requested', 'joining', 'awaiting_admission', 'active']);

// Cuánto puede atrasarse el `updated_at` de una sesión antes de darla por
// muerta. Un bot vivo lo mueve cada pocos segundos (medido: 14-30 s entre
// latidos), así que dos minutos es holgado.
const LATIDO_MAXIMO_MS = 2 * 60 * 1000;

// ¿Vexa tiene AHORA un bot vivo para esta reunión?
//
// El comentario que estaba acá antes decía que preguntarle a Vexa no servía
// "porque es la misma fuente que causó el 409". Eso es cierto del campo
// `status` —un bot echado del Meet que Vexa no detectó sigue figurando
// `active`— pero NO de `updated_at`, que es un latido: el bot lo mueve
// mientras corre y se congela cuando muere. Mirar el latido es preguntar
// por señales de vida, no por una opinión.
//
// Devuelve `null` —"no sé"— si no se pudo consultar. Ante la duda el
// llamador NO mata nada: matar un bot sano rompe la clase en curso,
// mientras que dejar viva una sesión fantasma solo demora la transcripción
// hasta el próximo intento.
async function sesionVivaEnVexa(meetingCode) {
  try {
    const response = await fetch(`${VEXA_API_URL}/bots`, {
      headers: { 'X-API-Key': VEXA_BOT_API_KEY },
    });
    if (!response.ok) return null;

    const data = await response.json();
    const sesiones = (data?.meetings ?? []).filter(
      (m) => m.native_meeting_id === meetingCode && ESTADOS_VIVOS.has(m.status)
    );
    if (sesiones.length === 0) return false;

    // La más recientemente actualizada: si hay varias, alcanza con que UNA
    // esté viva para que el 409 sea legítimo.
    const latido = Math.max(...sesiones.map((m) => new Date(m.updated_at).getTime() || 0));
    return Date.now() - latido < LATIDO_MAXIMO_MS;
  } catch {
    return null;
  }
}

// Espera entre reintentos tras cerrar una sesión fantasma — un `DELETE` a
// Vexa no libera la reunión al instante: la deja en `status: "stopping"` y
// solo la reconcilia a un estado terminal en un barrido con ~45s de gracia.
// Esta progresión (total ~54s) cubre esa ventana con margen.
const GHOST_RETRY_DELAYS_MS = [3000, 6000, 10000, 15000, 20000];

// Un solo intento de pedirle a Vexa que un bot se una a la reunión —
// usado por `startBot` tanto en el pedido inicial como en el reintento
// tras un 409.
async function requestBot(meetingCode) {
  const response = await fetch(`${VEXA_API_URL}/bots`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': VEXA_BOT_API_KEY,
    },
    body: JSON.stringify({
      meeting_url: `https://meet.google.com/${meetingCode}`,
      bot_name: 'Sparkle Bot',
      language: 'es',
    }),
  });

  const data = await response.json().catch(() => null);
  return { response, data };
}

// Pide a Vexa que un bot se una a la reunión. Se registra el intento en
// "transcription_sessions" tanto si Vexa lo acepta ("active") como si
// falla ("failed") — así queda un rastro de cada vez que se intentó
// arrancar la transcripción, no solo de los éxitos.
async function startBot(meetingCode) {
  console.log('[Vexa] startBot LLAMADO para', meetingCode, '— VEXA_API_URL:', process.env.VEXA_API_URL);
  let data = null;
  try {
    let response;
    ({ response, data } = await requestBot(meetingCode));

    if (response.status === 409) {
      // Ya hay una sesión para esta reunión. La única pregunta que importa
      // es si está VIVA: si lo está, el 409 es la respuesta correcta y no
      // hay nada que hacer.
      const viva = await sesionVivaEnVexa(meetingCode);

      const esLegitimo =
        viva === null
          ? // No se pudo consultar a Vexa: plan B, el reloj propio.
            Boolean(
              lastSuccessfulStartAt.get(meetingCode) &&
                Date.now() - lastSuccessfulStartAt.get(meetingCode) < GHOST_SESSION_THRESHOLD_MS
            )
          : viva;

      if (esLegitimo) {
        // El bot ya está en el Meet y sigue latiendo. Tocarlo sería sacar
        // de la reunión a un bot que está funcionando.
        return null;
      }

      // La sesión existe pero no da señales de vida (ej. el bot fue echado
      // del Meet y Vexa no se enteró): se cierra esa sesión y se reintenta
      // con backoff hasta que Vexa termine de liberarla.
      await stopBot(meetingCode).catch(() => {});

      for (const delayMs of GHOST_RETRY_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        ({ response, data } = await requestBot(meetingCode));
        if (response.ok) break;
      }
    }

    if (!response.ok) {
      throw new Error(`Vexa respondió ${response.status} al pedir el bot: ${JSON.stringify(data)}`);
    }

    lastSuccessfulStartAt.set(meetingCode, Date.now());

    const vexaMeetingId = data?.id ?? data?.meeting_id ?? null;
    await pool.query(
      `INSERT INTO transcription_sessions (meeting_code, vexa_meeting_id, status)
       VALUES (?, ?, 'active')`,
      [meetingCode, vexaMeetingId]
    );

    return data;
  } catch (err) {
    await pool.query(
      `INSERT INTO transcription_sessions (meeting_code, vexa_meeting_id, status)
       VALUES (?, ?, 'failed')`,
      [meetingCode, data?.id ?? data?.meeting_id ?? null]
    );
    throw err;
  }
}

// Le pide a Vexa que el bot se retire de la reunión y cierra la sesión de
// transcripción en curso para ese meeting_code.
async function stopBot(meetingCode) {
  const response = await fetch(`${VEXA_API_URL}/bots/google_meet/${meetingCode}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': VEXA_BOT_API_KEY },
  });

  if (!response.ok) {
    throw new Error(`Vexa respondió ${response.status} al detener el bot.`);
  }

  await pool.query(
    `UPDATE transcription_sessions SET status = 'stopped', stopped_at = NOW()
     WHERE meeting_code = ? AND status = 'active'`,
    [meetingCode]
  );
}

// Trae de Vexa los segmentos de transcripción generados hasta ahora para
// esta reunión. Devuelve siempre un array — Vexa puede envolver los
// segmentos en distintas formas según la versión de la API.
async function getTranscript(meetingCode) {
  const response = await fetch(`${VEXA_API_URL}/transcripts/google_meet/${meetingCode}`, {
    headers: { 'X-API-Key': VEXA_TX_API_KEY },
  });

  if (!response.ok) {
    throw new Error(`Vexa respondió ${response.status} al pedir la transcripción.`);
  }

  const data = await response.json();
  if (Array.isArray(data)) return data;
  return data?.segments ?? data?.data?.segments ?? [];
}

// Guarda (o actualiza) cada segmento recibido de Vexa — "segment_id" es la
// clave única que evita duplicar filas cuando el mismo segmento vuelve a
// aparecer en un poll posterior.
async function saveSegments(meetingCode, segments) {
  if (!Array.isArray(segments) || segments.length === 0) return;

  for (const segment of segments) {
    await pool.query(
      `INSERT INTO transcript_segments
         (meeting_code, speaker, text, language, absolute_start_time, absolute_end_time, segment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         speaker = VALUES(speaker),
         text = VALUES(text),
         language = VALUES(language),
         absolute_start_time = VALUES(absolute_start_time),
         absolute_end_time = VALUES(absolute_end_time)`,
      [
        meetingCode,
        segment.speaker ?? null,
        segment.text,
        segment.language ?? null,
        normalizeTimestamp(segment.absolute_start_time),
        normalizeTimestamp(segment.absolute_end_time),
        segment.segment_id ?? segment.id ?? null,
      ]
    );
  }
}

// Todos los segmentos ya persistidos de una reunión, en orden cronológico
// — lo que devuelve el endpoint REST (ver `routes/meetings.js`).
async function listStoredSegments(meetingCode) {
  const [rows] = await pool.query(
    'SELECT * FROM transcript_segments WHERE meeting_code = ? ORDER BY absolute_start_time',
    [meetingCode]
  );
  return rows;
}

// Intervals de polling en curso, uno por reunión — permite pararlos por
// `meetingCode` sin depender de una referencia externa al setInterval.
const pollingIntervals = new Map();

// Arranca el polling de transcripción de una reunión: cada 10s trae los
// segmentos nuevos de Vexa y los persiste, sin ningún filtro — el bot
// inserta todo el tiempo que esté en la reunión, sin importar el estado de
// "clase" de Sparkle. No-op si ya hay un polling corriendo para este
// meetingCode.
function startPolling(meetingCode) {
  if (pollingIntervals.has(meetingCode)) return;

  const intervalId = setInterval(() => {
    getTranscript(meetingCode)
      .then((segments) => saveSegments(meetingCode, segments))
      .catch((err) => console.error('[Vexa] Error en el polling de transcripción:', err.message));
  }, 10000);
  intervalId.unref(); // no debe mantener vivo el proceso si queda un polling sin detener

  pollingIntervals.set(meetingCode, intervalId);
}

// Para el polling de transcripción de una reunión (bot fuera de la
// reunión — sala vacía).
function stopPolling(meetingCode) {
  const intervalId = pollingIntervals.get(meetingCode);
  if (!intervalId) return;
  clearInterval(intervalId);
  pollingIntervals.delete(meetingCode);
}

module.exports = {
  startBot,
  stopBot,
  getTranscript,
  saveSegments,
  listStoredSegments,
  startPolling,
  stopPolling,
};
