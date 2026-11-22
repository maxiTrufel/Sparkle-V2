// La direccion del backend dejo de ser una constante de build.
//
// QUE PROBLEMA RESUELVE EL CAMBIO QUE ESTE TEST PROTEGE
// ----------------------------------------------------
// `VITE_BACKEND_URL` se hornea en el bundle al compilar. Mientras el backend
// no este desplegado y corra en la maquina de alguien del equipo, eso ataba
// cada copia compilada de la extension a UNA direccion: pasarle la carpeta a
// otra persona le daba una extension que apuntaba a la maquina de quien la
// compilo, y no habia forma de cambiarla sin Node, el repo y un build.
//
// Ahora `chrome.storage.local.backendUrl` pisa al valor de build. Un solo
// paquete compilado sirve para localhost, para una IP de Tailscale o para el
// dominio de produccion.
//
// POR QUE HAY UN `?v=` EN CADA IMPORT
// -----------------------------------
// `hidratar()` corre UNA VEZ, al cargar el modulo, y el loader de Node cachea
// los modulos por especificador. Sin el query distinto, el segundo test veria
// el resultado del stub del primero. El query fuerza una instancia nueva.

import test from 'node:test';
import assert from 'node:assert/strict';

// Stub minimo de `chrome.storage.local` sobre un Map. Devuelve tambien lo que
// se escribio, porque `hidratar()` primero hace `set` del valor de build y
// despues `get` del guardado.
function stubChrome(inicial = {}) {
  const datos = new Map(Object.entries(inicial));
  globalThis.chrome = {
    storage: {
      local: {
        async get(claves) {
          const pedidas = Array.isArray(claves) ? claves : [claves];
          const out = {};
          for (const k of pedidas) if (datos.has(k)) out[k] = datos.get(k);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) datos.set(k, v);
        },
        async remove(k) { datos.delete(k); },
      },
      onChanged: { addListener() {} },
    },
  };
  return datos;
}

test('sin nada guardado usa el valor de build', async () => {
  stubChrome();
  const cfg = await import('../src/config.js?caso=default');
  await cfg.configuracionLista;
  // Bajo Node no hay `import.meta.env` (es una inyeccion de Vite), asi que el
  // modulo cae a su propio fallback. Lo que se verifica es que la URL activa
  // sea la de build, sea cual sea.
  assert.equal(cfg.getBackendUrl(), cfg.URL_DE_BUILD);
});

test('lo guardado en storage pisa al valor de build', async () => {
  stubChrome({ backendUrl: 'http://100.115.87.99' });
  const cfg = await import('../src/config.js?caso=pisa');
  await cfg.configuracionLista;
  assert.equal(cfg.getBackendUrl(), 'http://100.115.87.99');
  assert.notEqual(cfg.getBackendUrl(), cfg.URL_DE_BUILD);
});

test('se le saca la barra final, que romperia el handshake del WebSocket', async () => {
  // `wss://host//ws` no matchea el path `/ws` del servidor y el upgrade falla.
  // Es el error que el comentario de `.env` venia advirtiendo a mano.
  stubChrome({ backendUrl: 'https://api.sparkleedu.me///' });
  const cfg = await import('../src/config.js?caso=barra');
  await cfg.configuracionLista;
  assert.equal(cfg.getBackendUrl(), 'https://api.sparkleedu.me');
  assert.equal(cfg.getWsUrl(), 'wss://api.sparkleedu.me/ws');
});

test('el WebSocket se deriva del mismo valor, http->ws y https->wss', async () => {
  stubChrome({ backendUrl: 'http://localhost:3000' });
  const cfg = await import('../src/config.js?caso=ws');
  await cfg.configuracionLista;
  assert.equal(cfg.getWsUrl(), 'ws://localhost:3000/ws');
});

test('un valor vacio o no-string no pisa nada', async () => {
  // Si la pagina de opciones alguna vez guardara "" (o algo que no sea texto),
  // la extension tiene que seguir contra la direccion de build, no contra
  // `/ws` a secas.
  stubChrome({ backendUrl: '   ' });
  const cfg = await import('../src/config.js?caso=vacio');
  await cfg.configuracionLista;
  assert.equal(cfg.getBackendUrl(), cfg.URL_DE_BUILD);
});

test('sin chrome.storage no explota: degrada al valor de build', async () => {
  // Es el caso de los tests que cargan modulos con el loader de Node, y el de
  // cualquier contexto sin el permiso `storage`. Tiene que ser degradacion
  // silenciosa, no una excepcion en el top-level del service worker.
  delete globalThis.chrome;
  const cfg = await import('../src/config.js?caso=sinchrome');
  await assert.doesNotReject(cfg.configuracionLista);
  assert.equal(cfg.getBackendUrl(), cfg.URL_DE_BUILD);
});

test('la pagina de opciones usa las mismas claves que declara config.js', async () => {
  // `public/opciones.js` no pasa por Vite, asi que no puede importar las
  // constantes: las repite a mano. Si alguien renombra una de las dos puntas,
  // la pagina deja de ver la configuracion y no da ningun error.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const aqui = dirname(fileURLToPath(import.meta.url));
  const opciones = readFileSync(join(aqui, '..', 'public', 'opciones.js'), 'utf8');

  delete globalThis.chrome;
  const cfg = await import('../src/config.js?caso=claves');
  for (const clave of [cfg.CLAVE_STORAGE, cfg.CLAVE_URL_DE_BUILD]) {
    assert.match(opciones, new RegExp(`'${clave}'`),
      `public/opciones.js tiene que usar la clave '${clave}' que declara config.js`);
  }
});

test('`connectRoom` sigue siendo sincronica: no se puede esperar la config adentro', async () => {
  // LA TRAMPA QUE ESTE TEST EXISTE PARA IMPEDIR
  // -------------------------------------------
  // Al pasar la direccion del backend a `chrome.storage` (asincrono), lo
  // natural es poner `await configuracionLista` adentro de `connectRoom()` y
  // volverla `async`. Se hizo, y rompio cuatro tests de `wsClient.test.js`:
  // los llamadores dan por hecho que al volver de `connectRoom()` el socket ya
  // existe y leen `room.socket.readyState` en la linea siguiente. Con un await
  // de por medio, `room.socket` todavia es `undefined` -> TypeError.
  //
  // La forma correcta es preguntar por `configuracionHidratada()` y posponer
  // solo mientras no lo este. Este test fija esa decision, porque
  // `wsClient.test.js` la detecta pero no explica por que.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const aqui = dirname(fileURLToPath(import.meta.url));
  const ws = readFileSync(join(aqui, '..', 'src', 'services', 'wsClient.js'), 'utf8');

  assert.match(ws, /^function connectRoom\(/m,
    'connectRoom tiene que ser una funcion sincronica, sin `async`');

  const cuerpo = ws.slice(ws.indexOf('function connectRoom('));
  const hasta = cuerpo.slice(0, cuerpo.indexOf('\n}\n'));
  assert.doesNotMatch(hasta, /^\s*await /m,
    'no puede haber `await` en el cuerpo de connectRoom: retrasa la creacion '
    + 'del socket y los llamadores leen room.socket inmediatamente despues');
  assert.match(hasta, /configuracionHidratada\(\)/,
    'connectRoom tiene que consultar configuracionHidratada() antes de crear el socket');
});
