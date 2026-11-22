// { quiet: true } evita que dotenv imprima sus "tips" promocionales
// (incluyen anuncios de productos de terceros) en cada arranque.
require('dotenv').config({ quiet: true });

const http = require('http');
const express = require('express');
const cors = require('cors');

const pool = require('./db'); // pool de conexiones a MySQL/MariaDB (Etapa 16)
const meetingsRouter = require('./routes/meetings'); // rol por reunión (Etapa 17)
const { startWebSocketServer } = require('./ws'); // clase en tiempo real (Etapa 44)
const { crearMiddlewareApiKey } = require('./middleware/apiKey'); // clave compartida (§7 del plan de despliegue)

// Desde la Etapa 8, quien llama al backend es el service worker de la
// extensión, no el content script — así que el origen que llega en el
// header `Origin` ya no es "https://meet.google.com", sino
// "chrome-extension://<id-de-la-extension>". Ese ID lo asigna Chrome al
// cargar la extensión (para "Cargar descomprimida" depende de la máquina/
// carpeta), así que no se puede hardcodear en el código sin romper cada vez
// que se recargue en otro entorno (ej. otra máquina para pruebas de tesis).
// Se lee desde la variable de entorno ALLOWED_EXTENSION_IDS en vez de eso
// (ver .env.example) — admite una lista separada por comas por si hay que
// probar desde más de una instalación al mismo tiempo.
const EXTENSION_IDS = (process.env.ALLOWED_EXTENSION_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (EXTENSION_IDS.length === 0) {
  console.warn(
    '[CORS] ALLOWED_EXTENSION_IDS no está configurado en .env: las llamadas ' +
      'del service worker de la extensión van a ser rechazadas. Copiá el ID ' +
      'de la extensión desde chrome://extensions y agregalo a .env.'
  );
}

// Se mantiene igual que antes: los requests sin header Origin (curl,
// Postman, server-to-server) no pasan por el chequeo de CORS del navegador
// y se dejan pasar igual.
const ALLOWED_ORIGINS = [
  'https://meet.google.com',
  ...EXTENSION_IDS.map((id) => `chrome-extension://${id}`),
];

const app = express();

// Private Network Access (PNA): Chrome bloquea fetches desde un origen
// público HTTPS (https://meet.google.com) hacia una dirección privada/
// loopback (localhost) salvo que el servidor lo autorice explícitamente en
// la respuesta del preflight. El navegador manda
// "Access-Control-Request-Private-Network: true" en el OPTIONS cuando
// detecta ese caso; hay que contestar con
// "Access-Control-Allow-Private-Network: true" para que deje pasar el
// request real. El paquete `cors` (v2.8.6) no soporta este header todavía,
// así que se agrega a mano, antes del middleware de cors, para que el
// header quede seteado cuando cors responda el preflight.
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origen no permitido por CORS: ${origin}`));
    },
  })
);
app.use(express.json());

// Clave compartida, DESPUÉS de cors (para que el preflight se conteste
// igual y el navegador vea un 401 con headers de CORS en vez de un error
// opaco) y ANTES de cualquier ruta. Ver src/middleware/apiKey.js para qué
// frena y qué no.
const SPARKLE_API_KEY = process.env.SPARKLE_API_KEY || '';
app.use(crearMiddlewareApiKey(SPARKLE_API_KEY));

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Sparkle V2 backend' });
});

app.use('/api/meetings', meetingsRouter);

// Se crea un http.Server explícito (en vez de dejar que app.listen() lo
// haga implícitamente) porque el servidor WebSocket necesita "engancharse"
// al mismo servidor HTTP para escuchar en el mismo puerto (upgrade de la
// conexión HTTP a WebSocket en el path /ws) — ver backend/src/ws/index.js
// y DOCUMENTACION.md, Etapa 44.
const server = http.createServer(app);
startWebSocketServer(server, ALLOWED_ORIGINS, { apiKey: SPARKLE_API_KEY });

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`Sparkle V2 backend escuchando en http://localhost:${PORT}`);

  // Chequeo de conexión al arrancar: no bloquea el server (ya está
  // escuchando), pero avisa temprano si MySQL no está corriendo o si
  // todavía no se corrió "npm run init-db" — en vez de que el primer
  // request que llegue falle con un error de MySQL menos claro.
  try {
    await pool.query('SELECT 1 FROM users LIMIT 1');
    console.log('[Sparkle] Conexión a MySQL OK — tabla "users" encontrada.');
  } catch (err) {
    console.warn(
      `[Sparkle] No se pudo verificar la tabla "users" (${err.code || err.message}). ` +
        'Si es la primera vez que corrés el backend, revisá que MySQL esté ' +
        'corriendo y ejecutá "npm run init-db" para crear la base y las tablas.'
    );
  }
});

module.exports = app;
