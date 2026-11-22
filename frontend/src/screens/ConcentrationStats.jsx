import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeftIcon, StudentIcon, InfoIcon } from '../ui/icons';
import { AttentionHeatmap } from '../ui/AttentionHeatmap';
import { AttentionTimeline } from '../ui/AttentionTimeline';

// Valor de PRODUCCIÓN — 5 minutos, expresados en segundos (300). Se
// mantiene expresado en SEGUNDOS para que `buildHeatmapSlots`, más abajo,
// siga operando en segundos internamente — evita el error de redondeo de
// derivar segundos desde minutos en el borde de cada balde (ver el
// comentario de `buildTimelinePoints`).
const SECONDS_PER_HEATMAP_SLOT = 300;

// Panel de atención del docente — TODO el contenido es real. `roster`
// (snapshot actual, uno por alumno con la cámara de atención ACTIVA — ver
// el comentario grande de `hooks/useLiveAttention.js` para el porqué un
// alumno sin cámara nunca puede estar acá) y `history` (mapa de calor +
// línea temporal) llegan AMBOS por props desde `App.jsx` — Corrección
// (pedido explícito): `history` antes salía de un `useAttentionHistory`
// montado ACÁ ADENTRO, así que cada vez que el docente entraba/salía de
// esta pantalla (o el docente detenía/reanudaba la clase mientras estaba
// afuera) el hook se remontaba de cero y perdía los puntos "en vivo"
// acumulados. Ahora `hooks/useAttentionHistory.js` vive en `App.jsx`
// (nunca se desmonta por navegación interna del panel) — este componente
// es puramente de lectura sobre lo que le llega.
//
// Clasificación atento/desatento — este panel no tiene su propio Y (esa
// variable, `attentionThreshold`, se sacó por completo del proyecto — ver
// `ui/TeacherAttentionSettingsPanel.jsx`). El panel muestra solo la cantidad
// de alumnos monitoreados, sin el listado por alumno. El mapa de calor
// y la línea temporal usan `groupInattentive`/`pctAttentive` de
// cada punto de `useAttentionHistory`, que sí depende de P (`pThreshold`) —
// mismo criterio que `hooks/useGroupAttentionAlert.js`.
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Ícono "i" + tooltip explicativo, pegado a una etiqueta — pedido explícito
// posterior: reutiliza el patrón YA EXISTENTE en el proyecto
// (`.sparkle-info-icon`/`.sparkle-tooltip`, ver `ui/CameraSwitch.jsx` y su
// CSS en `styles/panel.css`), sin ninguna dependencia nueva. Dos
// modificadores propios (`--inline`/`--center`, mismo archivo CSS) porque
// ese patrón original vive en su propia fila (ícono a la izquierda de un
// switch, tooltip anclado a la izquierda) — acá el ícono va PEGADO al
// final de un texto corto dentro de una tile angosta, así que necesita
// quedar en la misma línea (`inline-flex`) y el tooltip necesita centrarse
// bajo el ícono (`left:0` se recortaría contra el borde del panel en la
// columna derecha de la grilla de 2 columnas).
function LabelWithTooltip({ children, tooltip, ariaLabel }) {
  return (
    <>
      {children}
      <span className="sparkle-info-icon sparkle-info-icon--inline" tabIndex={0} aria-label={ariaLabel}>
        <InfoIcon size={12} />
        <span className="sparkle-tooltip sparkle-tooltip--center" role="tooltip">
          {tooltip}
        </span>
      </span>
    </>
  );
}

// Arma los puntos de `ui/AttentionTimeline.jsx` a partir del `history`
// combinado (histórico + vivo) de `useAttentionHistory` — `minute` es
// relativo al primer punto disponible, no al inicio real de la clase (si
// la base histórica todavía no trajo el primer snapshot, arranca en 0 con
// el primer punto en vivo que llegue). `seconds` es el mismo cálculo, en
// otra unidad — lo usa `buildHeatmapSlots` (más abajo) para agrupar en
// franjas de `SECONDS_PER_HEATMAP_SLOT` (5 minutos): se computa acá, directo desde
// `ts`, en vez de derivarlo de `minute * 60` en `buildHeatmapSlots`, para no
// arrastrar el error de redondeo de ese round-trip (minutos → segundos)
// justo en el borde de cada balde.
function buildTimelinePoints(history) {
  if (history.length === 0) return [];
  const start = history[0].ts;
  return history.map((point) => ({
    minute: (point.ts - start) / 60000,
    seconds: (point.ts - start) / 1000,
    pctAttentive: point.pctAttentive,
    groupInattentive: point.groupInattentive,
    source: point.source,
  }));
}

