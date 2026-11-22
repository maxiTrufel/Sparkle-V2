// Reset del esquema para DESARROLLO (`npm run init-db`): dropea todas las
// tablas y las vuelve a crear desde cero.
//
// SU RELACIÓN CON `migrate.js`, QUE ES LA PARTE IMPORTANTE
// --------------------------------------------------------
// Hasta el paso B.1 del plan de despliegue, este script tenía el DDL de las
// 10 tablas escrito adentro. Ahora el DDL vive en `migrations/001_esquema_inicial.sql`
// y este script lo consume: dropea, y después llama al mismo runner que corre
// el deploy. Un solo lugar donde está definido el esquema, imposible que los
// dos caminos se desincronicen.
//
// Reparto de responsabilidades:
//
//   npm run init-db   → DESARROLLO. Destructivo. Base limpia desde cero.
//   npm run migrate   → PRODUCCIÓN. Incremental. Nunca borra nada.
//
// Producción no vuelve a ver este script nunca (salvo la creación del
// esquema en el despliegue inicial, y ni siquiera eso hace falta: `migrate`
// sobre una base vacía deja exactamente el mismo resultado).
require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const { migrar } = require('./migrate');

const {
  DB_HOST = 'localhost',
  DB_PORT = '3306',
  DB_USER = 'root',
  DB_PASSWORD = '',
  DB_NAME = 'sparkle_v2',
} = process.env;

// Orden hijo → padre: MySQL rechaza el DROP de una tabla todavía
// referenciada por la FK de otra. Es el inverso exacto del orden de creación
// de la migración 001.
//
// `schema_migrations` también se dropea: si quedara, el runner creería que
// ya aplicó todo y no recrearía ninguna tabla — el reset dejaría la base
// vacía y en silencio.
const TABLAS_EN_ORDEN_DE_DROP = [
  'question_answers',
  'questions',
  'connection_sessions',
  'files',
  'transcript_segments',
  'transcription_sessions',
  'attention_snapshots',
  'participations',
  'meetings',
  'users',
  'schema_migrations',
];

// El script es destructivo por diseño: dropea las 10 tablas antes de
// recrearlas. Eso es inofensivo en desarrollo, donde la base es descartable,
// y es irreversible en producción, donde borraría las clases, las
// transcripciones, las preguntas y el historial de atención de todos.
//
// El guard no protege contra un accidente exótico: protege contra correr por
// costumbre el mismo comando que uno viene corriendo hace meses, pero con el
// `.env` de producción cargado.
//
// `--force` existe para la única corrida legítima contra producción: la
// creación del esquema en el despliegue inicial. Desde que existe `migrate`
// ni siquiera eso hace falta — `migrate` sobre una base vacía deja el mismo
// esquema sin poner en riesgo nada. La bandera queda por si acaso, pero no
// debería usarse nunca.
function assertNotProduction() {
  if (process.env.NODE_ENV !== 'production') return;

  if (process.argv.includes('--force')) {
    console.warn(
      '[Sparkle] ATENCIÓN: corriendo init-db contra PRODUCCIÓN con --force.\n' +
        `[Sparkle] Se van a DROPEAR las tablas de "${DB_NAME}" en ${DB_HOST}:${DB_PORT}.\n` +
        '[Sparkle] Si lo que querías era aplicar cambios de esquema SIN perder datos,\n' +
        '[Sparkle] cortá ahora y corré "npm run migrate".'
    );
    return;
  }

  throw new Error(
    'init-db aborta: NODE_ENV=production y este script DROPEA las 10 tablas.\n' +
      `  Base apuntada: "${DB_NAME}" en ${DB_HOST}:${DB_PORT}\n` +
      '  Para aplicar cambios de esquema sin perder datos: npm run migrate\n' +
      '  Si de verdad querés recrear el esquema desde cero (y perder todos los\n' +
      '  datos), corré: npm run init-db -- --force'
  );
}

async function initDb() {
  assertNotProduction();

  // Conexión sin `database` todavía: la base puede no existir aún.
  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE \`${DB_NAME}\``);
    console.log(`[Sparkle] Base de datos "${DB_NAME}" lista.`);

    for (const tabla of TABLAS_EN_ORDEN_DE_DROP) {
      await connection.query(`DROP TABLE IF EXISTS \`${tabla}\``);
    }
    console.log('[Sparkle] Esquema anterior limpiado.');
  } finally {
    await connection.end();
  }

  // El esquema lo crea el runner, desde migrations/*.sql — ver el
  // encabezado de este archivo.
  await migrar();
  console.log('[Sparkle] Inicialización completa.');
}

initDb().catch((err) => {
  console.error('[Sparkle] Error inicializando la base de datos:', err.message);
  process.exitCode = 1;
});
