const pool = require('../db');

// Acceso a datos de la tabla `users` — sin ninguna regla de negocio acá,
// solo la query en sí. `connection` es siempre la conexión de la
// transacción del service que llama (los dos únicos casos de uso hoy,
// registrar profesor y registrar alumno, necesitan este upsert atómico
// junto con el resto de sus queries — ver `services/roleService.js`).

// Crea (o reutiliza) el usuario por email — el truco `ON DUPLICATE KEY
// UPDATE id = LAST_INSERT_ID(id)` hace que `insertId` devuelva el id
// correcto tanto si la fila se acaba de crear como si ya existía, en una
// sola query.
async function upsertUser(connection, email) {
  const [result] = await connection.query(
    'INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [email]
  );
  return result.insertId;
}

// Solo lectura — a diferencia de `upsertUser`, acá el usuario ya tiene que
// existir (siempre llega por un email que ya pasó por `/register-student`,
// que hace el upsert). Usado por `services/questionService.js` para
// resolver el `user_id` de un alumno que responde/saltea una pregunta.
async function getUserIdByEmail(email) {
  const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  return rows.length > 0 ? rows[0].id : null;
}

module.exports = { upsertUser, getUserIdByEmail };
