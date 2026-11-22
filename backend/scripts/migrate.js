// Runner de migraciones (`npm run migrate`) — §6 del plan de despliegue.
//
// QUÉ PROBLEMA RESUELVE
// ---------------------
// `init-db.js` dropea las 10 tablas y las recrea. Es correcto en desarrollo,
// donde la base es descartable, y es irreversible en producción. Con algo
// hosteado, el primer `ALTER TABLE` obliga a elegir entre no desplegarlo o
// borrar los datos de todo el mundo. Este script es la salida: aplica los
// cambios de esquema uno por uno y lleva registro de cuáles ya aplicó.
//
// CÓMO FUNCIONA
// -------------
// Crea `schema_migrations (version, aplicada_en)`, lee `migrations/*.sql`
// ordenados por nombre, y aplica los que no estén registrados. Es
// IDEMPOTENTE: correrlo dos veces seguidas no hace nada la segunda. Eso es lo
// que permite que el deploy lo corra siempre, sin preguntarse antes si hace
// falta.
//
// FORWARD-ONLY, SIN `down`
// ------------------------
// No hay reversión. Revertir un deploy revierte el CÓDIGO, no el esquema —
// por eso las migraciones tienen que ser compatibles hacia atrás. El detalle
// está en migrations/README.md, que es lo que hay que leer antes de escribir
// una.
//
// SIN DEPENDENCIAS NUEVAS
// -----------------------
// No se usó knex/umzug/db-migrate a propósito: son ~40 paquetes más para 60
// líneas de lógica, en un proyecto que instala 111 en total y que va a correr
// esto unas pocas decenas de veces.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const {
  DB_HOST = 'localhost',
  DB_PORT = '3306',
  DB_USER = 'root',
  DB_PASSWORD = '',
  DB_NAME = 'sparkle_v2',
} = process.env;

const DIRECTORIO = path.join(__dirname, '..', 'migrations');

// Los archivos se aplican en orden alfabético, que con el prefijo numérico de
// tres dígitos es el orden cronológico. Con 001..999 alcanza de sobra; si
// algún día no alcanzara, el arreglo es agregar un dígito, no cambiar el
// criterio de orden.
function listarMigraciones() {
  if (!fs.existsSync(DIRECTORIO)) return [];
  return fs
    .readdirSync(DIRECTORIO)
    .filter((nombre) => nombre.endsWith('.sql'))
    .sort();
}

async function asegurarTablaDeRegistro(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      aplicada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function versionesAplicadas(connection) {
  const [filas] = await connection.query('SELECT version FROM schema_migrations');
  return new Set(filas.map((f) => f.version));
}

// `migrar()` se exporta para que `init-db.js` la reuse después de dropear las
// tablas: así el DDL vive en UN solo lugar (migrations/001_...) y los dos
// caminos no se pueden desincronizar.
// Plural sin quedar diciendo "1 migraciones" ni "migración(es)".
function plural(n, singular, plural_) {
  return `${n} ${n === 1 ? singular : plural_}`;
}

async function migrar({ silencioso = false } = {}) {
  const log = silencioso ? () => {} : (...args) => console.log(...args);

  // Conexión sin `database`: en el primer deploy la base todavía no existe.
  //
  // `multipleStatements` es lo que permite mandar un archivo .sql entero de
  // una en vez de partirlo por `;` con una expresión regular. Un splitter
  // casero se rompe con el primer `;` que aparezca adentro de un string o de
  // un cuerpo de trigger, y ese es exactamente el tipo de bug que uno
  // descubre en producción a las 2 de la mañana. La contrapartida —que
  // habilita inyección de SQL si se concatenan datos del usuario— acá no
  // aplica: lo único que se manda por esta conexión son archivos versionados
  // del propio repo.
  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE \`${DB_NAME}\``);
    await asegurarTablaDeRegistro(connection);

    const aplicadas = await versionesAplicadas(connection);
    const todas = listarMigraciones();
    const pendientes = todas.filter((nombre) => !aplicadas.has(nombre));

    if (pendientes.length === 0) {
      log(`[migrate] Nada que hacer: ${plural(todas.length, 'migración ya está aplicada', 'migraciones ya están aplicadas')}.`);
      return { aplicadas: [], yaEstaban: todas.length };
    }

    log(`[migrate] ${plural(pendientes.length, 'migración pendiente', 'migraciones pendientes')} sobre "${DB_NAME}".`);

    for (const nombre of pendientes) {
      const sql = fs.readFileSync(path.join(DIRECTORIO, nombre), 'utf8');
      process.stdout.write(`[migrate] Aplicando ${nombre}... `);
      try {
        await connection.query(sql);
      } catch (err) {
        // MariaDB NO tiene DDL transaccional: si el archivo traía tres
        // sentencias y falló la segunda, la primera YA quedó aplicada y no se
        // deshace sola. Se corta acá en vez de seguir con las siguientes
        // migraciones, y el mensaje dice explícitamente que hay que mirar la
        // base a mano — porque hay que mirarla.
        process.stdout.write('FALLÓ\n');
        throw new Error(
          `La migración "${nombre}" falló: ${err.message}\n\n` +
            '  MariaDB no revierte DDL. Si el archivo tenía más de una sentencia, las\n' +
            '  anteriores a la que falló YA se aplicaron y la base quedó a mitad de camino.\n' +
            `  Revisá el estado real ("SHOW CREATE TABLE ..." sobre ${DB_NAME}), arreglalo a\n` +
            '  mano, y recién ahí volvé a correr migrate. La migración NO quedó registrada\n' +
            '  como aplicada, así que se va a reintentar entera.'
        );
      }
      // El registro va DESPUÉS de que la migración corra entera y sin error:
      // si el proceso se muere en el medio, la migración queda sin registrar y
      // se reintenta en la próxima corrida.
      await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [nombre]);
      process.stdout.write('ok\n');
    }

    log(`[migrate] Listo. ${plural(pendientes.length, 'migración aplicada', 'migraciones aplicadas')}.`);
    return { aplicadas: pendientes, yaEstaban: todas.length - pendientes.length };
  } finally {
    await connection.end();
  }
}

module.exports = { migrar, listarMigraciones };

// Solo corre si se lo invoca directo (`npm run migrate`), no cuando
// `init-db.js` lo requiere como módulo.
if (require.main === module) {
  migrar().catch((err) => {
    console.error(`\n[migrate] ${err.message}`);
    process.exitCode = 1;
  });
}
