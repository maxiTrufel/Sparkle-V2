// Estado EN MEMORIA de las salas WS y los helpers puros que operan sobre
// él — nada de esto toca la base de datos. Es la fuente de verdad de
// "quién está conectado ahora mismo" (para hacer broadcast), NUNCA del
// estado real de la clase (esa es la columna `meetings.active`, que vive
// en `services/classService.js`) — si el backend se reinicia, este Map se
// vacía sin problema: cada cliente vuelve a mandar "join" al reconectar, y
// en ese join se vuelve a consultar la base (ver `ws/handlers.js`).
// meetingCode -> Set<WebSocket>
const rooms = new Map();

// Log con timestamp de milisegundos (Etapa 48): agregado específicamente
// para diagnosticar el caso de un F5 en la pestaña del alumno — permite ver
// en la consola del backend, con precisión de milisegundos, exactamente
// cuándo se abre cada conexión física, cuándo llega cada "join", y cuándo
// (o si) se cierra cada una.
function logWS(message) {
  console.log(`[Sparkle][WS][${new Date().toISOString()}] ${message}`);
}

// Identificador corto y legible para un socket en los logs de diagnóstico
// (Etapa 56) — antes del "join" no hay `meetingCode`/`role`/`email` todavía,
// así que se cae a algo igual de útil para correlacionar entre logs.
function describeSocket(socket) {
  return socket.meetingCode
    ? `sala="${socket.meetingCode}" role=${socket.role} email=${socket.email}`
    : '(sin join todavía)';
}

function addToRoom(meetingCode, socket) {
  if (!rooms.has(meetingCode)) rooms.set(meetingCode, new Set());
  rooms.get(meetingCode).add(socket);
}

function removeFromRoom(meetingCode, socket) {
  const room = rooms.get(meetingCode);
  if (!room) return;
  room.delete(socket);
  if (room.size === 0) rooms.delete(meetingCode);
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(meetingCode, message) {
  const room = rooms.get(meetingCode);
  if (!room) return;
  for (const socket of room) send(socket, message);
}

// Lista derivada, no un estado separado a mantener sincronizado a mano
// (Etapa 46): se reconstruye a partir de los sockets que YA están en
// `rooms` en este momento, filtrando por rol y por tener un email asociado
// (se guarda en `handleJoin`, ver `ws/handlers.js`). Cada conexión física =
// un alumno — si el mismo alumno tiene dos pestañas de la MISMA reunión,
// comparten una sola conexión física del lado del background, así que no
// hay riesgo de que aparezca dos veces por eso.
//
// `name` (Etapa 68) sale de `socket.name`, cargado desde la base en
// `handleJoin()` — nunca lo manda el cliente en el mensaje de "join", así
// que no hay forma de falsificarlo desde la consola del navegador.
function getConnectedStudents(meetingCode) {
  const room = rooms.get(meetingCode);
  if (!room) return [];
  const students = [];
  for (const socket of room) {
    if (socket.role === 'student' && socket.email) students.push({ email: socket.email, name: socket.name || null });
  }
  return students;
}

function broadcastStudentList(meetingCode) {
  broadcast(meetingCode, {
    type: 'students_updated',
    meetingCode,
    students: getConnectedStudents(meetingCode),
  });
}

// Variante de `broadcast()` que solo le llega a los sockets con rol
// "teacher" de la sala (Etapa 58 — fix de una regresión reportada tras
// probar en Chrome real: ver `handleEndClass` en `ws/handlers.js`,
// el único lugar que la usa hoy).
function sendToTeachers(meetingCode, message) {
  const room = rooms.get(meetingCode);
  if (!room) return;
  for (const socket of room) {
    if (socket.role === 'teacher') send(socket, message);
  }
}

// Variante de `broadcast()` que solo le llega a los sockets con rol
// "student" de la sala — usado para "question_started" (Etapa de preguntas
// en tiempo real): la pregunta se emite únicamente a los alumnos
// conectados a esa clase, nunca a otras salas (ver `ws/handlers.js`,
// `handleSendQuestion`). El docente que la envió recibe su propia
// confirmación por otro mensaje ("question_stats_updated"), no este
// broadcast.
function sendToStudents(meetingCode, message) {
  const room = rooms.get(meetingCode);
  if (!room) return;
  for (const socket of room) {
    if (socket.role === 'student') send(socket, message);
  }
}

// ¿Sigue habiendo al menos un socket con rol "teacher" conectado a esta
// sala? (Etapa 50) — se consulta DESPUÉS de sacar de la sala al socket que
// se acaba de desconectar, así que si el docente tiene por algún motivo dos
// pestañas/conexiones abiertas, cerrar UNA no dispara la finalización
// automática mientras la otra siga en pie.
function isTeacherConnected(meetingCode) {
  const room = rooms.get(meetingCode);
  if (!room) return false;
  for (const socket of room) {
    if (socket.role === 'teacher') return true;
  }
  return false;
}

module.exports = {
  rooms,
  logWS,
  describeSocket,
  addToRoom,
  removeFromRoom,
  send,
  broadcast,
  getConnectedStudents,
  broadcastStudentList,
  sendToTeachers,
  sendToStudents,
  isTeacherConnected,
};