// Agrupa `timelinePoints` en baldes de `SECONDS_PER_HEATMAP_SLOT` segundos
// para `ui/AttentionHeatmap.jsx` — cada franja es el promedio de
// `pctAttentive` de los puntos que cayeron en ese balde (nunca inventa
// franjas sin datos: si no hubo ningún punto en un balde intermedio,
// directamente no aparece). `start` es el `ts` absoluto del primer punto
// de `history` (el mismo ancla que usa `buildTimelinePoints` para
// `minute`/`seconds`) — `startTime` es la hora de reloj real en la que
// arrancó esa franja (`start` + `index` franjas de
// `SECONDS_PER_HEATMAP_SLOT` segundos), para que `ui/AttentionHeatmap.jsx`
// la muestre en vez del porcentaje dentro de cada celda.
function buildHeatmapSlots(timelinePoints, start) {
  if (timelinePoints.length === 0) return [];
  const bySlot = new Map();
  timelinePoints.forEach((point) => {
    const index = Math.floor(point.seconds / SECONDS_PER_HEATMAP_SLOT);
    if (!bySlot.has(index)) bySlot.set(index, { historical: [], live: [] });
    const bucket = bySlot.get(index);
    if (point.source === 'historical') bucket.historical.push(point.pctAttentive);
    else bucket.live.push(point.pctAttentive);
  });
  const maxIndex = Math.max(...bySlot.keys());
  return Array.from(bySlot.entries())
    .sort(([a], [b]) => a - b)
    .map(([index, bucket]) => {
      const values = index < maxIndex && bucket.historical.length > 0
        ? bucket.historical
        : [...bucket.historical, ...bucket.live];
      return {
        // `SECONDS_PER_HEATMAP_SLOT` es múltiplo exacto de 60 (300s = 5min)
        // — la etiqueta se muestra en minutos (`+5min`, `+10min`...), más
        // legible para el docente que "+300s"/"+600s"; el cálculo interno
        // sigue en segundos (ver el comentario de la constante, más arriba).
        label: `+${(index * SECONDS_PER_HEATMAP_SLOT) / 60}min`,
        startTime: formatTime(start + index * SECONDS_PER_HEATMAP_SLOT * 1000),
        pctAttentive: values.reduce((acc, v) => acc + v, 0) / values.length,
      };
    });
}

// Cada cuánto se agrega UN punto nuevo a la curva — coincide con
// `SNAPSHOT_INTERVAL_MS` del servidor (`backend/src/ws/attentionState.js`,
// 10s). El mapa de calor NO tiene ningún mecanismo de decimación propio —
// se recalcula en cada cambio de `history`, igual que siempre.
const CURVE_REFRESH_MS = 10 * 1000;

// Alinea el arranque de la ventana de la curva a la misma grilla de 10s que
// usa el servidor (`backend/src/ws/attentionState.js#evaluateSnapshotsStart`),
// ambos anclados a `windowStartedAt` (`meetings.attention_window_started_at`,
// fijado en `startClass`) — sin esto, el cliente arrancaba su propia cuenta
// desde `Date.now()` del instante de siembra, con una fase distinta a la del
// servidor. Sin ancla persistida todavía (reunión vieja, anterior a este
// cambio), cae a `Date.now()` — mismo comportamiento que antes, sin alinear.
function alignedWindowStart(windowStartedAt) {
  if (!windowStartedAt) return Date.now();
  const anchor = new Date(windowStartedAt).getTime();
  const elapsed = Date.now() - anchor;
  const msSinceLastBoundary = ((elapsed % CURVE_REFRESH_MS) + CURVE_REFRESH_MS) % CURVE_REFRESH_MS;
  return Date.now() - msSinceLastBoundary;
}

