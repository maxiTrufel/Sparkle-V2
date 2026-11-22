// Envuelve una promesa con un límite de tiempo — lo usan tanto la
// resolución de rol inicial (`hooks/useInitialRoleResolution.js`) como el
// chequeo fresco de "¿ya hay un docente?" al clickear "Soy Docente"
// (`App.jsx`, Capa 2 de la Etapa 71): son tres consultas al backend con el
// mismo patrón de timeout, factoreadas acá para no repetir el
// `Promise`/`setTimeout` en cada una.
export function withTimeout(promise, ms, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeoutId);
        reject(err);
      }
    );
  });
}
