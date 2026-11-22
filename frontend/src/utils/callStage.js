// Señales de DOM para distinguir lobby / en-llamada / pantalla de salida
// dentro de una misma URL de reunión — las tres comparten exactamente el
// mismo path, así que `meetContext.js` (deliberadamente simple, solo por
// URL, ver Etapa 22) no puede diferenciarlas por sí solo.
//
// Es la MISMA combinación de señales que se probó en la Etapa 18 (botón
// de "salir de la llamada" por aria-label + textos de lobby/salida como
// señal negativa de refuerzo), pero con un alcance mucho más chico e
// intencionalmente más seguro: en la Etapa 18 esta detección decidía si
// el panel entero se MONTABA o no, y una señal ambigua terminaba con el
// botón sin aparecer en absoluto (la regresión que llevó a revertirla en
// la Etapa 22). Acá solo decide qué CONTENIDO mostrar dentro de un panel
// que de todos modos ya está montado por la detección simple de
// `meetContext.js` — si la señal es ambigua, quien la usa (App.jsx) cae
// al flujo normal (Welcome/TeacherPanel/StudentPanel) como fallback
// seguro, nunca a una pantalla vacía. Ver Etapa 24 en DOCUMENTACION.md.
// Etapa 34: las listas de palabras/frases clave se separan por idioma (en
// vez de un único array plano mezclado) y se combinan recién al armar el
// regex final — agregar un idioma nuevo en el futuro es sumar una entrada
// más a cada objeto de abajo, sin tocar la lógica de combinación ni la de
// `detectCallStage()`. Ver DOCUMENTACION.md Etapa 34 para el detalle del
// bug de español que motivó este agregado (el lobby en español mostraba
// Welcome en vez del mensaje de espera, porque `LOBBY_TEXT_REGEX` solo
// tenía cubierto el inglés y una traducción parcial/incorrecta).
function combinePatterns(byLanguage) {
  const sources = Object.values(byLanguage)
    .flat()
    .map((regex) => regex.source);
  return new RegExp(sources.join('|'), 'i');
}

// Etapa 35: se agregan variantes adicionales en español ("finalizar
// llamada", "terminar llamada", "cortar la llamada") de forma defensiva,
// más allá de las tres que ya estaban desde la Etapa 18/34 (`salir de la
// llamada`, `colgar`, `abandonar la llamada`) — sin confirmación en Chrome
// real todavía de cuál es el aria-label exacto que usa Meet en español
// (ver el log agregado en `hasExitButton()` más abajo, pensado justamente
// para confirmar esto con DEBUG_VERBOSE=true). `colgar` sin más contexto
// ya cubre por sí solo tanto "Colgar" como "Colgar la llamada" (test de
// substring, no de frase exacta), pero se dejan las variantes completas
// igual por claridad y por si alguna reevaluación futura reduce el
// matching a frases más específicas.
// Etapa 39: `colgar` bordeado con `\b` — sin límites de palabra, "colgar"
// como substring podría en teoría matchear dentro de otra palabra que lo
// contenga (ej. "descolgar", si Meet llegara a usarlo en algún contexto).
// El resto de las entradas ya son frases de varias palabras, lo
// suficientemente específicas por sí solas (ver auditoría completa en
// DOCUMENTACION.md Etapa 39).
const EXIT_BUTTON_LABEL_PATTERNS = {
  en: [/leave call/, /end call/, /hang up/],
  es: [
    /salir de la llamada/,
    /\bcolgar\b/,
    /abandonar la llamada/,
    /finalizar llamada/,
    /terminar llamada/,
    /cortar la llamada/,
  ],
};
const EXIT_BUTTON_LABEL_REGEX = combinePatterns(EXIT_BUTTON_LABEL_PATTERNS);

// Etapa 34: "ready to join"/"listo para unirte" son la traducción del
// TÍTULO del lobby, pero el título real que muestra Meet en español es
// "Ya puedes unirte" (reportado y reproducido en Chrome real) — no una
// traducción literal de "ready to join". Se agregan además las otras
// señales de texto visibles en el lobby en español ("No hay nadie más
// aquí...", botón "Unirse ahora", link "Otras formas de unirte"), y se
// deja "listo para unirte" por las dudas de que Meet muestre esa variante
// en algún flujo distinto (ej. sala de espera con host) — no hace daño
// mantenerla.
// Etapa 38: "sala de espera con aprobación del host" — un sub-estado de
// lobby distinto del lobby normal ("Ya puedes unirte"/"Ready to join?"):
// acá el usuario ya tocó "Unirse ahora"/"Join now", pero la reunión exige
// que un anfitrión lo admita manualmente antes de dejarlo entrar
// ("Espera a que un anfitrión de la reunión te agregue a la llamada" /
// "Please wait until a meeting host brings you into the call"). A nivel
// de CONTENIDO del panel es la misma pantalla que el lobby normal (mismo
// `LobbyScreen`, mismo mensaje "Esperando para ingresar..." — ver
// LobbyScreen.jsx), así que se trata como una variante MÁS dentro de
// `LOBBY_TEXT_PATTERNS`, no como un estado nuevo separado: no hace falta
// tocar `detectCallStage()`, App.jsx ni el sticky state, todos ya sabían
// tratar cualquier match de `LOBBY_TEXT_REGEX` como `'lobby'`.
//
// Dos patrones por idioma, no uno solo (mismo criterio "combo con ventana
// de caracteres" que ya usan `MEETING_ENDED_ORDER1/2` y
// `EXIT_BUTTON_LABEL_PATTERNS` en vez de una frase exacta): uno con la
// combinación flexible "anfitrión/host ... verbo de admisión ...
// llamada/call" (para variantes de redacción que Meet pueda mostrar), y
// uno con el fragmento inicial de la frase reportada tal cual
// ("Espera a que ... anfitrión" / "Please wait until ... host"), como
// respaldo por si la combinación de arriba no llega a matchear.
// Etapa 39: `host`/`anfitrión` bordeados con `\b` en los combos de sala de
// espera — "host" sin límite de palabra matchearía como substring dentro
// de "ghost"/"hosting"/"hostname" (poco probable en la UI de Meet, pero
// gratis de blindar). El resto de las entradas son frases de varias
// palabras ya suficientemente específicas.
const LOBBY_TEXT_PATTERNS = {
  en: [
    /ready to join/,
    /join now/,
    /ask to join/,
    /\bhost\b[\s\S]{0,60}(brings you|admits you|lets you in)[\s\S]{0,40}\bcall\b/,
    /please wait until[\s\S]{0,20}\bhost\b/,
  ],
  es: [
    /ya puedes unirte/,
    /listo para unirte/,
    /pedir unirse/,
    /unirse ahora/,
    /no hay nadie m[aá]s/,
    /otras formas de unirte/,
    /\banfitri[oó]n\b[\s\S]{0,60}(agregue|admita|deje entrar)[\s\S]{0,40}\bllamada\b/,
    /espera a que[\s\S]{0,20}\banfitri[oó]n\b/,
  ],
};
const LOBBY_TEXT_REGEX = combinePatterns(LOBBY_TEXT_PATTERNS);

