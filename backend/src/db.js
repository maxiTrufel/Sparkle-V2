const mysql = require('mysql2/promise');

// Sin valores hardcodeados: todo sale de .env (ver .env.example y
// backend/README.md). Los defaults acá abajo son solo para que el pool no
// explote si falta alguna variable puntual — no son credenciales reales.
const {
  DB_HOST = 'localhost',
  DB_PORT = '3306',
  DB_USER = 'root',
  DB_PASSWORD = '',
  DB_NAME = 'sparkle_v2',
} = process.env;

// Pool (no una única conexión): Express puede recibir requests concurrentes
// y cada uno necesita su propia conexión mientras dure la query. La tabla
// se crea aparte, vía `npm run init-db` (ver scripts/init-db.js) — este
// módulo solo abre el pool, no gestiona el esquema (ver DOCUMENTACION.md,
// Etapa 16).
// `enableKeepAlive`/`keepAliveInitialDelay`: mismo problema que el
// heartbeat de `ws/index.js` (Etapa 54), pero del lado de la conexión a
// MySQL — una conexión pooled que queda inactiva varios días (el backend
// sin uso) puede caer en un estado "zombie": el sistema operativo o un
// firewall/NAT intermedio la descarta en silencio (o el propio MySQL la
// cierra por `wait_timeout`) sin que el pool se entere, y sigue
// reportándose disponible. Sin este keepalive, la primera query que
// reutiliza esa conexión puede quedarse colgada indefinidamente (sin error
// ni timeout) en vez de fallar rápido — el TCP keepalive nativo la detecta
// y la corta, para que el pool abra una conexión nueva en su lugar.
const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

module.exports = pool;
