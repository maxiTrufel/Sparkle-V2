import { useEffect, useRef, useState } from 'react';
import { detectGoogleAccountEmail } from '../utils/detectEmail';
import { getTabEmail, setTabEmail } from '../utils/emailMemory';
import { withTimeout } from '../utils/withTimeout';
import { getMeetingRole, getHasTeacher } from '../services/backendMessaging';

const ROLE_QUERY_TIMEOUT_MS = 5000;
// Etapa 71 — mismo presupuesto que `ROLE_QUERY_TIMEOUT_MS` para la
// consulta de "¿ya hay un docente?" del boot (Capa 1): un round-trip a
// través del service worker que no debería demorar más que cualquier otra
// consulta REST de esta app. `App.jsx` reutiliza esta misma constante para
// su propio chequeo fresco al clickear "Soy Docente" (Capa 2).
export const HAS_TEACHER_QUERY_TIMEOUT_MS = 5000;
// Etapa 76 — cada cuánto se vuelve a consultar "¿ya hay un docente?"
// mientras esta persona sigue en Welcome sin haber elegido rol todavía (ver
// el efecto de polling más abajo). Mayor que
// `HAS_TEACHER_QUERY_TIMEOUT_MS` a propósito: evita que una consulta lenta
// todavía en vuelo se solape con el arranque de la siguiente.
const HAS_TEACHER_POLL_MS = 6000;

// La detección de email es una consulta al DOM que puede fallar si corre
// antes de que Meet termine de renderizar el botón de cuenta (pasa sobre
// todo en el lobby, con un layout distinto al de landing) — se reintenta
// unas cuantas veces en vez de un solo intento (ver DOCUMENTACION.md,
// Etapa 14).
//
// Nota (Etapa 22): email solo por DOM (`detectGoogleAccountEmail`, 3
// estrategias, Etapa 15), sin chrome.identity. La Etapa 82 suma una memoria
// por pestaña (`utils/emailMemory.js`) como respaldo, nunca por encima de lo
// que se lee de la página.
const EMAIL_DETECTION_ATTEMPTS = 6;
const EMAIL_DETECTION_RETRY_MS = 500;
// Presupuesto del intento FRESCO de `ensureEmail()` — solo se usa cuando el
// del boot ya terminó (no hay uno en vuelo para reusar, ver
// `bootDetectionRef`/`ensureEmail` más abajo). Más generoso que el del boot
// a propósito: acá no hay ningún spinner esperando (la UI ya está mostrando
// "Confirmando…" tras una acción explícita del usuario).
const ENSURE_EMAIL_FRESH_ATTEMPTS = 10;

// Etapa 82 — causa real del "a veces no detecta el mail", reproducida en
// Chrome real: al entrar DIRECTO a la llamada (reunión instantánea, sin sala
// de espera), el único lugar con el email es el cartel "Joined as …", que
// aparece una sola vez. El boot lo encontraba en ~2,1 s de un presupuesto
// de ~2,5 s; con la máquina cargada llegaba tarde, el boot se rendía y nada
// volvía a mirar la página — y cuando el cartel se iba, `ensureEmail()`
// tampoco tenía de dónde sacarlo. Ahora, mientras el email no se haya leído
// de la página, se la sigue mirando cada `EMAIL_WATCH_INTERVAL_MS` (ver el
// efecto "vigilancia del email" más abajo).
const EMAIL_WATCH_INTERVAL_MS = 1000;

function detectEmailWithRetries(detect, isCancelled, attempts = EMAIL_DETECTION_ATTEMPTS) {
  return new Promise((resolve) => {
    let attempt = 0;
    const tryDetect = () => {
      if (isCancelled()) {
        resolve(null);
        return;
      }
      const email = detect();
      attempt += 1;
      if (email || attempt >= attempts) {
        resolve(email);
        return;
      }
      setTimeout(tryDetect, EMAIL_DETECTION_RETRY_MS);
    };
    tryDetect();
  });
}

