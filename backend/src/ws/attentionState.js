const meetingRepository = require('../repositories/meetingRepository');
const attentionSnapshotRepository = require('../repositories/attentionSnapshotRepository');
const { resolveAttentionMode } = require('../constants/attentionModes');

// Estado EN MEMORIA del monitoreo de atención en vivo (panel del docente) —
// mismo criterio que `rooms.js` para "quién está conectado" o
// `questionTimers.js` para el vencimiento de una pregunta: un dato que
// cambia cada pocos segundos por alumno, sin ningún valor histórico en SÍ
// MISMO, así que el último valor de cada alumno NUNCA se persiste acá. Se
// pierde al reiniciar el backend o cuando el último alumno se va —
// comportamiento correcto, no una limitación: no hay ninguna consulta
// "concentración de este alumno hace una hora" que dependa de esto.
//
// Pedido explícito posterior — esto YA NO es el único destino de estos
// datos: cada 10 segundos (`SNAPSHOT_INTERVAL_MS`, más abajo),
// `evaluateSnapshotsStart()` (más abajo) toma una FOTO AGREGADA del
// grupo (no por alumno) de cada reunión con alumnos monitoreados y la
// persiste en `attention_snapshots` — esa sí es la base histórica real
// (`ConcentrationStats.jsx`), independiente de este `Map`.
//
// meetingCode -> Map<anonId, { type, concentration, inattentive, noFaceFraction, ts, name }>
// `inattentive` es SIEMPRE boolean, nunca `null` — regla global "sin rostro =
// desatento" (ver `handlers.js#handleAttentionSnapshot`, que la fuerza a
// `true` para `type: 'no_face'`). `concentration` sí puede ser `null`
// para ese mismo caso: es una medición que el modelo nunca calculó, algo
// distinto de la clasificación atento/desatento.
//
// Confirmado — pedido explícito posterior: un alumno con la cámara de
// atención APAGADA nunca entra a este `Map`, ni "atento" ni "desatento" —
// `updateState` (más abajo) es la ÚNICA vía de entrada, y solo la
// llama `handleAttentionSnapshot` (`handlers.js`) en respuesta al mensaje
// WS `attention_snapshot`, que el alumno manda SOLO mientras
// `cameraActive` es `true` (`frontend/src/hooks/useAttentionBroadcast.js`).
// Un alumno sin cámara activa (o que todavía no se sumó a la clase) no
// tiene ninguna entrada acá — no hace falta "filtrarlo" de
// `calculateAndPersistSnapshot`, `roster.length`/`attentiveCount`/`noFaceCount`
// más abajo YA excluyen a cualquiera sin cámara por construcción, nunca por un
// chequeo explícito. `removeState` (mismo criterio, en respuesta a
// `attention_stopped`) es la salida — mientras el alumno tenga la cámara
// prendida sigue contando con su ÚLTIMO valor conocido, nunca con un
// estado "sin cámara" propio.
const attentionStateByMeeting = new Map();

// meetingCode -> [{ pctAttentive, pctNoFace, totalStudents }, ...] — una
// muestra por cada `updateState` (cada actualización de roster) desde el
// último flush de `calculateAndPersistSnapshot`, que las promedia y vacía
// el array. Corrección — pedido explícito posterior: antes cada snapshot
// de 10s tomaba una FOTO PUNTUAL de `getSnapshot(meetingCode)` en el
// instante exacto del tick, mientras que `ConcentrationStats.jsx` arma su
// curva "en vivo" promediando TODAS las actualizaciones de roster que
// llegaron durante esos mismos 10s — dos criterios distintos para el mismo
// dato, que producían formas de curva distintas entre lo que el docente
// veía en vivo y lo que se releía tras un F5. Este acumulador replica el
// criterio del cliente del lado del servidor, para que ambos calculen lo
// mismo.
const windowSamplesByMeeting = new Map();

// Porcentajes del grupo en el instante ACTUAL (no promediados todavía) —
// una muestra individual para `windowSamplesByMeeting`. Misma fórmula que
// usaba antes `calculateAndPersistSnapshot` directo sobre el roster, pedida
// acá aparte para poder llamarla en cada `updateState`, no solo cada 10s.
function computeGroupStats(meetingCode) {
  const roster = getSnapshot(meetingCode);
  if (roster.length === 0) return null;
  const total = roster.length;
  const attentiveCount = roster.filter((student) => !student.inattentive).length;
  const noFaceCount = roster.filter((student) => student.concentration === null).length;
  return {
    pctAttentive: (attentiveCount / total) * 100,
    pctNoFace: (noFaceCount / total) * 100,
    totalStudents: total,
  };
}