// Etapa 83 — la sala de espera con host (Etapa 38) ahora tiene la barra de
// botones de la llamada, con el botón rojo de colgar. Con botón de salir Y
// texto de lobby a la vez, `detectCallStage()` no caía en ninguna rama y
// daba 'undetermined'; si esa era la primera lectura quedaba pegada (el
// sticky ignora los 'undetermined' siguientes) y el panel mostraba Welcome,
// pidiéndole rol a alguien que todavía no fue admitido.
//
// Estas frases, a diferencia del resto de `LOBBY_TEXT_PATTERNS`, solo existen
// en esa pantalla, así que en `detectCallStage()` ganan aunque haya botón de
// salir. No se suman acá las frases genéricas del lobby ("join now",
// "unirse ahora"): pueden aparecer adentro de una llamada real (por ejemplo,
// la invitación a una sala para grupos) y sacarían a alguien del panel.
// "Still trying to get in" es el título que se vio en Chrome real (13/9).
const WAITING_FOR_HOST_TEXT_PATTERNS = {
  en: [
    /\bhost\b[\s\S]{0,60}(brings you|admits you|lets you in)[\s\S]{0,40}\bcall\b/,
    /please wait until[\s\S]{0,20}\bhost\b/,
    /still trying to get in/,
  ],
  es: [
    /\banfitri[oó]n\b[\s\S]{0,60}(agregue|admita|deje entrar)[\s\S]{0,40}\bllamada\b/,
    /espera a que[\s\S]{0,20}\banfitri[oó]n\b/,
  ],
};
const WAITING_FOR_HOST_TEXT_REGEX = combinePatterns(WAITING_FOR_HOST_TEXT_PATTERNS);

// Etapa 25/27: en vez de frases exactas ("you left the meeting"), se buscan
// PALABRAS CLAVE combinadas, para no depender de que el texto exacto no
// cambie. Lista exhaustiva de variantes contempladas (Etapa 27 — ver
// DOCUMENTACION.md para el detalle completo de por qué se agregó cada
// una):
//   EN: "You left the meeting", "You've ended the meeting for everyone",
//       "You were removed from the meeting", "Meeting ended" / "This
//       meeting has ended", "You are leaving the meeting".
//   ES: "Dejaste la reunión", "Saliste de la reunión", "Finalizaste la
//       reunión/llamada (para todos)", "Terminaste la reunión/llamada",
//       "Te expulsaron/eliminaron de la reunión".
// Se arman combinando dos listas (cualquier verbo + cualquier sustantivo,
// en cualquier orden), en vez de una entrada por frase completa:
//   1. un sustantivo de reunión/llamada (meeting/call/reunión/llamada)
//      cerca de un verbo de "se terminó/salí" (ended/left/leaving/
//      removed/finaliz*/termin*/dejaste/saliste/abandonaste/expulsad*/
//      elimin*), en cualquier orden.
//   2. el texto del botón/link que casi siempre acompaña a esta pantalla
//      para volver a entrar o al inicio ("Rejoin"/"Volver a unirte
//      (unirse)", "Return to home screen"/"Volver a la pantalla de
//      inicio"/"Volver al inicio") — estable entre variantes aunque
//      cambie el título de arriba, y con una particularidad importante
//      (ver el comentario de "dos niveles de confianza" más abajo): es
//      texto de interfaz, nunca algo que aparecería dicho al pasar en un
//      subtítulo durante una llamada real.
// Etapa 30: la detección quedó confirmada como estable tras el proceso de
// debugging de las Etapas 25-29 (documentado abajo y en las entradas
// correspondientes de DOCUMENTACION.md), así que los logs [Sparkle DEBUG]
// detallados (texto completo del DOM, cada check individual, cada
// re-evaluación del polling) se apagaron por defecto — generaban ruido
// constante en la consola sin aportar nada nuevo. Cambiar a `true` para
// reactivarlos si hace falta diagnosticar algo similar en el futuro (sin
// necesidad de tocar ningún otro código: todos los `debugLog(...)` de
// este archivo respetan este flag).
//
// Etapa 31: se reactivó temporalmente (`true`) para confirmar en Chrome
// real el fix del choque Nivel A / lobby — confirmado (Etapa 32), vuelve
// a `false`.
//
// Etapa 35: se reactivó de nuevo, temporalmente, para confirmar en Chrome
// real (con Meet en español) la transición lobby → en-llamada y capturar
// en consola el aria-label real del botón de salir en español. Etapa 36
// reutilizó esta misma activación para confirmar el fix de prioridad
// hasExitButton/combo B. Confirmado en Chrome real (Etapa 36) — vuelto a
// `false`.
//
// Etapa 39: reactivado de nuevo, temporalmente, para diagnosticar un
// falso positivo reportado — el modal/notificación de "Admitir invitado"
// (alguien más tratando de unirse) durante una llamada activa se detecta
// como `'salida'` en vez de `'en-llamada'`. Etapa 40 sumó el log de
// contexto que permitió encontrar la causa real con Chrome real: un
// tooltip de ayuda de hardware que contiene la palabra "rejoin" en un
// sentido no relacionado. Etapa 41 aplicó el fix (degradar `rejoin` a
// Nivel B) y lo confirmó con test — vuelto a `false`.
//
// Etapa 43: reactivado de nuevo, temporalmente, para investigar una
// posible condición de carrera en la evaluación inicial del sticky state
// bajo latencia/CPU alta (throttling) — la sala de espera con host
// (Etapa 38) mostraba Welcome en vez del mensaje de lobby, de forma más
// consistente con throttling activado. Causa confirmada por inspección de
// código + test (ventana de gracia sin protección en la primera
// evaluación) y fix aplicado — vuelto a `false`.
//
// Etapa 77: se intentó corregir a ciegas (sin poder reproducir en Chrome
// real) un reporte de falso positivo de 'ended' al abrir el panel
// "Personas" — se excluyó el infinitivo "finalizar" del combo B (el ítem
// de menú "Finalizar la llamada para todos los participantes", hipótesis
// de la Etapa 36) y se agregó una confirmación de dos lecturas seguidas
// para la transición 'in-call'→'ended'. Etapa 78: el usuario confirmó que
// el bug SIGUE ocurriendo, y además con un segundo panel de Meet
// completamente distinto en contenido ("Controles del anfitrión") — dos
// paneles sin texto en común (confirmado contra la documentación oficial
// de Meet, sin ningún hallazgo de colisión en ninguno de los dos)
// produciendo el mismo síntoma apunta a algo SISTÉMICO (`hasExitButton`
// dejando de matchear en general, quizás por un cambio de Meet desde la
// última confirmación en Chrome real de la Etapa 37, o un combo B genérico
// en un lugar del DOM ajeno a cualquiera de los dos paneles), no a texto
// específico de ninguno de los dos. Sin poder reproducir Meet real en este
// entorno, seguir adivinando frases puntuales no es un camino confiable —
// se reactiva `DEBUG_VERBOSE` (con el log de contexto de la Etapa
// 40/78 ahora cubriendo TAMBIÉN el combo B genérico y `lobbyText`, antes
// solo booleanos) para la próxima reproducción en Chrome real. Volver a
// `false` una vez confirmada la causa real con el log completo.
//
// Etapa 79: el log de contexto de la Etapa 78 cumplió su propósito — el
// usuario reprodujo en Chrome real y confirmó la causa exacta: el check
// de Nivel A `volver a unirse` (no un combo B genérico ni un
// `hasExitButton` roto) matcheaba el texto explicativo de un toggle
// dentro de "Controles del anfitrión" ("Podrán volver a unirse cuando se
// vuelva a activar la opción"), con `hasExitButton=true` y el botón
// "Abandonar la llamada" genuinamente presente. Con la causa real
// confirmada y el fix aplicado (`volver a unirte`/`volver a unirse`
// degradados de Nivel A a Nivel B, mismo tratamiento que `rejoin` desde
// la Etapa 41 — ver `EXIT_ACTION_CHECKS_BY_LANG`/`DOWNGRADED_EXIT_CHECKS_BY_LANG`
// más abajo), vuelve a `false`.
const DEBUG_VERBOSE = false;

