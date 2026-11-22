import { useEffect, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, annotationPlugin);

// Corrección — pedido explícito posterior: a medida que se acumulan
// puntos (uno cada 10 segundos desde la base histórica —
// `SNAPSHOT_INTERVAL_MS` en `backend/src/ws/attentionState.js` —, más los
// "en vivo" de `useAttentionHistory.js`), forzarlos TODOS dentro del mismo
// ancho fijo de la tarjeta apretaba cada vez más el gráfico hasta volverse
// ilegible. Acá el ancho del gráfico CRECE con la cantidad de puntos (ancho
// fijo POR punto, `WIDTH_PER_POINT`), y es el contenedor de afuera
// (`.sparkle-linea3-scroll`) el que scrollea horizontalmente — la densidad
// visual queda siempre igual sin importar cuántos puntos se acumulen, en
// vez de ir comprimiéndose. `MIN_VISIBLE_POINTS` (~20) es la cantidad
// de puntos que entran cómodos en el ancho de la tarjeta sin necesitar
// scroll — por debajo de eso el gráfico ocupa el 100% del ancho como
// siempre, nunca se agranda de más ni queda con espacio vacío a la derecha.
const WIDTH_PER_POINT = 34;
const MIN_VISIBLE_POINTS = 20;

// Línea temporal de atención grupal — pedido explícito posterior:
// REEMPLAZA los datos MOCK por datos REALES, combinando la base histórica
// persistida (`backend/src/ws/attentionState.js`, un snapshot cada 10
// segundos) con lo que llega en vivo (`hooks/useAttentionHistory.js`, que ya
// entrega los puntos combinados y ordenados — este componente solo dibuja).
//
// Cambio de eje respecto de la versión mock — pedido explícito: acá el eje
// Y es % ATENTOS (antes era % desatento, invertido). El umbral que se
// marca con `chartjs-plugin-annotation` sigue siendo el mismo P del modo de
// clase, pero expresado en términos de atención (`100 - P*100`) — por
// debajo de esa línea es la zona de "grupo desatento", visualmente abajo
// en vez de arriba. Los "puntos de alerta" (`groupInattentive`, ya viene
// calculado en cada punto — mismo criterio que
// `hooks/useGroupAttentionAlert.js`, nunca el 0.5 hardcodeado de
// `hooks/useLiveAttention.js`) se marcan agrandados y en rojo más intenso,
// sin importar si están arriba o debajo de la línea del umbral.
const FONT_FAMILY = "'Google Sans', Roboto, Arial, sans-serif";
const GRAY_TEXT = '#5f6368';
const GRAY_BORDER = '#dadce0';
const GRAY_GRID = '#f0f0f0';

const GREEN = '#34a853';
const GREEN_AREA = 'rgba(52, 168, 83, 0.15)';
const ALERT_RED = '#d93025';

function formatMinute(minute) {
  return `+${Math.round(minute)}min`;
}

function buildOptions(attentionThreshold) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#ffffff',
        borderColor: GRAY_BORDER,
        borderWidth: 1,
        cornerRadius: 6,
        padding: 8,
        displayColors: false,
        titleColor: '#202124',
        titleFont: { size: 12, family: FONT_FAMILY, weight: '700' },
        bodyColor: '#202124',
        bodyFont: { size: 12, family: FONT_FAMILY },
        callbacks: {
          label: (ctx) => `${Math.round(ctx.parsed.y)}% de los alumnos estaban atentos`,
        },
      },
      annotation: {
        annotations: {
          attentionThreshold: {
            type: 'line',
            yMin: attentionThreshold,
            yMax: attentionThreshold,
            borderColor: GRAY_TEXT,
            borderWidth: 1,
            borderDash: [4, 4],
            label: {
              display: true,
              // Corrección — pedido explícito posterior: "Umbral" es jerga
              // técnica para un docente sin conocimiento técnico — se
              // reemplaza por una frase que se entiende de un vistazo, sin
              // necesitar saber qué es un "umbral de atención".
              content: 'Bajo esta línea el grupo está desatento',
              position: 'end',
              backgroundColor: 'transparent',
              color: GRAY_TEXT,
              font: { size: 9, family: FONT_FAMILY, weight: '600' },
              yAdjust: -8,
            },
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          font: { size: 11, family: FONT_FAMILY },
          color: GRAY_TEXT,
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8,
        },
      },
      y: {
        min: 0,
        max: 100,
        ticks: {
          font: { size: 11, family: FONT_FAMILY }, color: GRAY_TEXT, callback: (v) => `${v}%`,
        },
        grid: { color: GRAY_GRID },
      },
    },
  };
}

