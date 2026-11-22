const participationRepository = require('../repositories/participationRepository');

// Preferencia del toggle de la prueba de preview de cámara (Etapa 63) —
// HERRAMIENTA DE PRUEBA, pensada para eliminarse por completo antes de las
// funcionalidades reales de IA (ver DOCUMENTACION.md). Vive en la misma
// fila de `participations` que ya vincula usuario+reunión (no una tabla
// aparte), así que este service es casi un paso directo hacia
// `participationRepository` — se mantiene igual como capa separada por
// consistencia con el resto de los endpoints (ningún controller habla
// directo con un repositorio).

async function updatePreference(meetingCode, email, enabled) {
  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const normalizedEmail = email.trim().toLowerCase();

  // Requiere que la fila de `participations` ya exista (se crea en
  // `roleService.registerRole`, que siempre corre antes de que alguien vea
  // el toggle de alumno): si no existe, `affectedRows` da 0 y se rechaza en
  // vez de crear una fila a medias.
  const affectedRows = await participationRepository.updateCameraEnabled(
    normalizedMeetingCode,
    normalizedEmail,
    enabled
  );

  if (affectedRows === 0) {
    throw Object.assign(new Error('No hay ninguna participación registrada para ese meetingCode/email.'), {
      status: 404,
    });
  }

  return { meetingCode: normalizedMeetingCode, email: normalizedEmail, enabled };
}

async function getPreference(meetingCode, email) {
  const normalizedMeetingCode = meetingCode.trim().toLowerCase();
  const normalizedEmail = email.trim().toLowerCase();
  const enabled = await participationRepository.getCameraEnabled(normalizedMeetingCode, normalizedEmail);
  return { enabled };
}

module.exports = { updatePreference, getPreference };
