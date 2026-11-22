// Posición vertical del botón de abrir/cerrar el panel (ToggleTab), elegida
// por el usuario arrastrándolo. Es una preferencia de UI pura — a
// diferencia del rol (ver DOCUMENTACION.md, Etapa 3), acá sí tiene sentido
// persistir entre sesiones, así que se guarda en chrome.storage.local (no
// en localStorage de la página, que es por origen y podría no estar
// disponible/aislado de forma consistente entre distintas pestañas de Meet).
const STORAGE_KEY = 'sparkle-toggle-top';

export function getStoredTogglePosition() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const value = result[STORAGE_KEY];
      resolve(typeof value === 'number' ? value : null);
    });
  });
}

export function setStoredTogglePosition(top) {
  chrome.storage.local.set({ [STORAGE_KEY]: top });
}
