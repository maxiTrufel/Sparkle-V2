// Etapa 84 — `leerJson` (services/api.js) reemplaza al `response.json()`
// pelado en todas las llamadas al backend. Se vio en la consola de Chrome
// real "Unexpected end of JSON input" en el polling de "¿ya hay un
// docente?": una respuesta SIN cuerpo (por ejemplo, el 502 que devuelve
// Caddy mientras el backend se reinicia) hacía explotar `response.json()`
// con un mensaje que no dice qué pasó. Estos tests fijan el mensaje nuevo, y
// que una respuesta válida se siga leyendo igual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leerJson } from '../src/services/api.js';

test('una respuesta vacía da un error que dice el status, no "Unexpected end of JSON input"', async () => {
  await assert.rejects(() => leerJson(new Response('', { status: 502 })), {
    message: 'El servidor respondió sin contenido (HTTP 502).',
  });
});

test('una respuesta que no es JSON (por ejemplo, una página de error) también dice el status', async () => {
  await assert.rejects(() => leerJson(new Response('<html>Bad Gateway</html>', { status: 502 })), {
    message: 'El servidor respondió algo que no es JSON (HTTP 502).',
  });
});

test('una respuesta JSON válida se lee igual que con response.json(), aunque sea un error del backend', async () => {
  assert.deepEqual(await leerJson(new Response('{"hasTeacher":true}', { status: 200 })), { hasTeacher: true });
  assert.deepEqual(await leerJson(new Response('{"error":"Clave de API ausente o incorrecta."}', { status: 401 })), {
    error: 'Clave de API ausente o incorrecta.',
  });
});