// `points`: `[{ minute, pctAttentive, groupInattentive }]`, ya ordenados
// cronológicamente (ver `hooks/useAttentionHistory.js`/
// `screens/ConcentrationStats.jsx`, que arma este array combinando la base
// histórica con lo que llega en vivo). `attentionThreshold` es
// `pThreshold*100`, en el mismo formato 0-100 que el eje Y.
export function AttentionTimeline({ points = [], attentionThreshold = 45 }) {
  const scrollRef = useRef(null);
  // `true` mientras el docente no haya scrolleado a propósito hacia atrás
  // — arranca en `true` (pedido explícito: "que siempre muestre los datos
  // más recientes por default") y se mantiene pegado al extremo más
  // reciente en cada punto nuevo, salvo que `handleScroll` detecte que se
  // alejó del final. Mismo patrón que el "auto-scroll" de un chat.
  const stickToEndRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToEndRef.current) return;
    el.scrollLeft = el.scrollWidth;
  }, [points.length]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceToEnd = el.scrollWidth - el.scrollLeft - el.clientWidth;
    stickToEndRef.current = distanceToEnd < WIDTH_PER_POINT;
  }

  if (points.length === 0) {
    return (
      <div className="sparkle-linea3 sparkle-grafico-vacio">
        <p className="sparkle-text">La curva aparecerá en cuanto haya datos de atención de la clase.</p>
      </div>
    );
  }

  const data = {
    labels: points.map((p) => formatMinute(p.minute)),
    datasets: [
      {
        data: points.map((p) => p.pctAttentive),
        borderColor: GREEN,
        borderWidth: 1.5,
        backgroundColor: GREEN_AREA,
        fill: true,
        tension: 0.3,
        // Corrección — pedido explícito posterior: estas 5 opciones vivían
        // antes en `options.elements.point.*` (nivel GLOBAL del chart,
        // dentro de `buildOptions`) y nunca se aplicaban en el punto
        // correcto — Chart.js resuelve el estilo de cada punto con un
        // atajo de "opciones compartidas" cuando el DATASET no declara la
        // propiedad como función él mismo, así que la resolución por
        // índice (`ctx.dataIndex`) de `elements.point.*` quedaba pisada por
        // un único estilo "compartido" calculado sin índice real — todos
        // los puntos terminaban con el mismo color, nunca el rojo de
        // alerta. Puestas ACÁ, en el dataset (`pointBackgroundColor` etc.,
        // el patrón oficial de Chart.js para estilizar puntos individuales
        // según su propio dato), Chart.js SÍ resuelve cada una con el
        // índice real. Mismo criterio de datos que antes, sin cambiarlo:
        // `points[ctx.dataIndex]?.groupInattentive` sigue siendo la MISMA
        // fuente de verdad (`hooks/useAttentionHistory.js`/
        // `hooks/useGroupAttentionAlert.js`).
        pointRadius: (ctx) => (points[ctx.dataIndex]?.groupInattentive ? 5 : 0),
        pointHoverRadius: (ctx) => (points[ctx.dataIndex]?.groupInattentive ? 5 : 2),
        pointBackgroundColor: (ctx) => (points[ctx.dataIndex]?.groupInattentive ? ALERT_RED : GREEN),
        pointBorderColor: (ctx) => (points[ctx.dataIndex]?.groupInattentive ? '#ffffff' : GREEN),
        pointBorderWidth: (ctx) => (points[ctx.dataIndex]?.groupInattentive ? 2 : 0),
      },
    ],
  };

  const needsScroll = points.length > MIN_VISIBLE_POINTS;
  const chartWidth = needsScroll ? `${points.length * WIDTH_PER_POINT}px` : '100%';

  return (
    <>
      <div className="sparkle-linea3-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="sparkle-linea3" style={{ width: chartWidth }}>
          <Line data={data} options={buildOptions(attentionThreshold)} />
        </div>
      </div>
      <p className="sparkle-grafico-descripcion">
        Cada punto muestra el porcentaje de alumnos atentos en ese momento de la clase.
        Los puntos rojos son momentos donde el grupo estuvo mayormente desatento.
        {needsScroll && ' Deslizá hacia la izquierda para ver el historial completo.'}
      </p>
    </>
  );
}