function updateState(meetingCode, anonId, data) {
  if (!attentionStateByMeeting.has(meetingCode)) attentionStateByMeeting.set(meetingCode, new Map());
  attentionStateByMeeting.get(meetingCode).set(anonId, data);

  // Una muestra más para la ventana en curso — ver el comentario de
  // `windowSamplesByMeeting` más arriba.
  const stats = computeGroupStats(meetingCode);
  if (stats) {
    if (!windowSamplesByMeeting.has(meetingCode)) windowSamplesByMeeting.set(meetingCode, []);
    windowSamplesByMeeting.get(meetingCode).push(stats);
  }

  // Cada snapshot de un alumno es la señal de "hay alguien monitoreado
  // ahora" — el disparador natural para evaluar si corresponde arrancar el
  // intervalo periódico de esta reunión (ver `evaluateSnapshotsStart` más
  // abajo). No hace falta ningún gancho en "empezar clase": si la clase
  // todavía no está activa cuando llega este primer snapshot, la próxima
  // llamada (~10s después, cadencia de `useAttentionBroadcast.js`) vuelve a
  // evaluarlo solo, sin ningún estado adicional que mantener.
  evaluateSnapshotsStart(meetingCode).catch((err) => {
    console.error(
      `[Sparkle] Error evaluando el arranque del intervalo de snapshots de atención de "${meetingCode}":`,
      err.message
    );
  });
}

function removeState(meetingCode, anonId) {
  const map = attentionStateByMeeting.get(meetingCode);
  if (!map) return;
  map.delete(anonId);
  if (map.size === 0) {
    attentionStateByMeeting.delete(meetingCode);
    windowSamplesByMeeting.delete(meetingCode);
    // Sin nadie monitoreado, no tiene sentido seguir con el intervalo
    // corriendo en segundo plano — mismo criterio de "resetear cuando el
    // conteo de cámaras activas vuelve a cero" que ya usa el buffer de
    // alerta grupal del lado del frontend (`useGroupAttentionAlert.js`).
    stopSnapshots(meetingCode);
  }
}

// Snapshot en el orden de inserción nativo del `Map` (JS lo garantiza) —
// estable entre llamadas sucesivas mientras no cambien los alumnos
// presentes, para que el docente no vea la lista reordenarse sola en cada
// actualización de un solo alumno.
function getSnapshot(meetingCode) {
  const map = attentionStateByMeeting.get(meetingCode);
  if (!map) return [];
  return [...map.entries()].map(([anonId, data]) => ({ anonId, ...data }));
}

// Valor de PRODUCCIÓN — snapshot histórico del grupo cada 10 segundos,
// persistido en `attention_snapshots` (`scripts/init-db.js`). Se probó
// bajarlo a 1 segundo durante desarrollo (máxima granularidad para
// verificar el pipeline completo end-to-end con clases cortas de prueba) y
// se revirtió a este valor — a 1s, cada reunión activa insertaba una fila
// POR SEGUNDO (3600/hora), un volumen de escritura innecesario para
// `attention_snapshots`, que no tiene job de purga ni particionado (ver
// `scripts/init-db.js`). A 10s el volumen es considerablemente más liviano
// (360 filas/hora por reunión activa) sin perder demasiada resolución para
// el mapa de calor/línea temporal de `ConcentrationStats.jsx`.
const SNAPSHOT_INTERVAL_MS = 10 * 1000;

// meetingCode -> Timeout del `setInterval` de snapshots de ESA reunión —
// a diferencia de la primera versión (un único timer global recorriendo
// todas las reuniones en cada tick), ahora hay un intervalo POR reunión,
// que arranca y se destruye siguiendo el ciclo de vida real de la clase
// (ver `evaluateSnapshotsStart`/`stopSnapshots` más abajo) en vez de
// quedar corriendo de fondo para siempre desde que arranca el proceso.
const intervalsByMeeting = new Map();

const average = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