// Al montar, se intenta resolver el rol de esta reunión puntual antes de
// mostrar cualquier pantalla: el backend puede devolver "profesor",
// "alumno" o null (nunca participó en ESTA reunión — puede tener otro rol
// en otra distinta, ver Etapa 17). "profesor"/"alumno" saltan directo a su
// panel; null, sin email, error de red, backend caído o timeout muestran
// Welcome para elegir a mano.
//
// Devuelve los setters de `role`/`hasTeacher`, no solo los valores: varios
// handlers de `App.jsx` (elegir un rol, confirmar docente/alumno) necesitan
// seguir escribiendo ese mismo estado después de este boot — el hook cambia
// quién lo DECLARA, no quién puede escribirlo.
export function useInitialRoleResolution({ meetingCode, callStage }) {
  const [role, setRole] = useState(null);
  // Nombre de usuario elegido por el alumno al registrarse (`StudentName.jsx`)
  // — siempre `null` para "teacher" (esas filas nunca tienen nombre, ver
  // `roleService.getRole`). Se completa acá en el boot cuando el backend ya
  // resuelve `role: 'student'` para esta reunión (reingreso), y también vía
  // `setName` cuando se confirma el registro en esta misma sesión (ver
  // `App.jsx`, `handleNameConfirmed`).
  const [name, setName] = useState(null);
  // Etapa 71, Capa 1 (preventiva) — `true` si esta reunión YA tiene un
  // docente permanente registrado con un email DISTINTO al detectado acá.
  // Solo le importa a `Welcome.jsx`; si el rol propio ya se resolvió
  // (`profesor` o `alumno`), esta consulta ni se hace, porque `Welcome`
  // nunca se va a mostrar.
  const [hasTeacher, setHasTeacher] = useState(false);
  const [email, setEmail] = useState(null);
  // Etapa 82 — `true` si `email` se leyó de la página de Meet; `false`
  // mientras no haya email o si salió de la memoria de la pestaña. Mientras
  // sea `false`, la vigilancia sigue mirando la página.
  const [emailFromPage, setEmailFromPage] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  // Espejo síncrono de `email` — `ensureEmail()` (más abajo) lo necesita
  // para decidir de una si hace falta un intento nuevo, sin esperar a que
  // termine el ciclo de render de React.
  const emailRef = useRef(null);
  // Espejo síncrono de `role`, para la vigilancia del email (corre dentro de
  // un intervalo, donde `role` quedaría congelado en su valor inicial).
  const roleRef = useRef(null);
  useEffect(() => {
    roleRef.current = role;
  }, [role]);
  // Promesa de detección del BOOT mientras sigue en vuelo, o `null` si ya
  // terminó — le permite a `ensureEmail()` reusar ESE loop en vez de
  // arrancar uno segundo en paralelo. Hoy no es alcanzable (`App.jsx` no
  // muestra `ConfirmTeacher`/`StudentName` mientras el boot sigue en vuelo);
  // se deja como resguardo barato ante un cambio futuro de ese gateo.
  const bootDetectionRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Espejo síncrono de `callStage` — mismo motivo que `emailRef`: leerlo
  // dentro de un loop async sin tener que meter `callStage` en las
  // dependencias del efecto de boot (ver el "OJO" al final de ese efecto).
  const callStageRef = useRef(callStage);
  useEffect(() => {
    callStageRef.current = callStage;
  }, [callStage]);

  const LOBBY_POLL_MS = 300;

  // Espera activa mientras siga en el lobby — ver el comentario del efecto
  // de boot, más abajo.
  function waitForLobbyExit(isCancelled) {
    return new Promise((resolve) => {
      const check = () => {
        if (isCancelled() || callStageRef.current !== 'lobby') {
          resolve();
          return;
        }
        setTimeout(check, LOBBY_POLL_MS);
      };
      check();
    });
  }

  // Una lectura de la página. "Cualquier email escrito en la página" (ver
  // `plainText` en `detectEmail.js`) solo se acepta en la sala de espera,
  // donde hace falta. Ni en la llamada ni en 'undetermined': al montar el
  // panel `callStage` todavía vale 'undetermined' aunque ya se esté adentro,
  // con el chat a la vista. Lo que se encuentra se anota en la memoria de
  // la pestaña.
  function detectFromPage() {
    const found = detectGoogleAccountEmail({ allowPlainText: callStageRef.current === 'lobby' });
    if (found) setTabEmail(found);
    return found;
  }

  function adoptEmail(found, fromPage) {
    emailRef.current = found;
    setEmail(found);
    setEmailFromPage(fromPage);
  }

  // Consulta al backend el rol de `detectedEmail` en esta reunión y, si no
  // tiene ninguno, si ya hay otro docente (Etapa 71, Capa 1). La usan el boot
  // y la vigilancia del email, cuando el email aparece más tarde.
  async function resolveRoleFor(detectedEmail, isCancelled) {
    let timeoutId;
    try {
      const result = await new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Timeout consultando el rol.')), ROLE_QUERY_TIMEOUT_MS);
        getMeetingRole(meetingCode, detectedEmail).then(resolve, reject);
      });

      console.log(
        `[Sparkle] Backend respondió rol="${result?.role}" para ${detectedEmail} en la reunión ${meetingCode}`
      );
      if (isCancelled()) return;

      if (result?.role === 'teacher') {
        setRole('teacher');
      } else if (result?.role === 'student') {
        setRole('student');
        setName(result?.name || null);
      } else {
        // result?.role === null: se queda en null → Welcome. Best-effort con
        // timeout propio: si falla o tarda, `hasTeacher` se queda en `false`
        // (su default) — el peor caso es mostrar de más la tarjeta "Soy
        // Docente", que la Capa 2 igual atrapa antes de asignar nada.
        try {
          const teacherStatus = await withTimeout(
            getHasTeacher(meetingCode, detectedEmail),
            HAS_TEACHER_QUERY_TIMEOUT_MS,
            'Timeout consultando si ya hay un docente.'
          );
          if (!isCancelled()) setHasTeacher(Boolean(teacherStatus?.hasTeacher));
        } catch (err) {
          console.log('[Sparkle] Error consultando si ya hay un docente:', err.message);
        }
      }
    } catch (err) {
      console.log(`[Sparkle] Error consultando el rol: ${err.message}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Boot: la primera búsqueda del email y la consulta del rol.
  //
  // `waitForLobbyExit` intentaba no gastar los reintentos en la sala de
  // espera. OJO (Etapa 82): al montar, `callStage` todavía vale
  // 'undetermined' (se resuelve un render después), así que esta espera casi
  // nunca se activa y la búsqueda corre igual en la sala de espera. No hace
  // daño: ahí el email está escrito en la página y se encuentra en
  // milisegundos (confirmado en Chrome real). Se deja como está.
  useEffect(() => {
    let cancelled = false;

    const resolveInitialRole = async () => {
      await waitForLobbyExit(() => cancelled);
      if (cancelled) return;

      const bootStartedAt = Date.now();
      const detection = detectEmailWithRetries(detectFromPage, () => cancelled);
      bootDetectionRef.current = detection;
      const pageEmail = await detection;
      bootDetectionRef.current = null;
      if (cancelled) return;

      // Etapa 82 — si la página no lo mostró a tiempo, se usa el que esta
      // pestaña ya había visto (página de inicio de Meet, sala de espera o
      // una carga anterior). La vigilancia sigue mirando la página igual.
      const detectedEmail = pageEmail || getTabEmail();
      adoptEmail(detectedEmail, Boolean(pageEmail));

      if (!detectedEmail) {
        console.log(
          `[Sparkle][DIAG] Boot: NO se pudo detectar el email tras ${EMAIL_DETECTION_ATTEMPTS} intentos ` +
            `(${Date.now() - bootStartedAt}ms) y esta pestaña no tiene uno anotado. ` +
            `Se sigue mirando la página cada ${EMAIL_WATCH_INTERVAL_MS}ms.`
        );
        setIsBooting(false);
        return;
      }

      console.log(
        pageEmail
          ? `[Sparkle][DIAG] Boot: email detectado en ${Date.now() - bootStartedAt}ms.`
          : `[Sparkle][DIAG] Boot: la página no mostró el email en ${Date.now() - bootStartedAt}ms — ` +
              `se usa el anotado en esta pestaña (${detectedEmail}).`
      );

      if (!meetingCode) {
        // No debería pasar (este hook solo vive dentro de una llamada),
        // pero por las dudas no se cuelga: se muestra Welcome.
        setIsBooting(false);
        return;
      }

      await resolveRoleFor(detectedEmail, () => cancelled);
      if (!cancelled) setIsBooting(false);
    };

    resolveInitialRole();

    return () => {
      cancelled = true;
    };
    // OJO: a propósito sin `callStage` en las dependencias — ver
    // `callStageRef`/`waitForLobbyExit` más arriba. Si `callStage`
    // estuviera acá, CUALQUIER transición (incluida 'undetermined' →
    // 'in-call', el caso SIN lobby, el más común) reiniciaría este efecto
    // entero — cancelando y volviendo a arrancar la detección desde cero.
  }, [meetingCode]);

  // Etapa 82 — vigilancia del email. Mientras el email no se haya leído de
  // la página (no hay ninguno, o salió de la memoria de la pestaña), se la
  // vuelve a mirar cada segundo. Cuando aparece, se adopta; si es un email
  // nuevo y todavía no hay rol, se consulta el rol, así el panel se acomoda
  // solo (Welcome o el panel que corresponda) sin que la persona haga nada.
  // Se detiene sola apenas lo encuentra (`emailFromPage` pasa a `true`).
  useEffect(() => {
    if (isBooting || emailFromPage || !meetingCode) return undefined;

    const intervalId = setInterval(() => {
      const found = detectFromPage();
      if (!found || !mountedRef.current) return;
      clearInterval(intervalId);

      const previous = emailRef.current;
      adoptEmail(found, true);
      if (found === previous) return;

      console.log(
        `[Sparkle][DIAG] Vigilancia: email leído de la página → ${found}` +
          (previous ? ` (reemplaza a ${previous}, anotado en la pestaña).` : '.')
      );
      // Sin atar a la limpieza de este efecto a propósito: `adoptEmail` la
      // dispara al poner `emailFromPage` en `true`, y eso no debe descartar
      // la respuesta del rol.
      if (roleRef.current === null) resolveRoleFor(found, () => !mountedRef.current);
    }, EMAIL_WATCH_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [isBooting, emailFromPage, meetingCode]);

  // Etapa 76 — Capa 1 (boot, arriba) y Capa 2 (chequeo fresco al clickear,
  // en `App.jsx`) solo confirman "¿ya hay un docente?" en dos momentos
  // puntuales — si otra persona se registra como docente MIENTRAS esta
  // sigue mirando Welcome sin clickear nada, la tarjeta "Soy Docente" se
  // quedaba visible hasta que esta persona la clickeaba y recién ahí caía
  // en la pantalla de rechazo. Este polling (Capa 3, casi en tiempo real)
  // hace que la tarjeta desaparezca sola, sin necesitar ningún click.
  //
  // Se detiene solo en dos casos, sin necesitar ningún flag aparte: apenas
  // `hasTeacher` da `true` (el rol de docente es PERMANENTE — Etapa 61 — no
  // puede volver a `false`, así que no hace falta seguir consultando), o
  // apenas se elige un rol (`role !== null`, Welcome deja de mostrarse).
  // Solo corre una vez terminó el boot y hay `meetingCode`/`email`
  // resueltos — antes de eso ya lo cubre `resolveInitialRole` de arriba.
  useEffect(() => {
    if (isBooting || role !== null || hasTeacher || !meetingCode || !email) return;

    let cancelled = false;
    const intervalId = setInterval(async () => {
      try {
        const teacherStatus = await withTimeout(
          getHasTeacher(meetingCode, email),
          HAS_TEACHER_QUERY_TIMEOUT_MS,
          'Timeout consultando si ya hay un docente.'
        );
        if (!cancelled && teacherStatus?.hasTeacher) setHasTeacher(true);
      } catch (err) {
        console.log('[Sparkle] Error en el polling de "¿ya hay un docente?":', err.message);
      }
    }, HAS_TEACHER_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isBooting, role, hasTeacher, meetingCode, email]);

  // Segundo intento de detección, BAJO DEMANDA — lo llaman `ConfirmTeacher.jsx`/
  // `StudentName.jsx` justo antes de una escritura crítica (registrar el
  // rol), nunca al boot. Si `email` ya está resuelto (por el boot, la
  // vigilancia o la memoria de la pestaña), devuelve ese valor de una. Si
  // no: reusa la detección del boot si sigue en vuelo, o arranca un intento
  // fresco con un presupuesto más generoso, y como último recurso usa la
  // memoria de la pestaña.
  //
  // Si todo falla, devuelve `null` explícito — el llamador muestra el error
  // con "Reintentar" y "Recargar la página", nunca un timeout silencioso.
  async function ensureEmail() {
    if (emailRef.current) return emailRef.current;

    if (bootDetectionRef.current) {
      console.log('[Sparkle][DIAG] ensureEmail(): reusando la detección del boot, todavía en vuelo.');
      const detectedEmail = await bootDetectionRef.current;
      if (detectedEmail) return detectedEmail;
      console.log('[Sparkle][DIAG] ensureEmail(): la detección del boot (reusada) también falló — intento fresco adicional.');
    }

    const attemptStartedAt = Date.now();
    console.log('[Sparkle][DIAG] ensureEmail(): intento fresco bajo demanda.');
    const pageEmail = await detectEmailWithRetries(detectFromPage, () => !mountedRef.current, ENSURE_EMAIL_FRESH_ATTEMPTS);
    const detectedEmail = pageEmail || getTabEmail();
    console.log(
      `[Sparkle][DIAG] ensureEmail(): resultado="${detectedEmail || '(null)'}"` +
        `${detectedEmail && !pageEmail ? ' (anotado en la pestaña)' : ''} en ${Date.now() - attemptStartedAt}ms.`
    );

    if (mountedRef.current && detectedEmail) adoptEmail(detectedEmail, Boolean(pageEmail));
    return detectedEmail;
  }

  return { email, role, setRole, name, setName, hasTeacher, setHasTeacher, isBooting, ensureEmail };
}
