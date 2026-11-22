import { useEffect, useRef, useState } from 'react';

// Ventana deslizante de las últimas `k` capturas + alerta privada del
// alumno, con cooldown de re-notificación. Separado de `useAttentionDetection`
// a propósito: ese hook administra el ciclo de vida del documento offscreen
// (carga, calentamiento, error) y no sabe nada de "qué porcentaje de las
// últimas capturas estuvo desatento" ni de mostrar una alerta — esto es
// lógica de producto pura sobre el `attention` que ese hook ya expone.
//
// Privacidad: esto corre enteramente en el árbol de React de ESTE alumno, en
// SU pestaña — no hay ningún mensaje que salga hacia el docente ni hacia
// ningún backend (mismo criterio de privacidad que `useAttentionDetection`).
//
// El cooldown vive ACÁ (no en `App.jsx`) porque es la MISMA decisión que ya
// toma este hook ("¿corresponde mostrar la alerta ahora?"), solo con una
// condición más — separarlo en `App.jsx` obligaría a ese componente a
// reimplementar/espiar el estado interno de esta máquina de estados en vez
// de solo consumir su resultado.
//
// Pedido explícito posterior — reemplazo de la racha (`N`) por ventana
// deslizante (`K`/`Q`): antes, la alerta se disparaba con `N` lecturas
// "desatento" SEGUIDAS, y se recuperaba sola con `N` lecturas "atento"
// SEGUIDAS — un solo momento de atención en el medio de una racha larga
// reseteaba todo el conteo a cero. Ahora se guarda un buffer con las
// últimas `k` capturas (`buffer`, más abajo — no un contador, la secuencia
// completa) y la alerta se dispara/recupera según la PROPORCIÓN de
// capturas desatentas dentro de esa ventana, comparada contra `qThreshold`: un
// alumno que estuvo atento la mayor parte del tiempo, con algún parpadeo
// puntual de desatención, ya no dispara nada — hace falta que la ventana en
// conjunto esté mayormente desatenta.
//
// Corrección (auditoría de P, aplicada acá también) — bug real: el buffer
// guardaba `attention.inattentive` YA clasificado (booleano, resuelto contra
// el `Y` vigente en el momento de esa lectura) en vez de la `concentration`
// cruda. Si el alumno cambiaba Y, las lecturas ya guardadas quedaban con la
// clasificación vieja — mismo patrón que tenía P del lado del docente antes
// de corregirlo. Ahora se guarda `{ concentration, forcedInattentive }` SIN
// clasificar todavía, y `isInattentive()` (más abajo) reclasifica cada
// entrada con el `threshold` (Y) VIGENTE en cada render — así Y reclasifica el
// buffer entero al instante, igual que ya hacían K/Q/C.
//
// Matiz — a diferencia de P (una clasificación que SOLO existía acá, sin
// ninguna otra autoridad), `attention.inattentive` es el resultado que
// `offscreen/detector.js` calculó de verdad, en otro contexto de ejecución,
// con el Y que tenía vigente en ESE instante — reclasificar acá con el `Y`
// actual de React (`attentionConfig.threshold` en `App.jsx`) confía en que ese
// valor coincide con lo que el detector aplicó de verdad. Gracias a la
// reconciliación de `App.jsx#enviarConfiguracionAtencion` (auditoría de Y
// anterior), esa coincidencia es casi siempre exacta — solo puede
// desalinearse por una ventana de milisegundos mientras un cambio de Y
// viaja hacia el detector.
// Pedido explícito posterior — grace period de calentamiento (puntos 7/10):
// aunque `offscreen/detector.js` ya estructuralmente no puede emitir NINGUNA
// lectura (`no_face` ni `prediction`) antes de que su propia ventana de
// 10s esté completa (`ventanaCompleta` ahí — confirmado por lectura de
// código, no supuesto), este guard es del lado del CLIENTE, independiente de
// confiar en eso: ninguna lectura entra al buffer de `K` hasta que pasaron
// 10s reales desde que `cameraActive` pasó a `true`, sea cual sea lo que el
// modelo haya devuelto en el medio. Mismo valor que el propio calentamiento
// del modelo (`offscreen/detector.js`, ventana de 10s) — no una perilla de
// producto nueva, así que va como constante fija, no como parámetro.
const GRACE_PERIOD_MS = 10000;