function debugLog(...args) {
  if (DEBUG_VERBOSE) console.log(...args);
}

// Etapa 34: mismo criterio de separación por idioma que arriba, aplicado
// a las palabras sueltas que arman el combo "sustantivo + verbo" del
// Nivel B (en vez de un string plano tipo '(meeting|call|reunión|...)').
// Etapa 39: todas las palabras/stems sueltos de estas dos listas se
// bordean con `\b` — sin límite de palabra, eran substrings dentro de
// palabras comunes no relacionadas: "call" matcheaba dentro de "Call
// quality settings" (un elemento real y visible de la UI de Meet durante
// una llamada activa) o "recall", "ended" matcheaba dentro de "attended",
// "termin" matcheaba dentro de "determinar"/"terminar" ya cubierto pero
// también dentro de palabras como "determinado", "left" matcheaba dentro
// de "left panel"/"leftover". Confirmado con test (ver
// test-callstage-word-boundaries en DOCUMENTACION.md Etapa 39) que estas
// colisiones eran reales antes del fix y dejan de serlo después. Los
// stems con `\w*` (`finaliz`, `termin`, `expuls`, `elimin`) solo llevan
// `\b` al INICIO — el `\b` de cierre después de `\w*` es redundante
// (un run de caracteres de palabra siempre termina en un límite de
// palabra), así que no hace falta agregarlo.
//
// Etapa 77: los cuatro stems en español (`finaliz`, `termin`, `expuls`,
// `elimin`) además excluyen puntualmente el INFINITIVO exacto ("finalizar",
// "terminar", "expulsar", "eliminar") con un lookahead negativo
// (`(?!ar\b)`), sin afectar ninguna otra forma conjugada del mismo verbo
// ("finalizaste", "finalizó", "finalizando", etc. siguen matcheando igual
// que siempre). La razón: un infinitivo describe una ACCIÓN disponible
// ("Finalizar la llamada para todos los participantes", el ítem de menú
// del organizador para terminar la reunión — ya documentado como
// hipótesis en la Etapa 36 — o "Quitar/Expulsar de la llamada", "Eliminar
// participante" en los controles del panel "Personas"), no un ESTADO ya
// ocurrido ("Finalizaste la llamada", la pantalla real de salida) — y
// solo el segundo caso debería contar como señal de "salida". El stem sin
// esta exclusión matcheaba ambos por igual, y `!botonSalir` (la única
// salvaguarda que tenía el combo B contra el primer caso, Etapa 36) no es
// una señal perfectamente estable: un reporte con Meet en español (abrir
// el panel "Personas" desde el ícono de participantes) mostraba "Llamada
// finalizada" en pleno medio de una llamada activa, consistente con que
// ese ítem de menú (siempre presente en el DOM para el organizador,
// vía `textContent` aunque esté oculto — Etapa 29) coincidiera en algún
// momento con una lectura de `botonSalir=false` (sin poder confirmarse
// con Chrome real con certeza absoluta si la causa puntual fue esa u otra
// mutación transitoria del DOM al montarse el panel — ver también el
// resguardo agregado en `resolverConSticky()` más abajo, pensado como
// segunda capa de defensa para este mismo reporte).
const MEETING_NOUN_WORDS = {
  en: ['\\bmeeting\\b', '\\bcall\\b'],
  es: ['\\breuni[oó]n\\b', '\\bllamada\\b'],
};
const ENDED_VERB_WORDS = {
  en: ['\\bended\\b', '\\bleft\\b', '\\bleaving\\b', '\\bremoved\\b'],
  es: [
    '\\bfinaliz(?!ar\\b)\\w*',
    '\\btermin(?!ar\\b)\\w*',
    '\\bdejaste\\b',
    '\\bsaliste\\b',
    '\\babandonaste\\b',
    '\\bexpuls(?!ar\\b)\\w*',
    '\\belimin(?!ar\\b)\\w*',
  ],
};
const MEETING_NOUN_REGEX = `(${Object.values(MEETING_NOUN_WORDS).flat().join('|')})`;
const ENDED_VERB_REGEX = `(${Object.values(ENDED_VERB_WORDS).flat().join('|')})`;

// Etapa 25, desglosado en piezas individuales (en vez de un único regex
// combinado) para poder loguear cada chequeo por separado — ver el bloque
// de diagnóstico en detectCallStage() más abajo.
const MEETING_ENDED_ORDER1_REGEX = new RegExp(`${MEETING_NOUN_REGEX}[\\s\\S]{0,60}${ENDED_VERB_REGEX}`, 'i');
const MEETING_ENDED_ORDER2_REGEX = new RegExp(`${ENDED_VERB_REGEX}[\\s\\S]{0,60}${MEETING_NOUN_REGEX}`, 'i');

