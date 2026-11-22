import { useEffect, useRef, useState } from 'react';
import { getAttentionSnapshots } from '../services/backendMessaging';
import {
  getStoredAttentionHistory,
  setStoredAttentionHistory,
  clearStoredAttentionHistory,
} from '../utils/attentionHistoryStorage';

// Historial de atención grupal para `screens/ConcentrationStats.jsx` — hook
// APARTE, mismo criterio que el resto de los hooks de este proyecto (nunca
// mezclado en el componente): combina la base histórica PERSISTIDA (un
// snapshot cada 10 segundos, ver `backend/src/ws/attentionState.js`) con lo
// que llega EN VIVO por WebSocket (`roster`, ya resuelto por
// `hooks/useLiveAttention.js` en `App.jsx` — este hook no escucha WS
// directo, reacciona a los cambios de esa prop).
//
// Montado en `App.jsx` (no en `ConcentrationStats.jsx`) — Corrección
// (pedido explícito): antes vivía DENTRO de `ConcentrationStats.jsx`, así
// que cada vez que el docente entraba y salía de esa pantalla (un simple
// cambio de vista, sin relación alguna con el estado de la clase) el hook
// se desmontaba/remontaba de cero, perdiendo TODOS los puntos "en vivo"
// acumulados desde el último snapshot persistido (hasta 10 segundos de
// historial reciente, o el historial ENTERO si la clase todavía no llegó
// al primer snapshot). Ahora vive al nivel de `App.jsx` (que nunca se
// desmonta por navegación interna del panel), con el mismo criterio que ya
// usan `useAttentionDetection`/`useLiveAttention`.
//
// Los puntos "en vivo" que arma este hook NUNCA se mandan al backend — el
// único que persiste snapshots es el intervalo de 10 segundos del servidor;
// acá es solo una extensión, del lado del cliente, de la MISMA línea de
// tiempo para que el gráfico no se vea "atrasado" respecto de lo que el
// docente ve en los cuadritos de "Ahora mismo".
//
// Fórmulas — EXACTAMENTE las mismas que usa el backend (ver el comentario
// grande de `attentionState.js`), para que un punto histórico y uno en vivo
// nunca se calculen distinto:
//   pctAttentive    = (alumnos con `!inattentive` / total) * 100
//   pctNoFace  = (alumnos con `concentration === null` / total) * 100
//   groupInattentive = pctAttentive < pThreshold * 100
//
// Confirmado — pedido explícito posterior: `roster` (el `total` de arriba)
// es el mismo que arma `hooks/useLiveAttention.js` a partir de
// "attention_roster_updated", que a su vez viene de
// `attentionState.obtenerSnapshot()` del lado del servidor — un alumno sin
// la cámara de atención activa NUNCA aparece ahí (ver el comentario grande
// de `estadoPorReunion` en `backend/src/ws/attentionState.js`), así que
// ninguna de estas 3 fórmulas puede contarlo por accidente, ni como atento
// ni como desatento. `pctNoFace` es otra cosa: cámara PRENDIDA pero sin
// rostro detectado (`type: 'no_face'`), no "sin cámara".
//
// Ciclo de vida (pedido explícito) — el historial:
//   - se CONGELA cuando la clase se detiene ("class_ended"): sigue
//     mostrando lo acumulado hasta ese momento, nunca se vacía solo.
//   - sigue acumulando sobre lo mismo cuando se reanuda ("class_resumed"):
//     nunca arranca de cero.
//   - sobrevive un F5/recarga de página: se restaura desde
//     `chrome.storage.local` al montar (ver `utils/attentionHistoryStorage.js`),
//     ANTES de que lleguen datos nuevos.
//   - se limpia ÚNICAMENTE ante un "class_started" GENUINO (clase nueva de
//     cero) — nunca ante "class_ended"/"class_resumed" — vía
//     `classStartedSignal` (contador, ver `hooks/useLiveClass.js`).
export function useAttentionHistory({
  meetingCode, email, roster, pThreshold, classStartedSignal,
}) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Ancla de fase de la sesión de clase actual (`meetings.attention_window_started_at`,
  // ver `backend/src/services/classService.js#startClass`) — la usa
  // `screens/ConcentrationStats.jsx` para alinear sus propias ventanas de
  // 10s a la misma grilla que ya usó el servidor al persistir los snapshots
  // históricos. `null` hasta que el fetch resuelva, o si la reunión todavía
  // no pasó por un `startClass` posterior a este cambio.
  const [windowStartedAt, setWindowStartedAt] = useState(null);
  // Última referencia de `roster` ya procesada — mismo motivo que
  // `lastProcessedRef` en `useFatigueAlert.js`: `roster` puede
  // re-renderizar con la MISMA referencia (padres re-renderizando por otro
  // motivo), no hay que agregar un punto en vivo por cada render, solo por
  // cada `roster` REALMENTE nuevo.
  const lastProcessedRosterRef = useRef(null);
  // Valor de `classStartedSignal` con el que se montó el hook — el efecto
  // de reset (más abajo) solo reacciona a un CAMBIO respecto de este valor
  // base, nunca al valor inicial en sí (evita un reset espurio en el
  // primer render, sea `0` o cualquier otro valor con el que la clase ya
  // haya estado en curso desde antes de que este hook llegara a montarse).
  const signalBaseRef = useRef(classStartedSignal);

  // Restaura lo persistido en `chrome.storage.local` (sobrevive un F5) y
  // trae la base histórica del backend — se combinan, no se reemplazan:
  // el fetch al backend (más abajo) preserva cualquier punto "en vivo" que
  // ya esté en `historial` para ese momento, sea que haya llegado de la
  // restauración de storage o de un `roster` que ya haya procesado el
  // efecto de abajo antes de que esta promesa resuelva.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    lastProcessedRosterRef.current = null;

    if (!meetingCode || !email) {
      setLoading(false);
      return undefined;
    }

    getStoredAttentionHistory(meetingCode)
      .then((stored) => {
        if (cancelled || !stored || stored.length === 0) return;
        setHistory((prev) => (prev.length === 0 ? stored : prev));
      })
      .catch(() => {
        // Best-effort — sin historial restaurado, el hook sigue su curso
        // normal con el fetch al backend de abajo.
      });

    getAttentionSnapshots(meetingCode, email)
      .then((response) => {
        if (cancelled) return;
        // Corrección — pedido explícito posterior: este mensaje sigue el
        // mismo patrón `{status, body}` que `getClassSummary`/
        // `getRecoverySummary` (ver el comentario de
        // `services/backendMessaging.js`), NUNCA el body pelado. Antes acá
        // se leía `respuesta?.snapshots` directo — como `respuesta` es
        // `{status, body}`, esa lectura siempre daba `undefined` y el `??`
        // lo tapaba con `[]` sin tirar ningún error: el historial persistido
        // nunca llegaba a mostrarse, ni siquiera cuando la clase SÍ tenía
        // snapshots en la base. Acá se distingue un error real (403 sin ser
        // el docente, 404 de reunión inexistente, 500) de un historial
        // vacío legítimo (200 con `snapshots: []`, ej. una clase recién
        // empezada).
        if (response.status !== 200) {
          throw new Error(response.body?.error || `El servidor respondió ${response.status}.`);
        }
        const rows = response.body?.snapshots ?? [];
        setWindowStartedAt(response.body?.windowStartedAt ?? null);
        const points = rows.map((row) => ({
          ts: new Date(row.timestamp).getTime(),
          pctAttentive: row.pctAttentive,
          pctNoFace: row.pctNoFace,
          groupInattentive: row.groupInattentive,
          source: 'historical',
        }));
        // Corrección — pedido explícito posterior: antes esto era
        // `setHistorial(puntos)`, un reemplazo total. Si mientras el fetch
        // estaba en vuelo ya había llegado algún `roster` real (el efecto de
        // abajo corre en el mismo montaje, de forma síncrona, antes de que
        // esta promesa resuelva) — o ya se había restaurado historial desde
        // storage — ese reemplazo lo tiraba. Ahora se conservan los puntos
        // "en vivo" que ya estén en `history` y se reordena por `ts` — así
        // el resultado es correcto sin importar en qué orden termine
        // resolviendo cada cosa. Los puntos "historical" VIEJOS (de una
        // restauración de storage previa a este fetch) sí se descartan acá,
        // a favor de los que el backend acaba de confirmar como vigentes.
        setHistory((prev) => {
          const prevLivePoints = prev.filter((point) => point.source === 'live');
          return [...points, ...prevLivePoints].sort((a, b) => a.ts - b.ts);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // Best-effort — mismo criterio que el resto de las herramientas de
        // este panel: sin base histórica fresca, el gráfico sigue
        // mostrando lo que haya (restaurado de storage, o vacío) en vez de
        // bloquear toda la pantalla por un fallo de un solo pedido.
        setError(`No se pudo cargar el historial de atención: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [meetingCode, email]);

  // Agrega un punto EN VIVO cada vez que llega un `roster` real nuevo —
  // mismas fórmulas que el backend (ver el comentario grande de arriba),
  // nunca se persiste en el backend, solo extiende la línea de tiempo
  // mostrada (SÍ se persiste en `chrome.storage.local`, ver el efecto de
  // guardado más abajo).
  useEffect(() => {
    if (roster === lastProcessedRosterRef.current) return;
    lastProcessedRosterRef.current = roster;

    // Roster vacío — mismo criterio que el backend (`attentionState.js`,
    // pedido explícito): sin nadie monitoreado no hay nada real que
    // agregar a la línea de tiempo. Esto es lo que pasa, en particular,
    // mientras la clase está DETENIDA (nadie manda snapshots) — el
    // historial simplemente deja de crecer, nunca se vacía por esto.
    if (!roster || roster.length === 0) return;

    const total = roster.length;
    const attentive = roster.filter((student) => !student.inattentive).length;
    const noFace = roster.filter((student) => student.concentration === null).length;
    const pctAttentive = (attentive / total) * 100;

    const newPoint = {
      ts: Date.now(),
      pctAttentive,
      pctNoFace: (noFace / total) * 100,
      // P (pThreshold) es la fracción ATENTA mínima — misma fórmula que
      // `backend/src/ws/attentionState.js` (auditoría de 2026-08-11 contra
      // la Tabla 2 de la tesis).
      groupInattentive: pctAttentive < (pThreshold ?? 0.45) * 100,
      source: 'live',
    };

    setHistory((prev) => [...prev, newPoint]);
  }, [roster, pThreshold]);

  // Persiste el historial actualizado en `chrome.storage.local` ante
  // CUALQUIER cambio (fire-and-forget, best-effort — un fallo acá nunca
  // debe romper el gráfico en memoria, que sigue siendo la fuente de
  // verdad mientras la pestaña siga abierta). Es lo que le permite
  // sobrevivir un F5 (ver el efecto de restauración, más arriba).
  useEffect(() => {
    if (!meetingCode) return;
    setStoredAttentionHistory(meetingCode, history);
  }, [meetingCode, history]);

  // Reset ÚNICO — ante un "class_started" GENUINO (clase nueva de cero),
  // nunca ante "class_ended" (la clase se detiene: el historial se
  // CONGELA tal cual, no se toca acá) ni "class_resumed" (sigue
  // acumulando sobre lo mismo). Ver `signalBaseRef` más arriba para el
  // porqué de comparar contra el valor de montaje, no reaccionar a
  // cualquier valor "truthy".
  useEffect(() => {
    if (!meetingCode) return;
    if (classStartedSignal === signalBaseRef.current) return;
    signalBaseRef.current = classStartedSignal;

    setHistory([]);
    setError(null);
    lastProcessedRosterRef.current = null;
    clearStoredAttentionHistory(meetingCode);
  }, [classStartedSignal, meetingCode]);

  return { history, loading, error, windowStartedAt };
}
