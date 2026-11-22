const pool = require('../db');
const userRepository = require('../repositories/userRepository');
const meetingRepository = require('../repositories/meetingRepository');
const participationRepository = require('../repositories/participationRepository');
const { retryOnConnectionError } = require('../utils/retryOnDeadlock');

// Reglas de negocio de "quién puede ser profesor/alumno de esta reunión" —
// el mismo criterio, sin importar si lo dispara una ruta REST o un mensaje
// WS (ver `ws/handlers.js`, que llama a estas mismas funciones en vez de
// reimplementarlas).

// Etapa 61 — chequeo PERMANENTE contra la base: una vez que un email queda
// registrado como profesor de una reunión, NINGÚN OTRO email puede
// convertirse en profesor de esa misma reunión — sin importar si el
// profesor original sigue conectado ahora mismo, ni cuánto tiempo pasó. La
// fuente de verdad es `participations` (persistente), no el estado en
// memoria de las salas WS (que se vacía en cada reinicio del backend y no
// distingue "desconectado ahora" de "nunca existió") — ese chequeo en
// memoria sigue existiendo, pero vive en `ws/handlers.js` (cubre la ventana
// de carrera más chica, dos "join" casi simultáneos) como primera barrera,
// antes de llegar acá.
//
// Nota de concurrencia: es un SELECT antes de un INSERT/UPDATE, no una
// operación atómica de base — dos personas registrándose como profesor de
// la MISMA reunión nueva en la ventana de milisegundos entre el SELECT de
// cada una podrían, en teoría, colarse las dos. Se acepta ese riesgo
// residual (extremadamente improbable) en vez de sumar una migración de
// esquema (constraint único parcial) para un caso al límite.
async function otherTeacherExists(meetingCode, email) {
  const normalizedEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
  if (!normalizedEmail) return false;
  return participationRepository.teacherWithDifferentEmailExists(meetingCode, normalizedEmail);
}

// Si esta persona termina rechazada como profesor (por cualquiera de los
// dos chequeos, en memoria o permanente), cualquier fila `participations`
// con `role='teacher'` que le hubiera quedado mal asignada para ESTA
// reunión se limpia acá — un rechazo es la señal correcta de "esta persona
// NO es profesor de esta reunión" (vuelve a `null`, no se "degrada" a
// alumno: elegir alumno es una decisión aparte). Best-effort: un fallo acá
// solo se loguea, nunca interrumpe el flujo de rechazo que la disparó.
async function clearTeacherRoleIfApplicable(meetingCode, email) {
  if (!email) return;
  await participationRepository
    .deleteTeacherParticipation(meetingCode, email)
    .catch((err) => console.error('[Sparkle][WS] Error limpiando un rol "profesor" mal persistido:', err.message));
}

// Nombre del alumno para esta reunión — se carga desde la base al unirse
// por WS, nunca se confía en lo que mande el propio cliente en el mensaje
// de "join" (ver `ws/handlers.js`).
async function getStudentName(meetingCode, email) {
  if (!email) return null;
  return participationRepository.getStudentName(meetingCode, email);
}

// Crea (o reutiliza) el usuario y la reunión, y hace upsert del rol de ese
// usuario en esa reunión puntual — el rol no es global por cuenta (Etapa
// 17), vive por combinación reunión+usuario.
//
// Etapa 60 — orden de operaciones: se chequea PRIMERO si hay conflicto, y
// solo si no lo hay, recién ahí se persiste. Si hay conflicto, no se
// escribe nada — la persona queda sin rol para esta reunión (el mismo
// `null` que ya se contempla para "nunca participó acá"), no con un rol
// falso.
//
// `retryOnConnectionError` (root cause del bug "el rol de docente no queda
// registrado la primera vez que se abre la app tras varios días") — sin
// esto, una conexión pooled zombie (ver el comentario de `enableKeepAlive`
// en `db.js`) hacía fallar esta transacción una sola vez, en silencio (el
// llamador de `ConfirmTeacher.jsx` la trata como best-effort): el rol nunca
// quedaba persistido, aunque la persona ya viera el panel de docente en esa
// misma sesión. Cada intento pide una conexión NUEVA del pool
// (`pool.getConnection()` corre de nuevo en cada llamada a `execute`), así
// que un reintento simple alcanza sin tocar ningún estado a medio hacer (la
// transacción fallida ya hizo su propio rollback/release antes de
// reintentar).
async function registerRole({ meetingCode, email, role }) {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedMeetingCode = meetingCode.trim().toLowerCase();

  if (role === 'teacher' && (await otherTeacherExists(normalizedMeetingCode, normalizedEmail))) {
    console.warn(
      `\x1b[33m[Sparkle]\x1b[0m Registro de rol="profesor" rechazado para ${normalizedEmail} en ` +
        `"${normalizedMeetingCode}": ya hay un profesor permanente distinto registrado — no se persiste ningún rol.`
    );
    throw Object.assign(new Error('Ya hay otro profesor registrado para esta reunión.'), { status: 409 });
  }

  await retryOnConnectionError(async () => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const userId = await userRepository.upsertUser(connection, normalizedEmail);
      const meetingId = await meetingRepository.upsertMeeting(connection, normalizedMeetingCode);
      await participationRepository.upsertRole(connection, meetingId, userId, role);

      await connection.commit();

      console.log(
        `\x1b[36m[Sparkle]\x1b[0m Rol registrado: ${normalizedEmail} es ${role} en la reunión ${normalizedMeetingCode}`
      );
    } catch (err) {
      await connection.rollback().catch(() => {
        // La conexión puede ya estar muerta (el mismo error de conexión que
        // disparó este catch) — un fallo acá no debe tapar el error
        // original, que es el que decide si corresponde reintentar.
      });
      console.error('[Sparkle] Error registrando rol de reunión:', err.message);
      throw err;
    } finally {
      connection.release();
    }
  });

  return { meetingCode: normalizedMeetingCode, email: normalizedEmail, role };
}

