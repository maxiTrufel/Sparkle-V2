// Tests de la clave compartida (§7 del plan de despliegue, opción B) —
// tanto del middleware HTTP como del chequeo equivalente en el handshake
// del WebSocket.
//
// A diferencia del resto de la suite, estos NO tocan la base de datos: el
// middleware se prueba montado sobre un router de juguete, porque lo que se
// verifica es el control de acceso, no lo que hay del otro lado. Eso los
// hace los únicos tests del backend que corren sin MariaDB levantada.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');

const { crearMiddlewareApiKey } = require('../src/middleware/apiKey');
const { startWebSocketServer } = require('../src/ws');

const CLAVE = 'clave-de-prueba-larga-y-aburrida-0123456789';

// Levanta un Express con el middleware puesto y una ruta protegida, más la
// ruta pública `/`. Devuelve la URL base y una función para bajarlo.
async function levantarApi(clave) {
  const app = express();
  app.use(crearMiddlewareApiKey(clave));
  app.get('/', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/secreto', (_req, res) => res.json({ dato: 'transcripcion' }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    cerrar: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('sin clave configurada la API queda abierta (desarrollo local y tests)', async () => {
  const api = await levantarApi('');
  try {
    const resp = await fetch(`${api.url}/api/secreto`);
    assert.equal(resp.status, 200);
  } finally {
    await api.cerrar();
  }
});

test('con clave configurada, un request sin clave se rechaza con 401', async () => {
  const api = await levantarApi(CLAVE);
  try {
    const resp = await fetch(`${api.url}/api/secreto`);
    assert.equal(resp.status, 401);
    const body = await resp.json();
    assert.match(body.error, /clave/i);
  } finally {
    await api.cerrar();
  }
});

test('el header X-Sparkle-Key correcto deja pasar', async () => {
  const api = await levantarApi(CLAVE);
  try {
    const resp = await fetch(`${api.url}/api/secreto`, {
      headers: { 'X-Sparkle-Key': CLAVE },
    });
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).dato, 'transcripcion');
  } finally {
    await api.cerrar();
  }
});

test('una clave incorrecta de la misma longitud se rechaza', async () => {
  const api = await levantarApi(CLAVE);
  try {
    const casi = `${CLAVE.slice(0, -1)}X`;
    assert.equal(casi.length, CLAVE.length, 'el caso a probar es misma longitud, distinto contenido');
    const resp = await fetch(`${api.url}/api/secreto`, { headers: { 'X-Sparkle-Key': casi } });
    assert.equal(resp.status, 401);
  } finally {
    await api.cerrar();
  }
});

test('la query string ?key= también sirve (es como se autentica el WebSocket)', async () => {
  const api = await levantarApi(CLAVE);
  try {
    const resp = await fetch(`${api.url}/api/secreto?key=${encodeURIComponent(CLAVE)}`);
    assert.equal(resp.status, 200);
  } finally {
    await api.cerrar();
  }
});

test('GET / responde sin clave — es el chequeo de salud del deploy (paso E.5)', async () => {
  const api = await levantarApi(CLAVE);
  try {
    const resp = await fetch(`${api.url}/`);
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).status, 'ok');
  } finally {
    await api.cerrar();
  }
});

test('el preflight OPTIONS pasa sin clave — el navegador no manda headers propios en el preflight', async () => {
  const api = await levantarApi(CLAVE);
  try {
    const resp = await fetch(`${api.url}/api/secreto`, { method: 'OPTIONS' });
    assert.notEqual(resp.status, 401);
  } finally {
    await api.cerrar();
  }
});

// --- WebSocket ---

async function levantarWs(clave) {
  const server = http.createServer();
  const wss = startWebSocketServer(server, [], { apiKey: clave, heartbeatMs: 60_000 });
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    url: `ws://localhost:${server.address().port}/ws`,
    cerrar: async () => {
      if (wss) {
        for (const cliente of wss.clients) cliente.terminate();
        await new Promise((resolve) => wss.close(resolve));
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// `true` si el handshake abrió, `false` si el servidor lo rechazó.
function intentarConectar(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.on('open', () => {
      socket.close();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

test('el WebSocket rechaza el handshake sin clave', async () => {
  const ws = await levantarWs(CLAVE);
  try {
    assert.equal(await intentarConectar(ws.url), false);
  } finally {
    await ws.cerrar();
  }
});

test('el WebSocket acepta el handshake con ?key= correcto', async () => {
  const ws = await levantarWs(CLAVE);
  try {
    assert.equal(await intentarConectar(`${ws.url}?key=${encodeURIComponent(CLAVE)}`), true);
  } finally {
    await ws.cerrar();
  }
});

test('sin clave configurada el WebSocket sigue aceptando a todos', async () => {
  const ws = await levantarWs('');
  try {
    assert.equal(await intentarConectar(ws.url), true);
  } finally {
    await ws.cerrar();
  }
});