// Etapa 34: EXIT_ACTION_CHECKS (Nivel A) también separado por idioma —
// se aplana con Object.values(...).flat() al final, conservando el mismo
// formato [label, regex] que usa el bloque de diagnóstico de abajo.
// Etapa 39: se bordeaba `rejoin` con `\b` de forma preventiva (auditoría
// general, no porque se haya podido reproducir una colisión real contra
// "Admit" — probado que `/rejoin/i` NO matchea "Admit 1 guest"/"Admit
// all"/"Admit": no comparten ninguna secuencia de letras).
// Etapa 40 (log de contexto) permitió confirmar con Chrome real la causa
// verdadera de un falso positivo similar: un tooltip de ayuda sobre
// hardware de micrófono/cámara ("...non-Google meeting hardware. They can
// rejoin when it's turned on again.") contiene la palabra "rejoin" en un
// sentido totalmente distinto (reconectar un DISPOSITIVO, no volver a
// unirse a la reunión) — y ese tooltip puede estar presente en el DOM
// (vía `textContent`, aunque no sea visible — Etapa 29) estando
// genuinamente en-llamada.
// Etapa 41: por eso `rejoin` se SACA de acá (Nivel A, alta confianza, que
// ignora `hasExitButton`) — como palabra suelta en inglés es demasiado
// genérica para ese nivel de confianza. En su momento se razonó que sus
// equivalentes en español (`volver a unirte`/`volver a unirse`, frases de
// varias palabras) eran "mucho menos propensas a aparecer sueltas en un
// tooltip no relacionado" y se dejaron sin cambios en Nivel A — la Etapa
// 79 (ver más abajo) confirmó con Chrome real que esa suposición era
// INCORRECTA: también se degradan.
// Etapa 79 — causa real confirmada con logs de Chrome (panel "Controles
// del anfitrión", texto explicativo de un toggle: "Podrán volver a unirse
// cuando se vuelva a activar la opción", con `hasExitButton=true` y el
// botón "Abandonar la llamada" genuinamente presente en el DOM en
// simultáneo). Exactamente la misma familia de bug que `rejoin`/el
// tooltip de hardware de la Etapa 41 (una frase de "volver a unirse/
// unirte" con sentido AJENO al fin de la llamada — acá, reactivar una
// opción de configuración, no volver a una reunión abandonada), solo que
// esta vez el texto SÍ tenía varias palabras y aun así resultó
// insuficientemente específico. `volver a unirte`/`volver a unirse` se
// sacan de Nivel A por la misma razón exacta que `rejoin`: Nivel A está
// pensado para señales de tan alta confianza que puedan pisar un
// `hasExitButton` "colgado" en el DOM (Etapa 27) — pero acá `hasExitButton`
// no estaba colgado, era una lectura genuina y correcta de "seguís
// en-llamada", y aun así la frase alcanzaba para forzar `'ended'` sin que
// `detectCallStage()` mirara esa señal más confiable ni una sola vez. Se
// dejan sin cambios `volver a la pantalla de inicio`/`volver al inicio`/
// `return to home screen` — sin ningún reporte de colisión, y son frases
// todavía más específicas (no describen una acción reversible de
// "unirse", solo tienen sentido en una pantalla que ya no es la llamada).
const EXIT_ACTION_CHECKS_BY_LANG = {
  en: [['return to home screen', /return to home screen/i]],
  es: [
    ['volver a la pantalla de inicio', /volver a la pantalla de inicio/i],
    ['volver al inicio', /volver al inicio/i],
  ],
};
const EXIT_ACTION_CHECKS = Object.values(EXIT_ACTION_CHECKS_BY_LANG).flat();

// Etapa 41: `rejoin` degradado a confianza "normal" (mismo tratamiento
// que el combo B genérico) — ver el comentario de arriba para el porqué.
// Etapa 79: `volver a unirte`/`volver a unirse` se suman acá, mismo
// criterio exacto. Mismo formato `[label, regex]` y misma lógica de
// idiomas por objeto que `EXIT_ACTION_CHECKS_BY_LANG`, para poder loguear
// cada check por separado igual que los demás — y, al sumarse con OR a
// `exitTextLevelB` en `detectCallStage()`, heredan automáticamente la
// condición `!hasExitButton` de esa rama: con el botón de salir presente
// (el caso reportado en la Etapa 79), esta frase deja de poder producir
// `'ended'` por sí sola, sin importar cuántas veces aparezca en el DOM.
const DOWNGRADED_EXIT_CHECKS_BY_LANG = {
  en: [['rejoin', /\brejoin\b/i]],
  es: [
    ['volver a unirte', /volver a unirte/i],
    ['volver a unirse', /volver a unirse/i],
  ],
};
const DOWNGRADED_EXIT_CHECKS = Object.values(DOWNGRADED_EXIT_CHECKS_BY_LANG).flat();

debugLog('[Sparkle DEBUG] callStage.js cargado — versión Etapa 34 (soporte de español agregado a la detección)');

// Etapa 35: si DEBUG_VERBOSE está activo y NINGÚN aria-label matcheó
// `EXIT_BUTTON_LABEL_REGEX`, se loguean TODOS los aria-label presentes en
// la página en ese momento — es la forma concreta de confirmar en la
// consola real cuál es el texto exacto que usa Meet para el botón de
// salir en un idioma/variante todavía no contemplado, sin tener que
// adivinar. En producción (DEBUG_VERBOSE=false) este bloque no hace nada.
function hasExitButton() {
  const candidates = document.querySelectorAll('[aria-label]');
  const allLabels = [];
  for (const el of candidates) {
    const label = el.getAttribute('aria-label') || '';
    if (DEBUG_VERBOSE) allLabels.push(label);
    if (EXIT_BUTTON_LABEL_REGEX.test(label)) {
      debugLog('[Sparkle DEBUG] hasExitButton=true — matcheó aria-label:', JSON.stringify(label));
      return true;
    }
  }
  debugLog(
    '[Sparkle DEBUG] hasExitButton=false — ningún aria-label matcheó. Todos los aria-label presentes en la página (para identificar el texto real del botón de salir si falta una variante):',
    allLabels
  );
  return false;
}

// Devuelve 'lobby' | 'in-call' | 'ended' | 'undetermined'.
//
// Etapa 27 — dos niveles de confianza para "salida", no uno solo: se
// encontró (reproducido en Node, ver DOCUMENTACION.md) que Meet puede
// dejar el elemento del botón de "salir de la llamada" todavía en el DOM
// (con su aria-label intacto) durante la transición hacia la pantalla de
// salida — con la regla original ("solo es 'ended' si NO hay botón de
// salir"), eso bastaba para que una pantalla de salida real quedara
// clasificada como 'undetermined', y combinado con el sticky state de la
// Etapa 26 (que ignora 'undetermined'), el panel se quedaba pegado en
// 'in-call' para siempre en vez de pasar a 'ended'.
//   - Nivel A (alta confianza — puede pisar un botón de salir "colgado"):
//     las frases de acción de `EXIT_ACTION_CHECKS` ("Return to home
//     screen", "Volver a la pantalla de inicio", etc.) son texto de
//     interfaz específico de la pantalla de salida — no es plausible que
//     aparezcan como subtítulo o texto suelto durante una llamada real en
//     curso. Si matchea cualquiera de estas, el resultado es 'ended' sin
//     importar `hasExitButton` — EXCEPTO si también hay señal de lobby
//     (`lobbyText`): se encontró (Etapa 31) que algunas variantes del
//     lobby también contienen alguna de estas frases de acción, y sin
//     este resguardo el lobby se clasificaba como 'ended' en la
//     primerísima evaluación, sin que hiciera falta ningún sticky state
//     de por medio.
//   - Nivel B (confianza normal — se mantiene la regla original): la
//     combinación genérica "sustantivo de reunión + verbo de fin" (ej.
//     "left the meeting") SÍ podría, en teoría, aparecer en un subtítulo
//     durante una llamada real (alguien contando que "se fue de la
//     reunión anterior") — para este nivel se sigue exigiendo que NO haya
//     botón de salir presente, igual que desde la Etapa 18. Etapa 41:
//     `rejoin` (EN) se sumó a este nivel — como palabra suelta resultó
//     demasiado genérica para el Nivel A (ver `DOWNGRADED_EXIT_CHECKS_BY_LANG`
//     más arriba y la Etapa 41 en DOCUMENTACION.md para el caso real que
//     lo motivó: un tooltip de ayuda de hardware, no relacionado con el
//     estado de la llamada, que también contiene la palabra "rejoin").
// Etapa 29: `innerText` depende de que el navegador haya terminado un
// pase de layout/pintado para ese contenido (respeta `display:none`,
// visibilidad, etc.) — a diferencia de `textContent`, que es una
// operación pura sobre el árbol del DOM, sin ninguna dependencia de
// layout. Se combinan los dos: si `innerText` está temporalmente
// incompleto porque el layout todavía no se actualizó, `textContent`
// igual va a tener el texto nuevo de inmediato. Ver DOCUMENTACION.md
// para el detalle de por qué se sospecha que esto era la causa real de
// que la transición no se reflejara sola en el panel.
// Etapa 43: factoreado a su propia función (antes vivía inline dentro de
// `detectCallStage()`) para que `resolveSticky()` pueda medir la
// longitud del texto de forma independiente, sin duplicar la lógica de
// combinación — ver el fix de la condición de carrera más abajo.
function getCombinedText() {
  return `${document.body.innerText || ''}\n${document.body.textContent || ''}`;
}

