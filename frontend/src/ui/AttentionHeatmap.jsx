// Mapa de calor de atención grupal — pedido explícito posterior: REEMPLAZA
// los datos MOCK (distribución por bandas de concentración, sin fuente real
// posible) por datos REALES: una franja de 5 minutos por celda, coloreada
// según el `pctAttentive` de ESA franja (verde = bien, rojo = mal).
//
// Corrección — pedido explícito posterior: reemplaza el `Bar` de Chart.js
// por una grilla de celdas en CSS puro (sin canvas, sin dependencia
// nueva) — más parecido a un mapa de calor real: cada celda es del mismo
// tamaño, coloreada de lleno, con la etiqueta de tiempo y la hora de inicio
// de esa franja escritas adentro, fluyendo de izquierda a derecha
// (`flex-wrap`, ver `.sparkle-heatmap3` en `styles/panel.css`).
//
// Corrección — pedido explícito posterior: adentro de la celda se mostraba
// el `pctAttentive` de esa franja como "72%" — se reemplaza por la hora de
// reloj real en la que arrancó esa franja (`slot.startTime`, ej.
// "10:32", calculada en `screens/ConcentrationStats.jsx#buildHeatmapSlots`),
// para que el docente ubique cada franja en el reloj de la clase. El color
// sigue siendo el indicador de atención — `pctAttentive` no se toca, sigue
// siendo la fuente de `colorForPct`/`textColorForPct` y del tooltip nativo
// (`title`).
//
// `slots` ya viene armado por `screens/ConcentrationStats.jsx` (agrupando
// los puntos de `hooks/useAttentionHistory.js` en baldes de 5 minutos) —
// este componente solo dibuja, no calcula franjas.

// Mismo criterio de paleta que `AttentionTimeline.jsx` (`--sparkle-danger`/
// `--sparkle-success`), con un tono ámbar intermedio (mismo que usa el
// resto de Sparkle para "sin rostro"/estados de alerta media) para que la
// zona del medio no se vea como un marrón sucio al interpolar directo
// rojo↔verde.
const RED = [217, 48, 37]; // --sparkle-danger
const AMBER = [249, 171, 0];
const GREEN = [52, 168, 83]; // --sparkle-success

function lerp([r1, g1, b1], [r2, g2, b2], t) {
  return [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t];
}

// `pct` 0–100 → [r,g,b] rojo→ámbar→verde, continuo (no por tramos fijos):
// 0–50% interpola rojo→ámbar, 50–100% interpola ámbar→verde.
function rgbForPct(pct) {
  const p = Math.max(0, Math.min(100, pct));
  return p <= 50 ? lerp(RED, AMBER, p / 50) : lerp(AMBER, GREEN, (p - 50) / 50);
}

function colorForPct(pct) {
  const [r, g, b] = rgbForPct(pct);
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

// Texto blanco o oscuro según qué tan clara sea la celda — necesario
// porque el ámbar del medio del degradé es bastante claro (a diferencia
// del rojo/verde de las puntas, donde el blanco siempre contrasta bien).
// Luminancia perceptual estándar (ITU-R BT.601); umbral 150/255 elegido a
// ojo, sin fórmula especial detrás.
function textColorForPct(pct) {
  const [r, g, b] = rgbForPct(pct);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 150 ? '#202124' : '#ffffff';
}

// `slots`: `[{ label: string, startTime: string, pctAttentive: number }]`,
// una por cada bloque de 5 minutos de clase transcurridos, en orden
// cronológico.
export function AttentionHeatmap({ slots = [] }) {
  if (slots.length === 0) {
    return (
      <div className="sparkle-heatmap3 sparkle-grafico-vacio">
        <p className="sparkle-text">El mapa aparecerá en cuanto haya datos de atención de la clase.</p>
      </div>
    );
  }

  return (
    <>
      <div className="sparkle-heatmap3">
        {slots.map((slot) => (
          <div
            key={slot.label}
            className="sparkle-heatmap-celda"
            style={{ backgroundColor: colorForPct(slot.pctAttentive), color: textColorForPct(slot.pctAttentive) }}
            title={`${slot.label} — ${Math.round(slot.pctAttentive)} de cada 100 alumnos estaban atentos`}
          >
            <span className="sparkle-heatmap-celda-etiqueta">{slot.label}</span>
            <span className="sparkle-heatmap-celda-valor">{slot.startTime} hs</span>
          </div>
        ))}
      </div>
      <p className="sparkle-grafico-descripcion">
        El mapa muestra cómo estuvo la atención del grupo durante la clase, dividida en franjas de 5 minutos.
        El color de cada celda va del rojo al verde: cuanto más verde, mayor era la atención del grupo en ese
        momento; cuanto más rojo, menor.
      </p>
    </>
  );
}