// Calcula Y persiste el snapshot de UNA reunión — única fuente de verdad
// de esta fórmula, pedida explícitamente, sin duplicarla en ningún otro
// lado:
//   pct_attentive    = promedio de `pctAttentive` de las muestras
//     acumuladas en `windowSamplesByMeeting` durante los últimos 10s (no
//     una foto puntual — ver el comentario de `windowSamplesByMeeting`,
//     más arriba, para el porqué).
//   pct_no_face      = mismo criterio, promedio de `pctNoFace`.
//   group_inattentive = se calcula UNA sola vez sobre el `pctAttentive` ya
//     promediado (nunca por muestra individual) — mismo criterio que
//     `ConcentrationStats.jsx` (bug real corregido ahí: promediar
//     `groupInattentive` booleano por muestra desalinea el color del punto
//     del valor que el punto en sí grafica).
//
// `pThreshold` — el backend no tiene acceso al P que el docente puede haber
// ajustado a mano en su propio panel de debug (esa variable es 100%
// local, nunca viaja al servidor, ver `App.jsx#groupAlertConfig`) — se
// usa el P del MODO de clase vigente para esta reunión
// (`meetings.attention_mode_id`, resuelto vía `resolveAttentionMode`),
// que es el único P que el servidor puede conocer con certeza.
//
// Doble chequeo de `state.active` — además del corte explícito que hace
// `stopSnapshots` en cuanto la clase termina (`handlers.js`,
// `handleEndClass`/`handleTeacherDisconnection`), esto es una red de
// seguridad DENTRO del propio tick: si por lo que sea el intervalo siguió
// vivo con la clase ya terminada (una carrera puntual, un camino de fin de
// clase que no pasó por ese gancho), el propio tick se autodestruye acá en
// vez de insertar un snapshot "post-clase" y seguir corriendo indefinido.
async function calculateAndPersistSnapshot(meetingCode) {
  const samples = windowSamplesByMeeting.get(meetingCode) || [];
  windowSamplesByMeeting.set(meetingCode, []); // arranca la próxima ventana en limpio

  if (samples.length === 0) {
    // Sin actualizaciones de roster en esta ventana (ej. nadie con la
    // cámara activa) — no hay nada que promediar, mismo criterio que
    // `ConcentrationStats.jsx`: no inventa un valor, no persiste este tick.
    // Igual hay que confirmar si el roster sigue vacío para saber si
    // corresponde parar el intervalo (en la práctica ya se detiene apenas
    // se vacía, ver `removeState` — esto queda como resguardo).
    if (getSnapshot(meetingCode).length === 0) stopSnapshots(meetingCode);
    return;
  }

  const state = await meetingRepository.getClassState(meetingCode);
  if (!state?.active) {
    stopSnapshots(meetingCode);
    return;
  }

  const { pThreshold } = resolveAttentionMode(state.attention_mode_id).teacher;
  const pctAttentive = average(samples.map((s) => s.pctAttentive));
  const pctNoFace = average(samples.map((s) => s.pctNoFace));
  // P (pThreshold) es la fracción ATENTA mínima — comparación directa
  // contra `pctAttentive`, sin complemento (auditoría de 2026-08-11 contra
  // la Tabla 2 de la tesis; antes P representaba la fracción DESatenta
  // mínima, ver `backend/src/constants/attentionModes.js`).
  const groupInattentive = pctAttentive < pThreshold * 100;

  await attentionSnapshotRepository.insertSnapshot(meetingCode, {
    pctAttentive,
    pctNoFace,
    totalStudents: samples[samples.length - 1].totalStudents,
    groupInattentive,
  });
}