export default function ConcentrationStats({
  onBack, roster = [], pThreshold, classStarted = true, history = [], historyLoading = false,
  windowStartedAt = null,
}) {
  // Mismo umbral que dibuja la línea punteada en `ui/AttentionTimeline.jsx`
  // — se calcula acá arriba (no más abajo, donde vivía antes) porque el
  // intervalo de la curva, unas líneas más abajo, lo necesita para decidir
  // el color de CADA punto con el mismo corte exacto que la línea. Sin
  // complemento — P (pThreshold) es directamente la fracción atenta mínima
  // en escala 0-100 (auditoría de 2026-08-11 contra la Tabla 2 de la
  // tesis; antes era `100 - pThreshold*100` porque P representaba la
  // fracción desatenta mínima).
  const attentionThreshold = pThreshold != null ? pThreshold * 100 : undefined;

  // Último `history` recibido — se actualiza en CADA render (vía el efecto
  // de abajo) sin disparar un re-render por sí solo; lo lee el intervalo de
  // la curva (más abajo) para saber qué llegó desde el último tick.
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // Mismo criterio que `historyRef`: el intervalo de la curva se arma UNA
  // sola vez (`useEffect(..., [])` más abajo) y sigue vivo mientras el
  // componente esté montado, así que necesita una ref para ver el
  // `attentionThreshold` VIGENTE en cada tick (puede cambiar en caliente si
  // el docente ajusta P, o si sincroniza un modo de clase nuevo) — leer la
  // constante de arriba directo desde el closure del `setInterval` se
  // quedaría pegado al valor que tenía en el momento en que se creó el
  // intervalo, no al actual.
  const attentionThresholdRef = useRef(attentionThreshold);
  useEffect(() => {
    attentionThresholdRef.current = attentionThreshold;
  }, [attentionThreshold]);

  // Curva — a diferencia de `history` (que sigue creciendo de a un punto por
  // cada "attention_roster_updated", hasta cada ~2s con varios alumnos),
  // `curveHistory` crece de a UN punto cada `CURVE_REFRESH_MS`: ese punto es
  // el PROMEDIO de `pctAttentive` de todos los puntos que llegaron a
  // `history` desde el tick anterior — nunca los puntos crudos de la
  // ventana mostrados de a ráfagas. `lastCurveWindowStartRef` marca desde
  // dónde arranca la ventana todavía sin promediar.
  //
  // Arranca vacía y se siembra UNA sola vez, cuando `historyLoading` pasa a
  // `false` (nunca antes) — con lo que `history` tenga en ESE momento
  // (típicamente la base histórica ya persistida por el servidor cada 10s,
  // mostrada tal cual, sin volver a promediarla). Corrección — bug real: si
  // el docente entra a esta pantalla justo tras un F5, `useAttentionHistory`
  // todavía puede tener el fetch al backend en vuelo (`hooks/useAttentionHistory.js`,
  // líneas ~108-148); sembrar con `historyRef.current` en ese instante
  // (como se hacía antes, vía `useState(() => historyRef.current)`) capturaba
  // un `history` a medio cargar, y el filtro `ts > windowStart` de abajo
  // descartaba para siempre cualquier punto histórico que llegara después —
  // la curva quedaba corta o arrancaba tarde aunque `history`/el heatmap
  // estuvieran completos. Esperar a `historyLoading === false` asegura que
  // el seed vea la base histórica ya completa. Desde ahí en más, cada tick
  // promedia solo lo NUEVO. Si `history` se resetea (clase nueva de cero,
  // ver `hooks/useAttentionHistory.js`), `curveHistory` se resetea junto con
  // ella (efecto de más abajo).
  const [curveHistory, setCurveHistory] = useState([]);
  const lastCurveWindowStartRef = useRef(Date.now());
  const seededRef = useRef(false);

  useEffect(() => {
    if (historyLoading || seededRef.current) return;
    seededRef.current = true;
    setCurveHistory(history);
    lastCurveWindowStartRef.current = alignedWindowStart(windowStartedAt);
  }, [historyLoading, history, windowStartedAt]);

  useEffect(() => {
    // No arranca el intervalo hasta que la base histórica haya terminado de
    // cargar (ver el efecto de siembra, arriba) — mientras `historyLoading`
    // sea `true` todavía no hay `windowStart` confiable desde el cual medir
    // "lo nuevo".
    if (historyLoading) return undefined;

    const id = setInterval(() => {
      const windowStart = lastCurveWindowStartRef.current;
      const now = Date.now();
      lastCurveWindowStartRef.current = now;

      const newEntries = historyRef.current.filter((point) => point.ts > windowStart);
      // Sin snapshots nuevos en esta ventana (ej. clase pausada, o nadie
      // con la cámara activa) — no hay nada que promediar, así que no se
      // agrega ningún punto este tick (la curva no avanza, en vez de
      // inventar un valor).
      if (newEntries.length === 0) return;

      const pctAttentive = newEntries.reduce((sum, p) => sum + p.pctAttentive, 0) / newEntries.length;
      // Corrección — bug real: usar `.some(p => p.groupInattentive)` acá
      // desalineaba el color del punto del valor que el punto en sí
      // grafica — un solo snapshot "desatento" perdido dentro de una
      // ventana mayormente atenta pintaba el punto de rojo aunque
      // `pctAttentive` (el promedio de TODA la ventana) quedara cómodo por
      // ENCIMA de la línea de umbral. Comparación directa contra el mismo
      // `pctAttentive` ya promediado arriba, con el mismo corte que dibuja
      // la línea punteada (`attentionThreshold` en
      // `ui/AttentionTimeline.jsx`): rojo únicamente si el punto graficado
      // cae POR DEBAJO de esa línea, nunca por algo que haya pasado en un
      // instante puntual dentro de la ventana y que el propio punto ya no
      // refleja.
      const groupInattentive = pctAttentive < attentionThresholdRef.current;

      setCurveHistory((prev) => [...prev, {
        ts: now, pctAttentive, groupInattentive, source: 'live',
      }]);
    }, CURVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [historyLoading]);

  // Mismo reset que `history` — `curveHistory` es independiente de `history`
  // desde la siembra inicial, así que no se entera sola de un reset.
  useEffect(() => {
    if (history.length === 0) {
      setCurveHistory([]);
      lastCurveWindowStartRef.current = Date.now();
    }
  }, [history]);

  // Curva — SOLO esta usa `curveHistory` (decimada, un punto cada
  // `CURVE_REFRESH_MS`, ver más arriba).
  const timelinePoints = useMemo(() => buildTimelinePoints(curveHistory), [curveHistory]);
  // Mapa de calor — revertido a como estaba antes de la decimación: parte
  // del `history` CRUDO (no de `curveHistory`/`timelinePoints`, que ahora
  // son exclusivos de la curva) y se recalcula en cada cambio de `history`,
  // sin ningún throttling propio — actualiza en cada snapshot que llega,
  // igual que siempre.
  const heatmapPoints = useMemo(() => buildTimelinePoints(history), [history]);
  const heatmapSlots = useMemo(
    () => buildHeatmapSlots(heatmapPoints, history[0]?.ts),
    [heatmapPoints, history]
  );
  return (
    <div className="sparkle-screen sparkle-screen--live">
      <div className="sparkle-panel-topbar">
        <div className="sparkle-screen-head">
          <button type="button" className="sparkle-back-link" onClick={onBack}>
            <ChevronLeftIcon size={15} />
            Volver
          </button>
          <div className="sparkle-screen-head-title-row">
            <h1 className="sparkle-title">Atención de la clase</h1>
            {/* Pedido explícito posterior — la clase termina y el docente
                puede seguir viendo este panel como resumen (ver
                `buildTimelinePoints`/`buildHeatmapSlots` más arriba: ninguno
                depende de `classStarted`, ya se calculan sobre TODO lo
                acumulado en `history`). Este badge es lo
                único que deja claro, de un vistazo, que lo que se ve es un
                cierre de sesión y no una clase en curso — mismo lenguaje
                visual que `.sparkle-class-status-badge--paused` en
                `TeacherPanel.jsx` ("Clase detenida"), pero con un texto
                distinto a propósito: acá puede tratarse de una clase
                terminada hace rato (fuera de la ventana de "reanudar"), no
                solo una pausa reciente. */}
            {!classStarted && (
              <span className="sparkle-class-status-badge sparkle-class-status-badge--paused">
                <span className="sparkle-class-status-dot" />
                Clase detenida
              </span>
            )}
          </div>
          <p className="sparkle-subtitle">
            {classStarted
              ? 'Estadísticas de atención en tiempo real de tus alumnos.'
              : 'La clase está detenida — estos son los datos registrados hasta ahora.'}
          </p>
        </div>
      </div>

      <div className="sparkle-scroll-area">
        <div className="sparkle-concentration-content">
          {/* Cantidad de alumnos monitoreados — ARRIBA de todo, antes de
              cualquier otra sección. Solo el número, sin listado por alumno. */}
          <div className="sparkle-attention-trigger">
            <div className="sparkle-attention-trigger-row">
              <span className="sparkle-attention-trigger-icon">
                <StudentIcon size={15} />
              </span>
              <span className="sparkle-attention-trigger-label">Alumnos monitoreados por IA</span>
              <span className="sparkle-attention-trigger-count">{roster.length}</span>
            </div>
          </div>

          {/* Mapas/gráficos estadísticos. */}
          <section className="sparkle-concentration-group">
            <p className="sparkle-section-label">Mapa de calor de atención</p>
            <div className="sparkle-grafico-card">
              <AttentionHeatmap slots={heatmapSlots} />
            </div>
          </section>

          <section className="sparkle-concentration-group">
            <p className="sparkle-section-label">
              <LabelWithTooltip
                ariaLabel="Qué muestra este gráfico"
                tooltip="Muestra cómo fue cambiando la atención de tus alumnos durante la clase. Cada punto es una foto del grupo en ese momento. Los puntos rojos son momentos donde la mayoría estaba desatenta."
              >
                Atención grupal en el tiempo
              </LabelWithTooltip>
            </p>
            <div className="sparkle-grafico-card">
              <AttentionTimeline points={timelinePoints} attentionThreshold={attentionThreshold} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