export function detectCallStage() {
  debugLog('[Sparkle DEBUG] === detectCallStage() ejecutando ===');

  const text = getCombinedText();
  debugLog(
    '[Sparkle DEBUG] texto combinado innerText+textContent (primeros 500 chars):',
    JSON.stringify(text.slice(0, 500))
  );

  const exitButton = hasExitButton();
  debugLog('[Sparkle DEBUG] check hasExitButton (aria-label de "salir de la llamada" presente):', exitButton);

  // Etapa 78: se loguea el contexto del match de `lobbyText` con el mismo
  // criterio que ya se usaba para Nivel A/B más abajo — ver el comentario
  // largo de esa función (`logMatchContext`) para el porqué. Antes de esta
  // etapa, `lobbyText` solo logueaba el booleano, así que un falso
  // positivo de lobby (que bloquea tanto la rama de 'ended' de Nivel A
  // como la de 'in-call') no tenía forma de diagnosticarse sin inspeccionar
  // el DOM a mano.
  const lobbyText = LOBBY_TEXT_REGEX.test(text);
  debugLog('[Sparkle DEBUG] check lobbyText:', lobbyText);
  if (lobbyText) logMatchContext(LOBBY_TEXT_REGEX, text, 'lobbyText');

  debugLog('[Sparkle DEBUG] --- checks individuales de "salida" ---');

  // Etapa 40: cuando un check da `true`, además de loguear el booleano se
  // loguea el CONTEXTO real donde matcheó — 50 caracteres antes y después
  // de la posición del match dentro del `text` COMPLETO (no solo los
  // primeros 500 chars que loguea la línea de arriba). El texto combinado
  // puede tener miles de caracteres (paneles de configuración, lista de
  // participantes, tooltips ocultos que `textContent` sí captura aunque
  // no sean visibles — ver el comentario de la Etapa 29 sobre
  // `innerText`+`textContent`), así que un match puede estar ocurriendo
  // muy lejos del inicio del string, fuera del fragmento que ya se
  // logueaba. Sin esto, confirmar CUÁL elemento de la UI disparó el match
  // implicaba adivinar o inspeccionar el DOM a mano — con esto queda en
  // el log directamente. Factoreado a una función reusable (Etapa 41,
  // ampliada en la Etapa 78 para además cubrir el combo B genérico, que
  // hasta acá solo logueaba el booleano — justo el hueco de diagnóstico
  // que hizo falta cerrar para el reporte de la Etapa 78: dos paneles de
  // Meet completamente distintos ("Personas" y "Controles del anfitrión")
  // disparando el mismo falso positivo apunta a un combo B genérico
  // matcheando en ALGÚN lugar del texto combinado, no a un texto propio de
  // ninguno de los dos paneles — sin poder ver DÓNDE matchea exactamente,
  // no hay forma de confirmarlo ni de corregirlo con precisión).
  function logMatchContext(regex, fullText, label) {
    if (!DEBUG_VERBOSE) return;
    // `regex.exec` en vez de reusar el resultado de un `.test()` previo
    // porque `.test()` no expone la posición del match — ninguno de estos
    // regex tiene flag `g`, así que `exec` siempre arranca desde el
    // principio del string (sin estado de `lastIndex` que arrastrar entre
    // llamadas).
    const detail = regex.exec(fullText);
    if (!detail) return;
    const start = Math.max(0, detail.index - 50);
    const end = Math.min(fullText.length, detail.index + detail[0].length + 50);
    debugLog(
      `[Sparkle DEBUG]     ↳ contexto del match de "${label}" (50 chars antes/después, posición ${detail.index} de ${fullText.length}):`,
      JSON.stringify(fullText.slice(start, end))
    );
  }

  function evaluateChecksWithContext(checks, levelLabel) {
    return checks.map(([label, regex]) => {
      const match = regex.test(text);
      debugLog(`[Sparkle DEBUG]   frase de acción "${label}" (${levelLabel}):`, match);
      if (match) logMatchContext(regex, text, label);
      return match;
    });
  }

  const combo1 = MEETING_ENDED_ORDER1_REGEX.test(text);
  debugLog('[Sparkle DEBUG]   combo "reunión/meeting ... verbo de fin" (orden 1, nivel B):', combo1);
  if (combo1) logMatchContext(MEETING_ENDED_ORDER1_REGEX, text, 'combo orden 1 (nivel B)');
  const combo2 = MEETING_ENDED_ORDER2_REGEX.test(text);
  debugLog('[Sparkle DEBUG]   combo "verbo de fin ... reunión/meeting" (orden 2, nivel B):', combo2);
  if (combo2) logMatchContext(MEETING_ENDED_ORDER2_REGEX, text, 'combo orden 2 (nivel B)');

  const actionResults = evaluateChecksWithContext(EXIT_ACTION_CHECKS, 'nivel A');
  const exitTextLevelA = actionResults.some(Boolean);

  // Etapa 41: `rejoin` (y cualquier otro check que se degrade a futuro) se
  // evalúa acá, con el mismo peso que el combo B genérico — solo suma a
  // `exitTextLevelB`, así que hereda automáticamente la exigencia de
  // `!hasExitButton` de esa rama en `result` más abajo, sin necesitar
  // lógica extra.
  const downgradedResults = evaluateChecksWithContext(DOWNGRADED_EXIT_CHECKS, 'nivel B degradado');
  const downgradedExitText = downgradedResults.some(Boolean);

  const exitTextLevelB = combo1 || combo2 || downgradedExitText;

  debugLog('[Sparkle DEBUG] exitText nivel A (frases de acción, ignora hasExitButton):', exitTextLevelA);
  debugLog(
    '[Sparkle DEBUG] exitText nivel B (combo genérico + checks degradados, requiere !hasExitButton):',
    exitTextLevelB
  );

  // Etapa 36 — bug de prioridad entre hasExitButton y el combo B: la
  // condición de 'in-call' exigía, además de `hasExitButton`, que
  // `!exitTextLevelB` también fuera cierto. La intención original (ver
  // comentario de Nivel B más arriba) era que el combo B "requiere
  // !hasExitButton" para producir 'ended' — es decir, hasExitButton ya
  // alcanza por sí solo para invalidar el combo B como señal de salida,
  // no hacía falta ADEMÁS exigirlo del lado de 'in-call'. Con la
  // condición vieja, un caso real (reportado con logs de Chrome:
  // `hasExitButton=true` durante una llamada en curso en español, con
  // `exitTextLevelB=true` en simultáneo — ver el detalle en
  // DOCUMENTACION.md) no caía en NINGUNA de las cuatro ramas: no en la
  // primera (nivel A en false), no en la segunda (nivelB en true la
  // bloqueaba), no en la tercera (exige `!hasExitButton`, y acá es true), no en
  // la cuarta (exige `lobbyText`, y acá es false) — quedaba en el `else`
  // final, 'undetermined', pese a que `hasExitButton` (la señal más
  // específica y confiable de estar en-llamada: un botón real de colgar
  // en el DOM) ya alcanzaba para resolverlo sin ambigüedad. El fix: sacar
  // `!exitTextLevelB` de la condición de 'in-call' — el combo B pasa a
  // ser irrelevante en presencia de `hasExitButton`, tal como ya decía el
  // comentario de diseño original.
  //
  // El orden de evaluación (nivel A primero) se mantiene sin cambios: sigue
  // siendo intencional que las frases de acción de alta confianza del Nivel
  // A puedan pisar un `hasExitButton` "colgado" en el DOM durante la
  // transición real hacia la pantalla de salida (Etapa 27) — ese
  // comportamiento ya está validado en Chrome real (Etapa 31/32) y no es el
  // bug reportado acá, así que no se toca.
  // Etapa 83 — esperando que el anfitrión admita a la persona: gana sobre
  // todo lo demás, incluido el botón de salir, que Meet ahora también
  // muestra en esa pantalla (ver `WAITING_FOR_HOST_TEXT_PATTERNS`).
  const waitingForHost = WAITING_FOR_HOST_TEXT_REGEX.test(text);
  debugLog('[Sparkle DEBUG] check waitingForHost:', waitingForHost);
  if (waitingForHost) logMatchContext(WAITING_FOR_HOST_TEXT_REGEX, text, 'waitingForHost');

  let result;
  if (waitingForHost) {
    result = 'lobby';
  } else if (exitTextLevelA && !lobbyText) {
    result = 'ended';
  } else if (exitButton && !lobbyText) {
    result = 'in-call';
  } else if (exitTextLevelB && !exitButton) {
    result = 'ended';
  } else if (lobbyText && !exitButton) {
    result = 'lobby';
  } else {
    result = 'undetermined';
  }

  debugLog('[Sparkle DEBUG] → resultado final de detectCallStage():', result);
  return result;
}

