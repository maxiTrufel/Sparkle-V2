import { useEffect, useRef, useState } from 'react';

// Alerta grupal de atención (docente) — ventana deslizante TEMPORAL: si el
// `qThresholdTeacher`% o más de los últimos `windowSecondsTeacher` segundos de
// historial grupal estuvieron con menos de `P`% de la clase atenta, dispara
// una notificación, con cooldown de re-notificación. Misma arquitectura de
// fondo que `useFatigueAlert.js` (el equivalente del lado del alumno) pero
// sobre el ROSTER agregado en vez de una sola predicción individual — cada
// "captura" acá es un `attention_roster_updated` real (un tick nuevo de
// `hooks/useLiveAttention.js`), no un timer propio.
//
// Pedido explícito posterior — reemplazo de `N_doc` (racha de snapshots
// grupales desatentos SEGUIDOS) por una ventana deslizante en SEGUNDOS
// (`windowSecondsTeacher`/`qThresholdTeacher`), no en cantidad de capturas: con
// `N_doc`, un solo snapshot "grupo atento" en el medio (ej. un instante
// donde justo se reconectó un alumno) reseteaba toda la racha a cero, sin
// importar cuánto tiempo llevara la clase mayormente desatenta. Ahora se
// guarda un buffer de `{ ts, pctAttentive }` por cada snapshot dentro
// de los últimos `windowSecondsTeacher` segundos (recortado también por un
// timer propio, no solo cuando llega un roster nuevo — la ventana es de
// TIEMPO, tiene que "vaciarse sola" con el reloj, no solo cuando hay
// eventos nuevos) y se dispara si la proporción de esos snapshots que
// resultan "grupo desatento" supera `qThresholdTeacher`.
//
// `P` decide, para cada snapshot, si ESE instante puntual cuenta como
// "grupo desatento" — comparación directa contra el % de ATENTOS
// (`pctAttentive < P*100`, auditoría de 2026-08-11 contra la Tabla 2 de la
// tesis: P es la fracción atenta mínima, no la desatenta; antes de esa
// auditoría este mismo corte comparaba la fracción DESatenta con `>=`,
// sentido opuesto — misma fórmula que `backend/src/ws/attentionState.js`
// y `hooks/useAttentionHistory.js`, corregidas en el mismo cambio). Esa
// clasificación se hace en el momento de LEER el buffer
// (`groupInattentiveRatio`, más abajo), no al guardarlo — Corrección
// (auditoría de P, 2026): antes se guardaba ya clasificado, así que un
// cambio de P sin ningún roster nuevo de por medio dejaba los snapshots
// viejos con la clasificación vieja. Ahora P reclasifica el buffer ENTERO
// al instante, igual que ya hacían V_doc/Q_doc. `C_doc` (cooldown) sigue
// siendo el único gate de cuándo puede REAPARECER la alerta, nunca de si
// el buffer sigue midiendo.
//
// A diferencia de `useFatigueAlert.js` (alumno), acá NO hay recuperación
// automática (un tramo de "grupo atento" no cierra la alerta sola) — eso
// tampoco cambió: el pedido explícito para esta alerta sigue siendo que
// solo se cierre a mano (`closeAlert`, los dos botones de
// `ui/GroupAttentionAlert.jsx`), momento en el que arranca el cooldown.
//
// Clasificación atento/desatento — nunca reclasifica con ningún Y del
// docente (esa variable se sacó por completo del proyecto, ver
// `ui/TeacherAttentionSettingsPanel.jsx`) — cuenta directo el booleano
// `inattentive` que cada alumno ya manda con SU PROPIO Y
// (`offscreen/detector.js`). `concentration` no interviene acá para nada.
export function useGroupAttentionAlert(roster, {
  pThreshold = 0.45, windowSecondsTeacher = 120, qThresholdTeacher = 0.7, cooldownSeconds = 120,
  classStarted = false, connected = false, hasActiveQuestion = false,
} = {}) {
  // Buffer de snapshots dentro de la ventana vigente — `{ ts, pctAttentive }`,
  // más reciente al final. Reemplaza a la vieja `racha`.
  const [buffer, setBuffer] = useState([]);
  const [alertVisible, setAlertVisible] = useState(false);
  // Timestamp de cuándo ARRANCÓ el cooldown vigente, o `null` — mismo
  // criterio que `useFatigueAlert.js`: se guarda el INICIO, nunca el FIN, y
  // `cooldownUntil` (abajo) se deriva en cada render a partir del
  // `cooldownSeconds` VIGENTE — así, cambiar C_doc a mitad de un cooldown
  // ya en curso lo recalcula solo, sin esperar a que se agote el valor
  // viejo.
  const [cooldownStartedAt, setCooldownStartedAt] = useState(null);

  const cooldownUntil = cooldownStartedAt !== null
    ? cooldownStartedAt + cooldownSeconds * 1000
    : null;

  const prevAlertVisibleRef = useRef(false);

  // Cuándo arrancó la ventana de observación ACTUAL — `null` si el buffer
  // está vacío (todavía no llegó ningún roster, o se acaba de vaciar vía
  // `closeAlert`/una desconexión total que dejó el buffer sin nada).
  // Independiente del contenido del buffer a propósito: `buffer[0].ts` (la
  // entrada más vieja que sigue vigente) NO sirve para esto — el podado
  // (efecto de más abajo, y el filtro inline de cada push) saca cualquier
  // entrada apenas se pone más vieja que `windowSecondsTeacher`, así que en
  // régimen continuo la entrada más vieja del buffer casi nunca llega a
  // tener esa edad (se poda un instante antes) — comparar contra ella
  // dejaría esta guarda prácticamente siempre en `false`, no solo al
  // arrancar. Este ref, en cambio, se pone en `Date.now()` una única vez
  // cuando el buffer pasa de vacío a tener algo, y se mantiene fijo
  // mientras el buffer siga con datos — sin importar cuánto pode el
  // efecto de abajo.
  const observationStartRef = useRef(null);
  useEffect(() => {
    if (buffer.length === 0) {
      observationStartRef.current = null;
    } else if (observationStartRef.current === null) {
      observationStartRef.current = Date.now();
    }
  }, [buffer.length]);

  // Si `windowSecondsTeacher` cambia a mitad de sesión, el reloj tiene que
  // arrancar de cero con la ventana nueva — sin esto, un cambio hacia una
  // ventana más CORTA podía dejar `observationStartRef` apuntando a un
  // inicio viejo cuyo tiempo transcurrido ya alcanza para "completar" la
  // ventana nueva de inmediato, disparando la alerta con tiempo acumulado
  // de ANTES del cambio, no con datos observados bajo la ventana vigente.
  // Solo pone `null` — no lo reinicia directamente a `Date.now()` acá:
  // mientras no entre ningún snapshot nuevo, no hay nada real que decir
  // sobre "desde cuándo" se está observando bajo la ventana nueva. En
  // cuanto llegue el próximo roster (`buffer.length` cambia), el efecto de
  // arriba nota la ref en `null` con el buffer no vacío y la vuelve a
  // poner en `Date.now()` — recién ahí arranca de verdad el reloj de la
  // ventana nueva.
  useEffect(() => {
    observationStartRef.current = null;
  }, [windowSecondsTeacher]);

  // Registra cada roster REALMENTE nuevo (`roster` cambia de referencia en
  // cada `attention_roster_updated`, ver `useLiveAttention.js`) en el
  // buffer, ya recortado a la ventana de `windowSecondsTeacher` segundos.
  //
  // Corrección (auditoría de P) — bug real: acá se guardaba `groupInattentive`
  // ya CLASIFICADO (booleano, resuelto contra el `pThreshold` vigente en ese
  // instante) en vez de la proporción cruda. Como el efecto depende solo de
  // `[roster]` (a propósito, para no reinterpretar snapshots pasados ante
  // CADA render), un cambio aislado de P sin ningún roster nuevo de por
  // medio dejaba los snapshots YA guardados con la clasificación VIEJA — el
  // panel decía "las cuatro variables se aplican en tiempo real", pero P
  // era la única que en realidad no. Ahora se guarda `pctAttentive`
  // (el número crudo, 0-100) SIN clasificar todavía; la clasificación real
  // pasa a `groupInattentiveRatio`, más abajo, que se recalcula en CADA
  // render con el `pThreshold` vigente — así P reclasifica el buffer
  // ENTERO al instante, igual que ya hacían V_doc/Q_doc/C_doc.
  //
  // Pedido explícito posterior — REVIERTE el criterio de "roster vacío
  // diluye hacia atento": antes, un instante sin NINGÚN alumno con cámara
  // encendida igual se guardaba en el buffer (con `inattentiveFraction:
  // null`, que `groupInattentiveRatio` nunca contaba como "grupo
  // desatento" pero SÍ sumaba al denominador — "diluía" la proporción hacia
  // atento). Ahora ese instante directamente NO ENTRA al buffer: sin nadie
  // monitoreado no hay nada que decir sobre "la clase" en ese momento, ni a
  // favor ni en contra. Esto también resuelve, de yapa, que el buffer nunca
  // arranca a acumular hasta que hay al menos un alumno con cámara (antes,
  // arrancaba desde el primer roster —vacío o no— apenas se unía el
  // docente).
  useEffect(() => {
    if (roster.length === 0) return;
    const now = Date.now();
    const pctAttentive = (roster.filter((student) => !student.inattentive).length / roster.length) * 100;

    setBuffer((prev) => {
      const cutoff = now - windowSecondsTeacher * 1000;
      return [...prev, { ts: now, pctAttentive }].filter((e) => e.ts >= cutoff);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster]);

  // La ventana es de TIEMPO, no de cantidad de eventos — tiene que
  // "vaciarse sola" con el reloj real, no solo cuando llega un roster
  // nuevo (si el roster deja de actualizarse por un rato, un snapshot
  // viejo "grupo desatento" no puede quedar contando para siempre). Podado
  // inmediato al montar/cambiar `windowSecondsTeacher` (por si baja a mitad
  // de sesión) + un timer de 1s que sigue podando mientras tanto.
  useEffect(() => {
    const prune = () => {
      setBuffer((prev) => {
        const cutoff = Date.now() - windowSecondsTeacher * 1000;
        const next = prev.filter((e) => e.ts >= cutoff);
        return next.length === prev.length ? prev : next;
      });
    };
    prune();
    const interval = setInterval(prune, 1000);
    return () => clearInterval(interval);
  }, [windowSecondsTeacher]);

  // Proporción de snapshots "grupo desatento" dentro de la ventana vigente
  // — clasifica CADA entrada del buffer con el `pThreshold` VIGENTE en este
  // render (no el que estaba activo cuando ese snapshot se guardó), así P
  // reclasifica el buffer entero al instante ante cualquier cambio de
  // slider, mismo criterio que ya tenían V_doc/Q_doc/C_doc. `pctAttentive <
  // pThreshold * 100` — comparación directa contra el % de atentos
  // (auditoría de 2026-08-11 contra la Tabla 2 de la tesis: P es la
  // fracción atenta mínima, `<` estricto — antes comparaba la fracción
  // desatenta con `>=`, sentido opuesto).
  //
  // `pctAttentive !== null` — defensivo, ya no debería poder darse
  // (el efecto de arriba ya no guarda ninguna entrada con roster vacío,
  // pedido explícito posterior — ver ese comentario), pero se deja el
  // chequeo explícito por las dudas: nunca confiar en que otro cambio
  // futuro en el efecto de arriba mantenga ese invariante sin avisar acá
  // (si algo lo rompiera, `<` con `null` haría una coerción a `0` y daría
  // `true` por accidente con cualquier P > 0%).
  //
  // `0` con el buffer vacío, nunca `NaN`.
  const groupInattentiveRatio = buffer.length > 0
    ? buffer.filter((e) => e.pctAttentive !== null && e.pctAttentive < pThreshold * 100).length / buffer.length
    : 0;

  // Disparo de la alerta — gateado por cooldown, igual que antes con la
  // racha. Sin recuperación automática (pedido explícito, sin cambios):
  // una vez visible, se queda visible hasta que `closeAlert` la cierre a
  // mano, sin importar qué pase con la proporción mientras tanto. `>`
  // estricto contra `qThresholdTeacher` — mismo criterio de corte que el resto
  // del sistema (el empate exacto no alcanza) para esta variable; `P`, más
  // arriba, usa `<` estricto contra el % de atentos (auditoría de P,
  // 2026-08-11).
  // Bug real (mismo principio que la corrección análoga en
  // `useFatigueAlert.js`, ver ese archivo) — la alerta grupal aparecía
  // "demasiado rápido" al arrancar la clase: `groupInattentiveRatio` se
  // calcula sobre `buffer.length` (los snapshots que HAY ahora), sin
  // importar si eso son varios minutos de historial o apenas el primer
  // snapshot que llegó. Con un solo alumno conectado y su primera lectura
  // "desatento" (perfectamente normal recién arrancada la clase), ese único
  // snapshot ya es el 100% de la ventana. Acá la ventana es de TIEMPO, no
  // de cantidad fija (no hay un `k`) — "completa" se mide contra
  // `observationStartRef` (ver más arriba), NUNCA contra la antigüedad de
  // `buffer[0]` (el podado la mantiene siempre "casi, pero no tanto" vieja
  // como la ventana, así que esa comparación nunca se cumpliría en régimen
  // continuo — ver el comentario de ese ref para el detalle completo).
  //
  // Con timer PROPIO (no solo reaccionando a `[groupInattentiveRatio,
  // ...]`) — a diferencia de `useFatigueAlert.js` (donde `buffer.length`
  // cambia con cada predicción nueva, cada ~`X` segundos, y ESO ya alcanza
  // para reevaluar), acá la ventana puede volverse "completa" en un
  // instante en el que NINGÚN roster nuevo llegó (ej. un solo alumno
  // conectado, sin más snapshots por un rato) — sin este timer, el momento
  // exacto en que `observationStartRef` cumple `windowSecondsTeacher` podía
  // pasar sin que este efecto se volviera a evaluar nunca, dejando la
  // alerta sin disparar hasta el próximo roster real. 1s, mismo intervalo
  // que ya usa el podado de más arriba.
  // Pedido explícito posterior (punto 3) — guard EXPLÍCITO de `classStarted`
  // acá mismo, mismo criterio que `useFatigueAlert.js`: nunca confiar en un
  // invariante indirecto para decidir si corresponde disparar.
  //
  // Pedido explícito posterior (punto 4) — `hasActiveQuestion` (viaja desde
  // `App.jsx`, `activeQuestion` de `useLiveQuestions`): sería ilógico
  // sugerirle al docente "lanzá una pregunta" mientras ya hay una en curso.
  // Solo bloquea que la alerta se DISPARE de nuevo — si ya estaba visible
  // de antes (ej. el docente lanzó la pregunta por el botón normal
  // "Generar pregunta", no por el de esta alerta), sigue visible hasta que
  // se cierre a mano: esta alerta nunca tuvo cierre automático (pedido
  // explícito anterior, ver el comentario grande del archivo), y esto no le
  // suma uno nuevo.
  useEffect(() => {
    function evaluate() {
      if (!classStarted) return;
      if (hasActiveQuestion) return;
      const start = observationStartRef.current;
      const windowComplete = start !== null && Date.now() - start >= windowSecondsTeacher * 1000;
      if (!windowComplete) return;
      if (groupInattentiveRatio <= qThresholdTeacher) return;
      if (cooldownUntil !== null) return;
      setAlertVisible(true);
    }
    evaluate();
    const interval = setInterval(evaluate, 1000);
    return () => clearInterval(interval);
  }, [groupInattentiveRatio, qThresholdTeacher, cooldownUntil, windowSecondsTeacher, classStarted, hasActiveQuestion]);

  // Cuenta el cooldown con un timer real — depende de `cooldownUntil`
  // (derivado) y no de `cooldownStartedAt` directamente, por el mismo
  // motivo que `useFatigueAlert.js`: así, cambiar C_doc con el cooldown ya
  // en curso reprograma el timeout con el tiempo restante correcto según el
  // nuevo valor, en vez de agotar el presupuesto viejo.
  useEffect(() => {
    if (cooldownUntil === null) return undefined;
    const remainingMs = cooldownUntil - Date.now();
    const timeout = setTimeout(() => setCooldownStartedAt(null), Math.max(0, remainingMs));
    return () => clearTimeout(timeout);
  }, [cooldownUntil]);

  // Arma el cooldown al CERRAR la alerta (transición `true -> false`,
  // detectada con un ref) — arranca al cerrarla, nunca al aparecer.
  useEffect(() => {
    if (prevAlertVisibleRef.current && !alertVisible) {
      setCooldownStartedAt(Date.now());
    }
    prevAlertVisibleRef.current = alertVisible;
  }, [alertVisible]);

  // Vacía el buffer al cerrar a mano — mismo motivo que el equivalente en
  // `useFatigueAlert.js`: evita que, apenas termine el cooldown recién
  // armado, la MISMA ventana (todavía mayormente desatenta) reabra la
  // alerta de inmediato. Reemplaza al viejo `setRacha(0)`.
  const closeAlert = () => {
    setAlertVisible(false);
    setBuffer([]);
  };

  // Pedido explícito posterior — tres resets más, cada uno con su propia
  // señal y su propio alcance (mismo criterio que los de
  // `useFatigueAlert.js`: refs para detectar la TRANSICIÓN, nunca resetear
  // en cada render mientras la condición se mantenga).
  const fullReset = () => {
    setBuffer([]);
    setAlertVisible(false);
    setCooldownStartedAt(null);
  };

  // La clase se detiene (`classStarted: true → false`) — reset completo
  // (buffer, alerta y cooldown): al reiniciar tiene que ser como una clase
  // nueva.
  const prevClassStartedRef = useRef(classStarted);
  useEffect(() => {
    if (prevClassStartedRef.current && !classStarted) fullReset();
    prevClassStartedRef.current = classStarted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classStarted]);

  // El docente reconecta (`connected: false → true`, ver `wsConnected` en
  // `App.jsx`) — reset completo, igual que si fuera una conexión nueva.
  const prevConnectedRef = useRef(connected);
  useEffect(() => {
    if (!prevConnectedRef.current && connected) fullReset();
    prevConnectedRef.current = connected;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Todos los alumnos apagan la cámara (`roster` pasa a tener 0 elementos,
  // habiendo tenido alguno antes) — a diferencia de los dos de arriba, acá
  // SOLO se vacía el buffer (no la alerta ni el cooldown): una alerta ya
  // disparada, o un cooldown en curso, no dejan de tener sentido solo
  // porque momentáneamente nadie tiene la cámara prendida. El buffer sí se
  // vacía de una en vez de esperar a que el podado de más arriba lo baje a
  // cero de a poco: sin nadie monitoreado no queda nada real que seguir
  // podando. Complementa al efecto de arriba que ya no deja ENTRAR
  // instantes vacíos al buffer (pedido explícito) — este es el que saca lo
  // que ya había entrado antes de quedarse sin nadie.
  const prevHasStudentsRef = useRef(roster.length > 0);
  useEffect(() => {
    const hasStudents = roster.length > 0;
    if (prevHasStudentsRef.current && !hasStudents) setBuffer([]);
    prevHasStudentsRef.current = hasStudents;
  }, [roster.length]);

  return { alertVisible, closeAlert };
}