// Evalúa si corresponde ARRANCAR el intervalo de esta reunión — se llama
// desde `updateState` cada vez que llega un snapshot de un alumno
// (aprox. cada 10s por alumno mientras tenga la cámara activa, ver
// `useAttentionBroadcast.js`). Condición exacta pedida: la clase está
// activa (`meetings.active`, `meetingRepository.getClassState`) Y hay al
// menos un alumno monitoreado (`attentionStateByMeeting`, el mismo roster
// que ya usa todo el resto de este archivo — ningún flag nuevo).
//
// Esto también es lo que hace que el intervalo se "reanude" solo si el
// docente se reconecta a una clase que ya estaba en curso: reconectarse no
// dispara ningún evento propio del lado del servidor (`getClassState`
// sigue devolviendo `active=true`, ver el comentario de `handleJoin` en
// `handlers.js`), pero los alumnos con la cámara activa siguen mandando
// snapshots solos — el próximo que llegue vuelve a pasar por acá y
// encuentra `active=true` + roster no vacío, sin necesitar ningún gancho
// extra atado a la reconexión del docente.
async function evaluateSnapshotsStart(meetingCode) {
  if (intervalsByMeeting.has(meetingCode)) return; // ya está corriendo
  if (getSnapshot(meetingCode).length === 0) return; // sin roster, nada que arrancar

  const state = await meetingRepository.getClassState(meetingCode);
  if (!state?.active) return; // la clase no está iniciada — no arranca

  // Re-chequeo tras el `await` de arriba — evita una carrera donde el
  // roster se vació (o el intervalo ya arrancó por otro snapshot en
  // paralelo) mientras se esperaba la consulta a la base.
  if (intervalsByMeeting.has(meetingCode)) return;
  if (getSnapshot(meetingCode).length === 0) return;

  // Alineación de fase — pedido explícito posterior: antes el intervalo
  // arrancaba su propia cuenta de `SNAPSHOT_INTERVAL_MS` desde "ahora"
  // (el instante en que llegó este primer snapshot de roster), con una fase
  // totalmente independiente de la que arma `ConcentrationStats.jsx` del
  // lado del cliente al sembrar su curva — dos grillas de 10s desalineadas
  // para el mismo dato. `attention_window_started_at` (fijado en
  // `services/classService.js#startClass`, el mismo gatillo que el cliente
  // usa para resetear su historial) es el ancla común: acá se calcula
  // cuánto falta para el PRÓXIMO múltiplo de `SNAPSHOT_INTERVAL_MS` desde
  // ese ancla, y el primer tick se difiere hasta ahí — de ahí en más el
  // `setInterval` normal ya queda en fase. Sin ancla persistida todavía
  // (reunión vieja, anterior a este cambio), cae a "ahora" — mismo
  // comportamiento que antes, sin alinear.
  const windowStartedAt = await meetingRepository.getAttentionWindowStart(meetingCode);
  const anchor = windowStartedAt ? new Date(windowStartedAt).getTime() : Date.now();
  const elapsed = Date.now() - anchor;
  const msUntilNextBoundary = SNAPSHOT_INTERVAL_MS
    - (((elapsed % SNAPSHOT_INTERVAL_MS) + SNAPSHOT_INTERVAL_MS) % SNAPSHOT_INTERVAL_MS);

  // `.unref()` — mismo criterio que el resto de los timers de
  // mantenimiento de este proyecto (`questionTimers.js`, el heartbeat de
  // `ws/index.js`): nunca debe ser la razón por la que el proceso (o un
  // archivo de test) se quede colgado sin poder salir solo. Ocupa el mismo
  // slot de `intervalsByMeeting` que el `setInterval` final (`clearInterval`
  // limpia igual un `Timeout` de `setTimeout` que uno de `setInterval` en
  // Node) — evita que un segundo snapshot de roster, mientras este
  // `setTimeout` todavía no disparó, arranque un segundo timer en paralelo.
  const startTimeout = setTimeout(() => {
    calculateAndPersistSnapshot(meetingCode).catch((err) => {
      console.error(
        `[Sparkle] Error persistiendo el snapshot de atención grupal de "${meetingCode}":`,
        err.message
      );
    });
    const interval = setInterval(() => {
      calculateAndPersistSnapshot(meetingCode).catch((err) => {
        console.error(
          `[Sparkle] Error persistiendo el snapshot de atención grupal de "${meetingCode}":`,
          err.message
        );
      });
    }, SNAPSHOT_INTERVAL_MS);
    interval.unref();
    intervalsByMeeting.set(meetingCode, interval);
  }, msUntilNextBoundary);
  startTimeout.unref();
  intervalsByMeeting.set(meetingCode, startTimeout);
}

// Detiene y limpia el intervalo de esta reunión, si había uno corriendo —
// se llama al vaciarse el roster (`removeState`), al terminar la clase
// (llamada externa, más abajo) y como resguardo dentro del propio
// tick (`calculateAndPersistSnapshot`). Nunca deja un `Timeout` huérfano:
// `clearInterval` + sacarlo del `Map` es siempre atómico acá adentro.
function stopSnapshots(meetingCode) {
  const interval = intervalsByMeeting.get(meetingCode);
  if (!interval) return;
  clearInterval(interval);
  intervalsByMeeting.delete(meetingCode);
}

// Exportada para que `handlers.js` la llame justo después de
// `classService.endClassManual`/`endClassAutomatic`
// (`handleEndClass`/`handleTeacherDisconnection`), el mismo instante en
// que `meetings.active` pasa a `FALSE`. No hace falta esperar a que el
// roster se vacíe solo (los alumnos recién apagan la cámara cuando les
// llega el broadcast `class_ended`, con latencia de red de por medio) —
// esto corta el intervalo de inmediato, sin dejarlo corriendo ese rato de
// más con una clase ya terminada.
module.exports = {
  updateState, removeState, getSnapshot, stopSnapshots,
};