// --- Sticky state (Etapa 26) ---------------------------------------
//
// El problema real: dentro de una misma pantalla ("You've ended the
// meeting for everyone"), Meet sigue teniendo elementos que cambian solos
// (ej. un contador regresivo "X seconds left" antes de cerrar la pestaña),
// y cada uno de esos cambios dispara una reevaluación por el
// MutationObserver. En algún instante intermedio de esas actualizaciones,
// el texto visible puede no matchear ninguna señal clara todavía (ej. a
// mitad de un re-render del contador) y `detectCallStage()` devuelve
// 'undetermined' — que antes de esta etapa se propagaba tal cual a
// App.jsx, y como el fallback de un resultado ambiguo es el flujo normal
// (Welcome/TeacherPanel/StudentPanel), el panel "parpadeaba" de vuelta a
// Welcome aunque el usuario siguiera literalmente en la misma pantalla.
//
// La solución: una vez que se detecta un estado CONCLUYENTE ('lobby',
// 'in-call' o 'ended') para un `meetingCode` puntual, ese resultado
// queda "pegado" en memoria (variables de módulo, no `chrome.storage` —
// no hace falta persistir esto entre recargas, solo entre reevaluaciones
// dentro de la misma sesión de la pestaña) y una reevaluación posterior
// que dé 'undetermined' NO lo pisa — se sigue devolviendo el último
// estado concluyente. Solo una reevaluación que dé un resultado
// CONCLUYENTE distinto (una transición real, ej. 'in-call' → 'ended')
// actualiza el estado pegado. El estado se resetea por completo cuando
// cambia el `meetingCode` (nueva reunión), para no arrastrar el estado de
// una llamada a la siguiente dentro de la misma pestaña — recordar que el
// content script de Meet NO se reinicia al navegar entre reuniones (es
// una SPA), así que sin este reset el módulo seguiría "recordando" el
// meetingCode anterior indefinidamente.
// Etapa 43 — condición de carrera en la evaluación inicial bajo latencia/
// CPU alta: la rama de "meetingCode nuevo" de abajo hacía `stickyStage =
// raw` SIN NINGUNA protección, a diferencia de las reevaluaciones
// siguientes (que sí ignoran un `raw` de `'undetermined'` y mantienen
// el último estado concluyente). En condiciones normales esto no se nota
// porque para cuando `watchCallStage()` hace su primera evaluación, Meet
// ya renderizó bastante contenido — pero con throttling de red/CPU (caso
// reportado: Slow 4G + CPU 4x), esa primera evaluación puede correr sobre
// un DOM todavía casi vacío (React de Meet ni empezó a pintar el mensaje
// de la sala de espera), y ese `'undetermined'` (o, en teoría, incluso
// un match "conclusivo" por casualidad sobre texto residual/parcial)
// quedaba pegado como el estado "inicial" — que en App.jsx cae al flujo
// normal (Welcome) en vez de esperar a que el DOM termine de renderizar.
//
// El fix: una ventana de gracia de `INITIAL_WINDOW_MS` desde que se fija
// un `meetingCode` nuevo, durante la cual una evaluación con texto
// "sospechosamente corto" (`< MIN_RELIABLE_TEXT` caracteres, sin contar
// espacios en los bordes) NO se toma como definitiva — se descarta esa
// lectura puntual y se espera a la siguiente (MutationObserver o el
// polling de respaldo de 1.5s, ver `watchCallStage()`), en vez de pegar
// un resultado basado en contenido incompleto. El umbral (100 caracteres)
// es deliberadamente conservador: incluso la pantalla más minimalista de
// Meet con contenido real ya renderizado supera esa longitud varias veces
// (botones, texto oculto de accesibilidad, chrome de la página) — el
// objetivo es distinguir "todavía no renderizó nada" de "ya renderizó
// algo, aunque sea un estado con poco texto visible", no afinar un umbral
// exacto por estado.
const MIN_RELIABLE_TEXT = 100;
const INITIAL_WINDOW_MS = 1000;