async function getRole(meetingCode, email) {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedMeetingCode = meetingCode.trim().toLowerCase();

  const row = await participationRepository.getRoleAndName(normalizedMeetingCode, normalizedEmail);
  const role = row ? row.role : null;
  // Solo tiene sentido para "student" (las filas de "teacher" siempre
  // tienen `name = NULL`) — se devuelve igual sin condicional: si `role`
  // es "teacher" o null, `name` ya sale null de la fila (o no hay fila).
  const name = row ? row.name : null;

  console.log(
    `\x1b[36m[Sparkle]\x1b[0m Consulta de rol para ${normalizedEmail} en reunión ${normalizedMeetingCode} → resultado: ${role}`
  );

  return { role, name };
}

// Registra el rol "student" y el nombre EN LA MISMA operación atómica: a
// diferencia de "teacher" (que se registra apenas se elige, vía
// `registerRole`), un alumno NO tiene ningún rol asignado para esta reunión
// hasta que confirma un nombre válido y único — no existe, en ningún
// momento, una fila de `participations` con `role='student'` y `name` en
// NULL.
function normalizeName(rawName) {
  if (typeof rawName !== 'string') return null;
  // Colapsa espacios internos de más (tabs, múltiples espacios) a uno solo,
  // y recorta los de los extremos — así "  Juan   Pérez  " y "Juan Pérez"
  // se guardan igual, sin que un espacio de más cuente como una diferencia
  // real de nombre.
  const collapsedSpaces = rawName.trim().replace(/\s+/g, ' ');
  return collapsedSpaces || null;
}

async function registerStudent({ meetingCode, email, name }) {
  const normalizedNameForDisplay = normalizeName(name);
  if (!normalizedNameForDisplay) {
    throw Object.assign(new Error('El nombre no puede estar vacío.'), { status: 400 });
  }
  if (normalizedNameForDisplay.length > 100) {
    throw Object.assign(new Error('El nombre no puede superar los 100 caracteres.'), { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  // Solo para COMPARAR unicidad — sin distinguir mayúsculas/minúsculas. El
  // valor que se guarda para MOSTRAR conserva la capitalización tal cual la
  // tipeó el alumno.
  const nameForComparison = normalizedNameForDisplay.toLowerCase();

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const userId = await userRepository.upsertUser(connection, normalizedEmail);
    const meetingId = await meetingRepository.upsertMeeting(connection, normalizedMeetingCode);

    // Chequeo previo, con mensaje claro — el índice único de la base
    // (`uq_participations_meeting_name`) es la garantía final contra una
    // carrera real, pero sin este SELECT antes el único error que tendría
    // el cliente sería un fallo genérico de base de datos.
    const conflict = await participationRepository.nameInUseExists(
      connection,
      meetingId,
      nameForComparison,
      userId
    );

    if (conflict) {
      console.warn(
        `\x1b[33m[Sparkle]\x1b[0m Registro de alumno rechazado para ${normalizedEmail} en "${normalizedMeetingCode}": ` +
          `el nombre "${normalizedNameForDisplay}" ya está en uso en esta reunión.`
      );
      throw Object.assign(new Error('Ese nombre ya está en uso en esta clase.'), { status: 409 });
    }

    await participationRepository.upsertStudent(
      connection,
      meetingId,
      userId,
      normalizedNameForDisplay,
      nameForComparison
    );

    await connection.commit();

    console.log(
      `\x1b[36m[Sparkle]\x1b[0m Alumno registrado: ${normalizedEmail} → "${normalizedNameForDisplay}" en la reunión ${normalizedMeetingCode}`
    );

    return {
      meetingCode: normalizedMeetingCode,
      email: normalizedEmail,
      role: 'student',
      name: normalizedNameForDisplay,
    };
  } catch (err) {
    await connection.rollback();
    // Red de contención para la carrera real (dos INSERT/UPDATE casi
    // simultáneos con el mismo nombre, ninguno vio el conflicto del otro en
    // su propio SELECT): el índice único de la base la rechaza igual, solo
    // que como una excepción en vez de la rama de arriba.
    if (err.code === 'ER_DUP_ENTRY') {
      console.warn(
        `\x1b[33m[Sparkle]\x1b[0m Registro de alumno rechazado por carrera (índice único) para ${normalizedEmail} en "${normalizedMeetingCode}".`
      );
      throw Object.assign(new Error('Ese nombre ya está en uso en esta clase.'), { status: 409 });
    }
    if (err.status) throw err; // el conflicto de nombre detectado arriba, ya tiene su mensaje/status listos
    console.error('[Sparkle] Error registrando alumno:', err.message);
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = {
  otherTeacherExists,
  clearTeacherRoleIfApplicable,
  getStudentName,
  registerRole,
  getRole,
  registerStudent,
};
