// Persistencia de "ya se mostró el aviso de encuadre de cámara en esta
// reunión" (`ui/CameraPositionNotice.jsx`) entre recargas de la página —
// mismo criterio que `attentionHistoryStorage.js`: `chrome.storage.local`,
// no `localStorage` de la página (que es el storage de Meet, no el de la
// extensión). La clave incluye el `meetingCode` para no mezclar el estado
// de dos reuniones distintas — sin `email`/id de alumno, mismo criterio
// que el resto de las claves ya escopeadas solo por reunión en este
// archivo hermano.
const STORAGE_KEY_PREFIX = 'sparkle-camera-notice-shown-';

function storageKeyFor(meetingCode) {
  return `${STORAGE_KEY_PREFIX}${meetingCode}`;
}

export function getCameraNoticeShown(meetingCode) {
  const key = storageKeyFor(meetingCode);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] === true);
    });
  });
}

export function setCameraNoticeShown(meetingCode) {
  chrome.storage.local.set({ [storageKeyFor(meetingCode)]: true });
}
