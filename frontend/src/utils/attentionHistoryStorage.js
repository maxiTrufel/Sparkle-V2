// Persistencia del historial de atención grupal (`hooks/useAttentionHistory.js`)
// entre recargas de la página — mismo criterio que `togglePosition.js`:
// `chrome.storage.local`, no `localStorage` de la página (por origen,
// podría no estar disponible/aislado de forma consistente entre distintas
// pestañas de Meet, y no sobrevive el ciclo de vida del content script del
// mismo modo). La clave incluye el `meetingCode` para no mezclar el
// historial de dos reuniones distintas bajo la misma clave.
const STORAGE_KEY_PREFIX = 'sparkle-attention-history-';

function storageKeyFor(meetingCode) {
  return `${STORAGE_KEY_PREFIX}${meetingCode}`;
}

export function getStoredAttentionHistory(meetingCode) {
  const key = storageKeyFor(meetingCode);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      const value = result[key];
      resolve(Array.isArray(value) ? value : null);
    });
  });
}

export function setStoredAttentionHistory(meetingCode, history) {
  chrome.storage.local.set({ [storageKeyFor(meetingCode)]: history });
}

// Se llama únicamente ante un "class_started" GENUINO (clase nueva de
// cero, ver `hooks/useLiveClass.js#classStartedSignal`) — nunca en
// "class_ended"/"class_resumed", ni en un simple F5 a mitad de clase.
export function clearStoredAttentionHistory(meetingCode) {
  chrome.storage.local.remove(storageKeyFor(meetingCode));
}
