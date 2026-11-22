// Cómo se decide, ante un 409 de Vexa, si el bot que ya existe está vivo o
// es una sesión fantasma.
//
// EL BUG QUE ESTO CUBRE
// ---------------------
// `startBot` daba el 409 por fantasma cuando el último arranque exitoso
// tenía más de dos minutos, y entonces sacaba el bot y pedía uno nuevo. Con
// ese criterio, CUALQUIER reconexión del docente pasados dos minutos —una
// pestaña congelada, un F5, un microcorte— echaba de la reunión a un bot
// que estaba transcribiendo bien. El bot nuevo además tiene que volver a
// ser admitido en Meet, así que el costo real no era reiniciar el bot: era
// quedarse sin transcripción.
//
// Visto en producción en "kge-hipa-pgx" (6/9/2026): bot activo 02:41:14,
// el docente reconecta 02:43:08, el bot se va 02:43:09. El alumno nunca se
// desconectó, así que no era el camino de "sala vacía".
//
// El criterio nuevo mira el LATIDO (`updated_at`) de la sesión en Vexa, que
// se mueve mientras el bot corre y se congela cuando muere.
process.env.VEXA_API_URL = 'http://vexa.invalido';
process.env.VEXA_BOT_API_KEY = 'clave-de-prueba';
process.env.VEXA_TX_API_KEY = 'clave-de-prueba';

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/db');
const vexaService = require('../src/services/vexaService');

// Doble de `fetch`: registra cada llamada y responde según el guion que le
// pase cada test. Se instala una sola vez y se reconfigura por caso.
let guion;
const llamadas = [];
global.fetch = async (url, opciones = {}) => {
  const metodo = opciones.method || 'GET';
  llamadas.push(`${metodo} ${url}`);
  return guion(metodo, String(url));
};

function respuesta(status, cuerpo) {
  return { ok: status >= 200 && status < 300, status, json: async () => cuerpo };
}

function sesion(meetingCode, status, edadDelLatidoMs) {
  return {
    native_meeting_id: meetingCode,
    status,
    updated_at: new Date(Date.now() - edadDelLatidoMs).toISOString(),
  };
}

// `transcription_sessions.meeting_code` tiene FK contra `meetings`, así que
// la reunión tiene que existir antes de que `startBot` registre su intento.
async function crearReunion(meetingCode) {
  await pool.query(
    'INSERT INTO meetings (meeting_code) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [meetingCode]
  );
}

async function limpiarSesiones(meetingCode) {
  await pool.query('DELETE FROM meetings WHERE meeting_code = ?', [meetingCode]);
}

test.after(async () => {
  await pool.end();
});

test('Un 409 con la sesión LATIENDO no toca el bot: es un 409 legítimo', async () => {
  const meetingCode = 'test-fantasma-vivo';
  await crearReunion(meetingCode);
  llamadas.length = 0;
  guion = (metodo, url) => {
    if (metodo === 'POST') return respuesta(409, { detail: 'ya existe' });
    if (metodo === 'GET' && url.endsWith('/bots')) {
      return respuesta(200, { meetings: [sesion(meetingCode, 'active', 10_000)] });
    }
    throw new Error(`llamada inesperada: ${metodo} ${url}`);
  };

  const resultado = await vexaService.startBot(meetingCode);

  assert.equal(resultado, null, 'debería cortar sin pedir un bot nuevo');
  assert.equal(
    llamadas.some((l) => l.startsWith('DELETE')),
    false,
    'sacó de la reunión a un bot que estaba latiendo'
  );
  await limpiarSesiones(meetingCode);
});

test('Un 409 con el latido CONGELADO sí se trata como sesión fantasma', async () => {
  // La contracara: mirar el latido no puede volverse "nunca limpiar nada".
  // Un bot que Vexa cree activo pero que murió tiene que poder reemplazarse,
  // o la reunión se queda sin transcripción para siempre.
  const meetingCode = 'test-fantasma-muerto';
  await crearReunion(meetingCode);
  llamadas.length = 0;
  let primerPost = true;
  guion = (metodo, url) => {
    if (metodo === 'POST') {
      if (primerPost) {
        primerPost = false;
        return respuesta(409, { detail: 'ya existe' });
      }
      return respuesta(200, { id: 123 });
    }
    if (metodo === 'DELETE') return respuesta(200, {});
    if (metodo === 'GET' && url.endsWith('/bots')) {
      // Vexa la sigue reportando activa, pero hace diez minutos que no da
      // señales de vida.
      return respuesta(200, { meetings: [sesion(meetingCode, 'active', 10 * 60_000)] });
    }
    throw new Error(`llamada inesperada: ${metodo} ${url}`);
  };

  const resultado = await vexaService.startBot(meetingCode);

  assert.equal(resultado.id, 123, 'debería haber conseguido un bot nuevo');
  assert.ok(
    llamadas.some((l) => l.startsWith('DELETE')),
    'no cerró la sesión fantasma'
  );
  await limpiarSesiones(meetingCode);
});

test('Si no se puede consultar a Vexa, ante la duda NO se mata el bot', async () => {
  // Plan B. Que la consulta falle no puede convertirse en el bug de antes:
  // matar un bot sano rompe la clase en curso, mientras que dejar viva una
  // sesión fantasma solo demora la transcripción hasta el próximo intento.
  const meetingCode = 'test-fantasma-sin-respuesta';
  await crearReunion(meetingCode);
  llamadas.length = 0;

  // Primero un arranque exitoso, que es lo que deja registrado el reloj
  // propio del que depende el plan B.
  guion = (metodo) => (metodo === 'POST' ? respuesta(200, { id: 1 }) : respuesta(200, {}));
  await vexaService.startBot(meetingCode);

  llamadas.length = 0;
  guion = (metodo, url) => {
    if (metodo === 'POST') return respuesta(409, { detail: 'ya existe' });
    if (metodo === 'GET' && url.endsWith('/bots')) throw new Error('Vexa no responde');
    throw new Error(`llamada inesperada: ${metodo} ${url}`);
  };

  const resultado = await vexaService.startBot(meetingCode);

  assert.equal(resultado, null, 'debería cortar sin tocar el bot');
  assert.equal(
    llamadas.some((l) => l.startsWith('DELETE')),
    false,
    'mató el bot pese a no tener forma de saber si estaba vivo'
  );
  await limpiarSesiones(meetingCode);
});