let stickyMeetingCode = null;
let stickyStage = 'undetermined';
// Etapa 43: timestamp (`Date.now()`) de cuándo se fijó `stickyMeetingCode`
// — define el inicio de la ventana de gracia de arriba. `null` hasta la
// primera evaluación de una reunión.
let stickySince = null;
// Etapa 43: separado de "¿es meetingCode nuevo?" — con el fix, la primera
// evaluación *confiable* (la que realmente fija el estado "inicial" y
// dispara su log) puede no coincidir con la primera evaluación *recibida*
// para este meetingCode, si las primeras vinieron con texto sospechosamente
// corto y se descartaron.
let hadInitialStage = false;
// Etapa 77: ver el comentario largo más abajo, junto a donde se usa —
// marca que una lectura CRUDA ya dio 'ended' viniendo de un
// `stickyStage` de 'in-call', pero todavía sin confirmar en una segunda
// lectura consecutiva.
let pendingEndedConfirmation = false;
// Etapa 83 — cuándo empezó una racha de lecturas 'in-call' viniendo de
// 'lobby', todavía sin confirmar (ver el comentario junto a donde se usa), o
// `null` si no hay ninguna en curso.
let pendingInCallSince = null;
const LOBBY_TO_IN_CALL_CONFIRM_MS = 2500;

function resolveSticky(meetingCode) {
  if (meetingCode !== stickyMeetingCode) {
    debugLog(
      `[Sparkle DEBUG] sticky: meetingCode cambió (${JSON.stringify(stickyMeetingCode)} → ${JSON.stringify(
        meetingCode
      )}) — se reinicia el estado pegado.`
    );
    stickyMeetingCode = meetingCode;
    stickyStage = 'undetermined';
    stickySince = Date.now();
    hadInitialStage = false;
    pendingEndedConfirmation = false;
    pendingInCallSince = null;
  }

  if (!hadInitialStage && Date.now() - stickySince < INITIAL_WINDOW_MS) {
    const text = getCombinedText();
    const length = text.trim().length;
    if (length < MIN_RELIABLE_TEXT) {
      debugLog(
        `[Sparkle DEBUG] sticky: evaluación dentro de la ventana inicial (primer segundo) con texto sospechosamente corto (${length} < ${MIN_RELIABLE_TEXT} chars) — se descarta esta lectura, se espera la próxima evaluación.`
      );
      return stickyStage;
    }
  }

  const raw = detectCallStage();

  if (!hadInitialStage) {
    stickyStage = raw;
    hadInitialStage = true;
    // Etapa 30: único log SIN el flag DEBUG_VERBOSE de esta función — se
    // mantiene siempre encendido (con prefijo [Sparkle], no [Sparkle
    // DEBUG]) porque es un evento puntual (una vez por reunión), no ruido
    // repetido en cada poll de 1.5s.
    console.log(`[Sparkle] Estado de llamada inicial: ${stickyStage} (meetingCode=${meetingCode})`);
    return stickyStage;
  }

  if (raw === 'undetermined') {
    debugLog(
      `[Sparkle DEBUG] sticky: resultado bruto ambiguo ('undetermined') — se IGNORA y se mantiene el último estado concluyente: '${stickyStage}'.`
    );
    return stickyStage;
  }

  // Etapa 83 — al tocar "Ask to join", Meet pasa por una pantalla de
  // transición ("Connecting…") que ya tiene el botón de colgar pero todavía
  // no el texto de espera al anfitrión: durante 1-2 s eso se lee 'in-call' y
  // el panel mostraba Welcome antes de volver a "Esperando…" (visto en
  // Chrome real). Viniendo de 'lobby', entonces, 'in-call' se pega recién si
  // se sostiene `LOBBY_TO_IN_CALL_CONFIRM_MS` sin que otra lectura
  // concluyente se interponga. Un 'undetermined' en el medio no corta la
  // racha (se ignora arriba). Costo aceptado: al entrar de verdad desde la
  // sala de espera, el panel tarda ~2,5-4 s (hasta el próximo poll) en
  // mostrar el contenido de la llamada. Se descartó reconocer esa pantalla
  // por texto ("Connecting…"): un texto así escondido adentro de la llamada
  // dejaría a alguien trabado en "Esperando" para siempre; esta espera, en
  // cambio, siempre termina.
  if (raw === 'in-call' && stickyStage === 'lobby') {
    if (pendingInCallSince === null) pendingInCallSince = Date.now();
    const heldMs = Date.now() - pendingInCallSince;
    if (heldMs < LOBBY_TO_IN_CALL_CONFIRM_MS) {
      debugLog(`[Sparkle DEBUG] sticky: 'lobby' → 'in-call' sin confirmar todavía (${heldMs}ms) — se mantiene 'lobby'.`);
      return stickyStage;
    }
  }
  pendingInCallSince = null;

  // Etapa 77 — segunda capa de defensa (independiente del fix de
  // `ENDED_VERB_WORDS.es` de arriba) contra un reporte puntual: con Meet
  // en español, abrir el panel "Personas" desde el ícono de participantes
  // hacía que Sparkle mostrara "Llamada finalizada" en pleno medio de una
  // llamada real en curso. La transición 'in-call' → 'ended' es la más
  // delicada de las tres que maneja este módulo (reemplaza el panel activo
  // por una pantalla de "Llamada finalizada" — un salto visual mucho más
  // disruptivo que, por ejemplo, quedarse un instante de más en
  // 'undetermined'), y es también la única de las cuatro ramas de
  // `detectCallStage()` que puede resolverse en base a una señal negativa
  // frágil (`!botonSalir`, Nivel B) — un panel lateral que se monta (con
  // contenido nuevo: tooltips, texto de accesibilidad) puede disparar una
  // reevaluación del `MutationObserver` en un instante puntual donde el
  // DOM todavía no terminó de asentarse, sin que la llamada haya terminado
  // realmente.
  //
  // Mismo criterio que la ventana de gracia de la Etapa 43 ("no confiar en
  // una única lectura sospechosa, esperar la próxima"), aplicado acá
  // puntualmente a esta transición: la PRIMERA lectura cruda que da
  // 'ended' viniendo de un `stickyStage` de 'in-call' NO se pega todavía
  // — se guarda como "pendiente de confirmar" y se sigue devolviendo
  // 'in-call'. Solo si una lectura POSTERIOR (la próxima reevaluación —
  // debounce de 300ms del observer, o el poll de respaldo de 1.5s) vuelve
  // a dar 'ended' de nuevo, sin que ninguna lectura distinta se haya
  // interpuesto en el medio, se confirma la transición. Una salida real de
  // Meet reemplaza toda la pantalla de forma estable, así que sigue dando
  // 'ended' en esa segunda lectura sin más costo que esa demora mínima
  // (ya aceptada en otras partes de este archivo); un falso positivo
  // transitorio, en cambio, no sobrevive a ella. Acotado a esta transición
  // puntual — 'lobby'→'ended' y el resto de las combinaciones no se tocan,
  // no hay ningún reporte de que sean un problema.
  if (raw === 'ended' && stickyStage === 'in-call') {
    if (!pendingEndedConfirmation) {
      pendingEndedConfirmation = true;
      debugLog(
        `[Sparkle DEBUG] sticky: posible transición 'in-call' → 'ended' detectada, todavía sin confirmar (Etapa 77) — se mantiene 'in-call' y se espera la próxima reevaluación.`
      );
      return stickyStage;
    }
    debugLog(`[Sparkle DEBUG] sticky: transición 'in-call' → 'ended' CONFIRMADA en una segunda lectura consecutiva.`);
  } else {
    pendingEndedConfirmation = false;
  }

  if (raw !== stickyStage) {
    // Etapa 30: mismo criterio que arriba — este es el log que de verdad
    // importa ver en producción (una transición real de estado), así que
    // queda siempre encendido, sin depender de DEBUG_VERBOSE.
    console.log(`[Sparkle] Estado de llamada cambió: ${stickyStage} → ${raw} (meetingCode=${meetingCode})`);

    stickyStage = raw;
  } else {
    debugLog(`[Sparkle DEBUG] sticky: resultado bruto confirma el estado ya pegado ('${stickyStage}').`);
  }

  return stickyStage;
}

const DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 1500;

// Etapa 28 — la detección de texto en sí funcionaba bien (confirmado con
// los logs de la Etapa 27); el problema era que la transición real de
// "en-llamada" a "salida" no siempre disparaba una reevaluación: hacía
// falta un evento manual (cambiar de pestaña y volver) para que se
// corrigiera. Investigación:
//   1. El mecanismo era un único `MutationObserver`, ya sobre
//      `document.body` (no un contenedor interno más específico) con
//      `{ childList: true, subtree: true }` — es decir, solo reacciona a
//      que se AGREGUEN o SAQUEN nodos del árbol.
//   2. La hipótesis de "Meet reemplaza el contenedor observado" no
//      aplica: como ya observábamos `document.body` (la raíz estable de
//      toda la página), no hay ningún nodo intermedio que perder. La
//      causa más probable es la otra cara del mismo problema: Meet muy
//      probablemente señaliza esta transición puntual actualizando
//      TEXTO de nodos ya existentes o ATRIBUTOS (una clase que
//      muestra/oculta, un `aria-live`, etc.) en vez de agregar/sacar
//      nodos completos — mutaciones de tipo `characterData` y
//      `attributes`, que la config anterior directamente no observaba
//      (`childList`/`subtree` no las capturan). Esto también explica por
//      qué cambiar de pestaña "arreglaba" el problema: `visibilitychange`
//      dispara que Meet vuelva a pintar/reconciliar partes de su UI al
//      recuperar el foco, lo cual de casualidad sí produce alguna
//      mutación de `childList` que el observer anterior alcanzaba a ver
//      — un efecto secundario indirecto, no una solución real.
//   3. Sin acceso a un Chrome real no se puede confirmar con certeza
//      absoluta CUÁL de los dos tipos de mutación es el que falta (texto
//      o atributos, o ambos) — en vez de apostar a una sola, el fix
//      amplía el observer para escuchar los tres tipos a la vez
//      (`childList` + `characterData` + `attributes`), y se lo refuerza
//      con listeners explícitos y un polling de respaldo (ver abajo), en
//      vez de depender de un solo mecanismo.
//
// Suscribe un callback al estado actual (llamado de inmediato) y de nuevo
// cada vez que el DOM cambia de forma relevante, con el mismo debounce de
// 300ms de la Etapa 18 para el camino del MutationObserver — los otros
// dos mecanismos nuevos (eventos de ciclo de vida y polling) reevalúan de
// inmediato, sin debounce, porque no son continuos como las mutaciones
// del DOM. Igual que desde la Etapa 24, todo queda acotado a la vida de
// quien llama a `watchCallStage`: App.jsx desconecta observer, listeners
// e interval al desmontarse, que es cuando se sale de la llamada según
// `meetContext.js` — nunca queda nada corriendo de más.
//
// `meetingCode` (Etapa 26) es la clave del sticky state — ver más arriba.
export function watchCallStage(callback, meetingCode) {
  debugLog('[Sparkle DEBUG] watchCallStage() suscrito — evaluación inicial:');
  callback(resolveSticky(meetingCode));

  // --- Mecanismo 1: MutationObserver ampliado (childList + characterData
  // + attributes), con el mismo debounce de 300ms de siempre — evita
  // recalcular en cada mutación individual durante una llamada activa,
  // donde ahora hay bastante más ruido (subtítulos, contadores) al sumar
  // characterData/attributes. ---
  let timeoutId = null;
  const reevaluateDebounced = () => {
    timeoutId = null;
    debugLog('[Sparkle DEBUG] watchCallStage() re-evaluando tras mutación del DOM (debounce 300ms):');
    callback(resolveSticky(meetingCode));
  };

  const observer = new MutationObserver(() => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(reevaluateDebounced, DEBOUNCE_MS);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });

  // --- Mecanismo 2: listeners explícitos de ciclo de vida de la página.
  // `visibilitychange` es justo el evento que, indirectamente, ya
  // "arreglaba" el problema al cambiar de pestaña — acá se escucha de
  // forma directa e inmediata, sin depender de un efecto secundario
  // casual del observer. Se suma `focus` en la ventana como refuerzo
  // (cubre volver de otra ventana del sistema operativo, no solo de otra
  // pestaña del navegador). Sin debounce: son eventos puntuales, no una
  // ráfaga continua como las mutaciones del DOM. ---
  const reevaluateImmediate = (origin) => {
    debugLog(`[Sparkle DEBUG] watchCallStage() re-evaluando por evento "${origin}":`);
    callback(resolveSticky(meetingCode));
  };
  const handleVisibilityChange = () => reevaluateImmediate('visibilitychange');
  const handleFocus = () => reevaluateImmediate('focus');
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleFocus);

  // --- Mecanismo 3: polling de respaldo. Red de seguridad final — si
  // por algún motivo ni el observer ampliado ni los listeners de arriba
  // llegan a capturar una transición real (ej. una ráfaga continua de
  // mutaciones que nunca deja pasar los 300ms de debounce sin actividad),
  // el estado se corrige solo dentro de, como mucho, POLL_INTERVAL_MS —
  // sin depender de que el usuario haga nada manual. Deliberadamente NO
  // es el mecanismo principal (por eso corre cada 1.5s y no, por ejemplo,
  // cada 200ms): es la red de contención, no el primer intento. ---
  const intervalId = setInterval(() => {
    debugLog(`[Sparkle DEBUG] watchCallStage() re-evaluando por poll de respaldo (cada ${POLL_INTERVAL_MS}ms):`);
    callback(resolveSticky(meetingCode));
  }, POLL_INTERVAL_MS);

  return () => {
    if (timeoutId) clearTimeout(timeoutId);
    observer.disconnect();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleFocus);
    clearInterval(intervalId);
  };
}
