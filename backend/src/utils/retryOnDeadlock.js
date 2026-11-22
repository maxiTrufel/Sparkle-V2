// Reintento genérico ante un error TRANSITORIO — cada intento vuelve a
// correr `execute()` desde cero (por eso solo sirve para operaciones
// idempotentes o que abren su propia conexión/transacción nueva en cada
// llamada, nunca para reintentar a mitad de una transacción ya empezada).
async function retryOnErrorCodes(execute, retryableCodes, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await execute();
    } catch (err) {
      if (retryableCodes.includes(err.code) && attempt < maxAttempts) continue;
      throw err;
    }
  }
}

// Reintento simple ante un deadlock de InnoDB (Etapa 68): dos UPDATE
// independientes sobre `connection_sessions` (cerrar una sesión puntual y
// cerrar todas las abiertas de una reunión) pueden pisarse si el docente y
// un alumno se desconectan casi al mismo tiempo, y una de las dos termina
// con `ER_LOCK_DEADLOCK` (confirmado en la práctica corriendo la batería de
// tests: "Deadlock found when trying to get lock"). Un deadlock de InnoDB
// es, por definición, una condición transitoria — la propia documentación
// de MySQL recomienda reintentar la transacción — así que un reintento
// simple (sin backoff: la ventana de colisión es de milisegundos) alcanza
// sin necesitar coordinación explícita entre ambas rutas. Utilidad de
// infraestructura genérica, sin ninguna regla de negocio propia — la usa
// `repositories/connectionSessionRepository.js`.
function retryOnDeadlock(execute, maxAttempts = 3) {
  return retryOnErrorCodes(execute, ['ER_LOCK_DEADLOCK'], maxAttempts);
}

// Mismo patrón que `retryOnDeadlock`, pero para errores de CONEXIÓN
// transitorios: una conexión pooled que quedó "zombie" tras varios días sin
// actividad (ver el comentario de `enableKeepAlive` en `db.js`) puede fallar
// con alguno de estos códigos en el primer uso tras la inactividad. Un
// reintento simple alcanza porque `pool.getConnection()` en el siguiente
// intento abre (o reutiliza) una conexión sana — la vieja, rota, ya quedó
// descartada del pool por el propio driver. La usa
// `services/roleService.registerRole` (Etapa: primer ingreso del docente),
// la operación cuyo fallo silencioso dejaba el rol de docente sin persistir.
const CONNECTION_ERROR_CODES = ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];

function retryOnConnectionError(execute, maxAttempts = 3) {
  return retryOnErrorCodes(execute, CONNECTION_ERROR_CODES, maxAttempts);
}

module.exports = { retryOnDeadlock, retryOnConnectionError };