export function useFatigueAlert(attention, {
  // Y = 0.5: punto de operación validado del modelo (antes 0.6, cambiado el
  // 2026-08-01). Ver `backend/src/constants/attentionModes.js`.
  //
  // K/Q/C = preset "Por Defecto" (`ATTENTION_MODES[1].student` en
  // `backend/src/constants/attentionModes.js`) — mismo criterio que el
  // fallback de `attentionConfig` en `App.jsx` (única llamada real a este
  // hook, que siempre pasa los cuatro explícitos; estos defaults del
  // parámetro solo cubrirían un llamador que no los pase). Antes eran
  // 30/0.8/90s: no correspondían a ningún preset y violaban C=ventana
  // (auditoría de fallbacks, 2026-08-11). Si el preset "Por Defecto" cambia
  // en attentionModes.js, actualizar estos tres valores a mano ACÁ TAMBIÉN
  // (no hay import directo — backend y frontend son paquetes separados sin
  // build compartido).
  threshold = 0.5, k = 90, qThreshold = 0.75, cooldownSeconds = 180, classStarted = false, cameraActive = false,
} = {}) {
  // Buffer de capturas SIN clasificar todavía — `{ concentration,
  // forcedInattentive }`, más reciente al FINAL. Es el único estado que
  // reemplaza a la vieja pareja `contador`/`contadorRecuperacion`: acá no
  // hace falta un segundo contador de "racha de recuperación" porque la
  // proporción YA cae sola en cuanto entran suficientes lecturas "atento"
  // nuevas — no es un conteo de rachas, es una foto de las últimas `k`
  // capturas.
  const [buffer, setBuffer] = useState([]);
  const [alertVisible, setAlertVisible] = useState(false);
  // Pedido explícito posterior (punto 13) — cuántas lecturas REALES (ya
  // pasado el grace period) entraron al buffer desde el último reset. A
  // diferencia de `buffer.length` (techado en `k`, nunca dice si ya hubo
  // una "segunda ventana"), este contador crece sin techo — permite
  // distinguir "el buffer se llenó por primera vez" (`totalPredictions ===
  // k`) de "ya se llenó una vez y ahora se está llenando de nuevo"
  // (`totalPredictions >= 2*k`), ver el efecto de disparo más abajo.
  const [totalPredictions, setTotalPredictions] = useState(0);
  // Timestamp (`Date.now()`) de cuándo ARRANCÓ el cooldown vigente, o `null`
  // si no hay uno. Arranca al CERRAR la alerta (ver el efecto "arma el
  // cooldown" más abajo), nunca al aparecer.
  //
  // Corrección — se guarda el INICIO, no el FIN: guardar directamente
  // `Date.now() + cooldownSeconds * 1000` (el fin) "congelaba" el `C` de
  // ese instante para todo el resto del cooldown — si el docente/QA cambiaba
  // `C` a mitad de camino (panel de ajuste, "Aplicar cambios"), el cooldown
  // en curso seguía corriendo con el valor VIEJO hasta agotarse, ignorando
  // el nuevo por completo. Guardando el inicio y derivando `cooldownUntil`
  // (más abajo, calculado en cada render, NUNCA en un `useState` propio) a
  // partir del `cooldownSeconds` VIGENTE, un cambio de `C` se refleja solo
  // en el próximo render — sin ningún efecto extra que lo "reajuste" a mano.
  const [cooldownStartedAt, setCooldownStartedAt] = useState(null);

  // Derivado, no estado — recalculado en cada render a partir del
  // `cooldownSeconds` ACTUAL. Si el nuevo `C` implica que el tiempo ya
  // transcurrido alcanza para cumplirlo, esto ya da un valor en el PASADO
  // (`cooldownUntil <= Date.now()`) de inmediato — es el efecto del timer,
  // más abajo, quien nota ese cambio (está en sus dependencias) y libera la
  // alerta enseguida, sin esperar el resto del timer original.
  const cooldownUntil = cooldownStartedAt !== null
    ? cooldownStartedAt + cooldownSeconds * 1000
    : null;

  const lastProcessedRef = useRef(null);
  // Cuándo pasó `cameraActive` a `true` por última vez — `null` mientras
  // esté apagada. Usado por el grace period de acá abajo (puntos 7/10).
  const cameraActivatedAtRef = useRef(null);
  // Espeja el `alertVisible` del render ANTERIOR — para detectar la
  // transición `true → false` (el momento exacto de "se cerró la alerta",
  // sin importar el motivo) y armar el cooldown ahí, una sola vez.
  const prevAlertVisibleRef = useRef(false);

  // Registra cada captura EVALUABLE en el buffer, recortado a las últimas
  // `k` (`slice` desde el final — la más vieja se cae sola cuando entra una
  // nueva y ya hay `k`). Nunca se pausa por el cooldown (pedido explícito,
  // igual que antes con la racha): el buffer sigue actualizándose en
  // segundo plano haya o no un cooldown vigente, así que apenas termina el
  // cooldown ya hay una foto FRESCA con la que decidir si corresponde
  // mostrar la alerta de nuevo.
  //
  // Se guarda la `concentration` CRUDA, no clasificada — `no_face` no
  // tiene `concentration` (el modelo nunca la calculó, ver
  // `offscreen/detector.js#predecir`), así que se marca con
  // `forcedInattentive: true` en vez de un número (regla global "sin rostro
  // = desatento", independiente de Y). `isEvaluablePhase` incluye ambas
  // fases: una racha larga sin rostro detectado tiene que poder llenar la
  // ventana igual que una racha de desatención con rostro.
  useEffect(() => {
    const isEvaluablePhase = attention.phase === 'active' || attention.phase === 'no_face';
    if (!isEvaluablePhase) return;
    if (attention.lastUpdated === lastProcessedRef.current) return;
    lastProcessedRef.current = attention.lastUpdated;

    // Grace period (pedido explícito, puntos 7/10) — ninguna lectura entra
    // al buffer hasta que pasaron `GRACE_PERIOD_MS` reales desde que se
    // prendió la cámara, sea `no_face` o una `concentration` baja. Se
    // marca igual como "procesada" arriba (`lastProcessedRef`) para no
    // reevaluar la misma lectura de nuevo en el próximo render — solo se
    // descarta, nunca se cuenta.
    const activatedAt = cameraActivatedAtRef.current;
    const inGracePeriod = activatedAt !== null && Date.now() - activatedAt < GRACE_PERIOD_MS;
    if (inGracePeriod) return;

    const entry = attention.phase === 'no_face'
      ? { concentration: null, forcedInattentive: true }
      : { concentration: attention.concentration, forcedInattentive: false };

    setBuffer((prev) => {
      const next = [...prev, entry];
      return next.length > k ? next.slice(next.length - k) : next;
    });
    setTotalPredictions((prev) => prev + 1);
  }, [attention.phase, attention.concentration, attention.lastUpdated, k]);

  // Si `k` baja a mitad de sesión, recorta el buffer YA — sin esto, un
  // buffer armado con el `k` viejo (más grande) seguía de ese tamaño hasta
  // que entraran suficientes capturas nuevas para desplazarlo por sí solo,
  // y la proporción de abajo se calculaba sobre una ventana más ancha que
  // la que el panel dice tener vigente. Si `k` sube, no hace falta nada acá
  // — el buffer ya es más chico que el nuevo tope, y crece solo con las
  // próximas capturas.
  useEffect(() => {
    setBuffer((prev) => (prev.length > k ? prev.slice(prev.length - k) : prev));
  }, [k]);

  // Clasifica una entrada del buffer con el `threshold` (Y) VIGENTE en este
  // render — nunca con el que estaba activo cuando esa captura se guardó,
  // así Y reclasifica el buffer entero al instante ante cualquier cambio de
  // slider. `no_face` es siempre desatento, sin mirar Y (regla global).
  // `<=` estricto — mismo corte que `detector.js#predecir`. Unidades:
  // `concentration` es PORCENTAJE (0-100, ya viene así de `attention`), `Y`
  // es FRACCIÓN (0-1) — de ahí el `* 100`, nunca comparar sin escalar (error
  // de unidades de 100x).
  const isInattentive = (entry) => entry.forcedInattentive || entry.concentration <= threshold * 100;

  // Proporción de capturas desatentas en la ventana vigente — `0` con el
  // buffer vacío (recién empezando, o después de `closeAlert`), nunca
  // `NaN`: sin esto, `0/0` dispararía la alerta con cualquier `qThreshold`
  // (`NaN > qThreshold` es siempre `false`, pero mejor no depender de esa
  // sutileza).
  const inattentiveRatio = buffer.length > 0
    ? buffer.filter(isInattentive).length / buffer.length
    : 0;

  // Disparo Y recuperación de la alerta, unificados en un solo efecto — a
  // diferencia de la racha vieja (que necesitaba un efecto de disparo y
  // OTRO de recuperación, con su propio contador), la ventana deslizante ya
  // es una sola señal continua: mientras la proporción se mantenga por
  // encima de `Q`, la alerta permanece (o aparece, si no hay cooldown
  // vigente); en cuanto cae a `Q` o menos, se cierra sola — el propio
  // deslizamiento del buffer (entran capturas "atento" nuevas, salen las
  // "desatento" viejas) YA es la recuperación, sin necesitar un contador
  // aparte. `>` estricto, nunca `>=` — mismo criterio de corte que el resto
  // del sistema (el empate exacto no alcanza).
  // Bug real — la alerta aparecía "casi inmediatamente" al prender la
  // cámara: `inattentiveRatio` se calcula sobre `buffer.length` (lo que
  // HAY ahora), sin importar si eso son 30 capturas o apenas 1. La primera
  // predicción real de una sesión (justo después del calentamiento de 10s
  // del detector, ver `offscreen/detector.js#procesarCuadro`) es tan válida
  // como cualquier otra, y es perfectamente normal que salga "desatento"
  // (el alumno todavía acomodándose frente a cámara) — con un buffer de 1,
  // esa sola lectura ya es el 100% de la ventana, muy por encima de
  // cualquier `qThreshold` razonable. Mismo principio que ya aplica
  // `detector.js` un nivel más abajo (nunca predice hasta que SU propia
  // ventana de 10s está completa, `ventanaCompleta` ahí): acá se extiende
  // un nivel más arriba — nunca evalúa la proporción hasta que el buffer
  // llegó a tener las `k` capturas completas. Una vez que llega a `k`, se
  // queda ahí para el resto de la sesión (cada entrada nueva desplaza a la
  // más vieja, nunca vuelve a bajar de `k`) — así que esta guarda solo
  // importa al arrancar, o justo después de un `closeAlert()` manual
  // (que vacía el buffer a propósito, ver más abajo).
  // Pedido explícito posterior (punto 3) — guard EXPLÍCITO de `classStarted`
  // acá mismo, donde se decide mostrar la alerta: aunque en la práctica ya
  // es casi imposible llegar acá con la clase detenida (el buffer depende
  // de `cameraActive`, que implica `classStarted`, y el reset de más abajo
  // limpia todo apenas se detiene), este guard lo hace explícito en el
  // único lugar que de verdad importa — nunca confiar en un invariante
  // indirecto para algo tan visible como disparar una alerta.
  //
  // Pedido explícito posterior (punto 13) — `firstWindow`: la primera
  // vez que el buffer llega a `k` (arranque de cámara o cualquier reset)
  // NO dispara, aunque ya supere `Q` — recién a partir de que entraron `k`
  // lecturas reales desde el último reset (`totalPredictions`, ver arriba)
  // se empieza a alertar de verdad. Ojo: SOLO bloquea el camino de
  // DISPARAR — el camino de CERRAR (`else if (alertVisible)`, más abajo)
  // nunca se bloquea con esto, para no dejar una alerta ya visible
  // trabada si `k` cambia a mitad de sesión de un modo que vuelva a hacer
  // `totalPredictions < k` verdadero otra vez.
  useEffect(() => {
    if (!classStarted) return;
    if (buffer.length < k) return;
    const firstWindow = totalPredictions < k;
    if (inattentiveRatio > qThreshold) {
      if (!firstWindow && cooldownUntil === null) setAlertVisible(true);
      // Cooldown vigente: no reabre todavía — en cuanto el efecto de "fin
      // de cooldown" (más abajo) limpie `cooldownUntil`, ESTE efecto se
      // reevalúa solo (está en sus dependencias) con la proporción VIGENTE
      // en ese instante.
    } else if (alertVisible) {
      setAlertVisible(false);
    }
  }, [inattentiveRatio, qThreshold, cooldownUntil, alertVisible, buffer.length, k, classStarted, totalPredictions]);

  // Cuenta el cooldown con un timer real (no con la cadencia de
  // predicciones — esperar a la próxima predicción podría tardar hasta `X`
  // segundos más de lo necesario en notarlo). Al cumplirse, SOLO limpia
  // `cooldownStartedAt` — es el efecto de arriba quien decide, con el dato
  // fresco, si corresponde mostrar la alerta "en ese momento" o no.
  //
  // Depende de `cooldownUntil` (derivado, ver arriba) — no de
  // `cooldownStartedAt` directamente — a propósito: como `cooldownUntil` ya
  // incorpora el `cooldownSeconds` VIGENTE, un cambio de `C` (con el
  // cooldown ya en curso) hace que este valor cambie AUNQUE
  // `cooldownStartedAt` no se haya tocado — React reprograma el timeout con
  // el tiempo restante correcto según el nuevo `C` (si ya es negativo,
  // `Math.max(0, …)` lo agenda para "ya mismo"), en vez de seguir corriendo
  // con el presupuesto viejo hasta agotarse.
  useEffect(() => {
    if (cooldownUntil === null) return undefined;
    const remainingMs = cooldownUntil - Date.now();
    const timeout = setTimeout(() => setCooldownStartedAt(null), Math.max(0, remainingMs));
    return () => clearTimeout(timeout);
  }, [cooldownUntil]);

  // Arma el cooldown al CERRAR la alerta — se detecta la transición
  // `true → false` de `alertVisible` con un ref (no un efecto separado por
  // cada camino de cierre), para cubrir con la MISMA regla tanto el cierre
  // manual (`closeAlert`, botones "Recuperar contenido"/"Ignorar") como el
  // automático (la proporción de la ventana cayó a `Q` o menos, efecto de
  // más arriba): cualquiera sea el motivo, el cooldown arranca cuando deja
  // de estar visible, nunca cuando aparece. Guarda solo el INICIO
  // (`Date.now()`) — el `cooldownSeconds` vigente en ESE momento no
  // importa acá, se aplica recién al derivar `cooldownUntil` arriba,
  // siempre con el valor más reciente.
  useEffect(() => {
    if (prevAlertVisibleRef.current && !alertVisible) {
      setCooldownStartedAt(Date.now());
    }
    prevAlertVisibleRef.current = alertVisible;
  }, [alertVisible]);

  // Pedido explícito posterior — REVIERTE la decisión de arriba: ahora SÍ
  // hace falta resetear, en dos casos distintos, con `classStarted`/
  // `cameraActive` como señales EXPLÍCITAS (ya no hay que inferir nada de
  // `attention.phase` a ciegas, que es justo lo que antes hacía ambigua la
  // distinción "pausa temporal" vs "se fue de verdad"):
  //
  //   1. La clase se detiene (`classStarted: true → false`) — al
  //      reiniciar, tiene que ser como si fuera una clase nueva.
  //   2. El alumno apaga y vuelve a prender SU cámara (`cameraActive: false
  //      → true`) — el historial de antes de apagarla no es válido para
  //      juzgar el ahora (pudo pasar cualquier cosa mientras estuvo
  //      apagada, sin ninguna captura real de por medio).
  //
  // Cubre buffer, alerta visible Y cooldown en los dos casos — un cooldown
  // que seguía "corriendo" de la sesión anterior no tiene sentido en una
  // sesión que se considera nueva. `cameraActive: true → false` (el
  // apagado en sí) NO dispara nada acá — no hace falta, nada nuevo puede
  // entrar al buffer mientras está apagada (`isEvaluablePhase` más arriba ya
  // lo impide), así que alcanza con resetear recién cuando vuelve a
  // encenderse. El caso 1 (parar la clase) también apaga la cámara
  // automáticamente (`cameraActive` depende de `classStarted`, ver
  // `useCameraPreference.js`), así que en la práctica el caso 2 dispara de
  // nuevo al reanudar — inofensivo, resetear un buffer ya vacío es un
  // no-op.
  // `totalPredictions` (punto 13) también se resetea acá — un reset
  // completo tiene que volver a contar como "primera ventana" otra vez.
  const fullReset = () => {
    setBuffer([]);
    setAlertVisible(false);
    setCooldownStartedAt(null);
    setTotalPredictions(0);
  };

  const prevClassStartedRef = useRef(classStarted);
  useEffect(() => {
    if (prevClassStartedRef.current && !classStarted) fullReset();
    prevClassStartedRef.current = classStarted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classStarted]);

  const prevCameraActiveRef = useRef(cameraActive);
  useEffect(() => {
    if (!prevCameraActiveRef.current && cameraActive) {
      // Marca el arranque del grace period (puntos 7/10) ANTES de
      // resetear -- ambos son consecuencia de la misma transición.
      cameraActivatedAtRef.current = Date.now();
      fullReset();
    }
    prevCameraActiveRef.current = cameraActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive]);

  // Vacía el buffer al cerrar a mano — evita que, apenas termine el
  // cooldown recién armado, la MISMA ventana (todavía mayormente desatenta)
  // reabra la alerta de inmediato: un cierre manual pide "dejame en paz por
  // un rato de verdad", no solo "esperá el cooldown y volvé a mostrarme lo
  // mismo". El cierre AUTOMÁTICO (la proporción ya bajó de `Q` sola, efecto
  // de más arriba) no necesita este vaciado — ahí la ventana ya refleja un
  // estado sano por sí misma.
  const closeAlert = () => {
    setAlertVisible(false);
    setBuffer([]);
    setTotalPredictions(0);
  };

  return {
    inattentiveInWindow: buffer.filter(isInattentive).length,
    k,
    alertVisible,
    closeAlert,
  };
}
