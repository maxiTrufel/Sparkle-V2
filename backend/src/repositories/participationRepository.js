const pool = require('../db');

// Acceso a datos de la tabla `participations` — sin ninguna regla de
// negocio acá, solo las queries en sí (la normalización de email/nombre, y
// qué hacer con cada resultado, vive en `services/roleService.js` y
// `services/cameraService.js`).

// Upsert del rol de una persona en una reunión puntual — usado por
// `POST /register-role` (profesor O alumno genérico, sin nombre). El rol
// "student" con nombre tiene su propio upsert, `upsertStudent` más abajo.
async function upsertRole(connection, meetingId, userId, role) {
  await connection.query(
    `INSERT INTO participations (meeting_id, user_id, role)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [meetingId, userId, role]
  );
}

// ¿Ya existe, de forma permanente, un profesor con un email DISTINTO al que
// se pregunta, para esta reunión? Recibe el email ya normalizado — la
// normalización y el chequeo de "sin email no hay conflicto" viven en
// `services/roleService.otherTeacherExists`.
async function teacherWithDifferentEmailExists(meetingCode, normalizedEmail) {
  const [rows] = await pool.query(
    `SELECT 1
     FROM participations p
     JOIN meetings r ON r.id = p.meeting_id
     JOIN users u ON u.id = p.user_id
     WHERE r.meeting_code = ? AND p.role = 'teacher' AND u.email != ?
     LIMIT 1`,
    [meetingCode, normalizedEmail]
  );
  return rows.length > 0;
}

// Borra cualquier fila `participations` con `role='teacher'` que le haya
// quedado mal asignada a esta persona para esta reunión — se usa cuando un
// intento de ser profesor termina rechazado (ver `services/roleService.
// clearTeacherRoleIfApplicable`, que es quien decide CUÁNDO llamar a
// esto y absorbe el error si falla).
async function deleteTeacherParticipation(meetingCode, email) {
  await pool.query(
    `DELETE p FROM participations p
     JOIN meetings r ON r.id = p.meeting_id
     JOIN users u ON u.id = p.user_id
     WHERE r.meeting_code = ? AND u.email = ? AND p.role = 'teacher'`,
    [meetingCode, email]
  );
}

// Rol + nombre de una persona en una reunión (`GET /role`). `name` solo
// tiene valor real cuando `role === 'student'` — las filas de "teacher"
// siempre tienen `name = NULL` (ver `scripts/init-db.js`).
async function getRoleAndName(meetingCode, email) {
  const [rows] = await pool.query(
    `SELECT p.role, p.name
     FROM participations p
     JOIN meetings r ON r.id = p.meeting_id
     JOIN users u ON u.id = p.user_id
     WHERE r.meeting_code = ? AND u.email = ?`,
    [meetingCode, email]
  );
  return rows[0];
}

// Nombre confirmado de un alumno en una reunión — lo usa el WS al unirse,
// para cargarlo en el socket sin confiar en lo que mande el cliente (ver
// `services/roleService.getStudentName`).
async function getStudentName(meetingCode, email) {
  const [rows] = await pool.query(
    `SELECT p.name
     FROM participations p
     JOIN meetings r ON r.id = p.meeting_id
     JOIN users u ON u.id = p.user_id
     WHERE r.meeting_code = ? AND u.email = ? AND p.role = 'student'`,
    [meetingCode, email]
  );
  return rows.length > 0 ? rows[0].name : null;
}

// ¿Ya hay OTRA persona con este mismo nombre normalizado en esta reunión?
// Chequeo previo (con mensaje claro) antes del INSERT/UPDATE real — el
// índice único `uq_participations_meeting_name` es la garantía final
// contra una carrera real, pero sin este SELECT antes el único error que
// vería el cliente sería un fallo genérico de base de datos (ver
// `services/roleService.registerStudent`, que atrapa ese caso límite por
// el código `ER_DUP_ENTRY`). Se excluye la propia fila de `userId`:
// reconfirmar el mismo nombre que ya tenía no debe contar como conflicto
// contra sí mismo.
async function nameInUseExists(connection, meetingId, normalizedName, userId) {
  const [rows] = await connection.query(
    `SELECT 1
     FROM participations
     WHERE meeting_id = ? AND normalized_name = ? AND user_id != ?
     LIMIT 1`,
    [meetingId, normalizedName, userId]
  );
  return rows.length > 0;
}

// Upsert atómico de rol "student" + nombre (nunca hay una fila de alumno sin
// nombre — ver `services/roleService.registerStudent`).
async function upsertStudent(connection, meetingId, userId, name, normalizedName) {
  await connection.query(
    `INSERT INTO participations (meeting_id, user_id, role, name, normalized_name)
     VALUES (?, ?, 'student', ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), name = VALUES(name), normalized_name = VALUES(normalized_name)`,
    [meetingId, userId, name, normalizedName]
  );
}

// Preferencia del toggle de la prueba de preview de cámara (Etapa 63) —
// vive en la misma fila de `participations` que ya vincula usuario+reunión.
// Requiere que esa fila ya exista (se crea en `/register-role`): si no
// existe, `affectedRows` da 0 — el service decide qué responder en ese caso.
async function updateCameraEnabled(meetingCode, email, enabled) {
  const [result] = await pool.query(
    `UPDATE participations p
     JOIN meetings r ON r.id = p.meeting_id
     JOIN users u ON u.id = p.user_id
     SET p.camera_enabled = ?
     WHERE r.meeting_code = ? AND u.email = ?`,
    [enabled, meetingCode, email]
  );
  return result.affectedRows;
}

async function getCameraEnabled(meetingCode, email) {
  const [rows] = await pool.query(
    `SELECT p.camera_enabled AS enabled
     FROM participations p
     JOIN meetings r ON r.id = p.meeting_id
     JOIN users u ON u.id = p.user_id
     WHERE r.meeting_code = ? AND u.email = ?`,
    [meetingCode, email]
  );
  return rows.length > 0 ? Boolean(rows[0].enabled) : false;
}

// Total de alumnos REGISTRADOS de esta reunión (rol "student" en
// `participations`), sin importar si están conectados ahora mismo — es el
// "total de alumnos de la clase" que ve el docente en las estadísticas en
// vivo de una pregunta (ver `services/questionService.countStudents`),
// distinto de `getConnectedStudents()` en `ws/rooms.js` (ese es solo
// quiénes tienen un socket abierto AHORA).
async function countStudentsForMeeting(meetingCode) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM participations p
     JOIN meetings m ON m.id = p.meeting_id
     WHERE m.meeting_code = ? AND p.role = 'student'`,
    [meetingCode]
  );
  return rows[0] ? Number(rows[0].total) : 0;
}

module.exports = {
  upsertRole,
  teacherWithDifferentEmailExists,
  deleteTeacherParticipation,
  getRoleAndName,
  getStudentName,
  nameInUseExists,
  upsertStudent,
  updateCameraEnabled,
  getCameraEnabled,
  countStudentsForMeeting,
};
