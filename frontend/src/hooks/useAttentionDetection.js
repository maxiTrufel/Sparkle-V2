import { useEffect, useRef, useState } from 'react';
import { startAttentionDetection, stopAttentionDetection } from '../services/backendMessaging';

// Detección de atención en vivo (primera funcionalidad real de IA del
// proyecto — reemplaza los datos mock de `screens/ConcentrationStats.jsx`).
//
// El modelo corre ENTERO en el dispositivo, dentro de un documento offscreen de
// la extensión: ni un cuadro de video ni un recorte del rostro salen de la
// máquina del alumno, ni siquiera hacia el backend propio. Lo único que este
// hook llega a ver es un número entre 0 y 1. Ver `src/offscreen/main.js` y la
// ficha técnica del modelo para el contrato completo de privacidad.
//
// La condición de activación es DELIBERADAMENTE la misma que la del preview de
// cámara (`useCameraPreference`): switch encendido + clase activa + en llamada.
// No hay ninguna vía por la que la detección arranque sin que el usuario haya
// habilitado la cámara explícitamente, y cualquier transición que apague ese
// switch corta también la detección — el documento offscreen se cierra y
// suelta el stream, no solo deja de predecir.
//
// El modelo necesita una ventana COMPLETA de 10 segundos antes de emitir su
// primera predicción (se entrenó sobre clips de esa duración), así que hay un
// período de calentamiento tras activar el switch. `progress` va de 0 a 1 para
// que la interfaz pueda mostrarlo en vez de aparentar estar colgada.

const INITIAL_STATE = {
  phase: 'idle', // idle | loading | warming | active | error | no_face | no_permission | stopped
  detail: null,
  progress: 0,
  concentration: null,
  pInattention: null,
  inattentive: null,
  threshold: null,
  noFaceFraction: null,
  faceConcentration: null,
  modelConcentration: null,
  lastUpdated: null,
  error: null,
};

export function useAttentionDetection({ active }) {
  const [state, setState] = useState(INITIAL_STATE);
  // Historial en memoria para la tendencia del panel. No se persiste ni se
  // envía: si la pestaña se cierra, se pierde, que es el comportamiento
  // deseado para un dato derivado del rostro de una persona.
  const historyRef = useRef([]);
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;

  useEffect(() => {
    if (!active) return undefined;

    let cancelled = false;
    historyRef.current = [];
    setState({ ...INITIAL_STATE, phase: 'loading' });

    const start = () => {
      startAttentionDetection().catch((err) => {
        if (cancelled) return;
        console.log(`[Sparkle] Error iniciando la detección de atención: ${err.message}`);
        setState((prev) => ({ ...prev, phase: 'error', error: err.message }));
      });
    };

    const onMessage = (message) => {
      if (cancelled) return;

      // Etapa 85 — el usuario concedió el permiso en la pestaña que abrió la
      // extensión. Lo pide el panel (y no el service worker por su cuenta)
      // porque el service worker pudo haberse reiniciado mientras tanto y
      // olvidado qué pestañas esperaban la cámara: así la detección arranca
      // igual, sin tener que apagar y prender el interruptor.
      if (message?.type === 'SPARKLE_CAMERA_PERMISSION_GRANTED') {
        if (['no_permission', 'error', 'idle'].includes(phaseRef.current)) {
          setState({ ...INITIAL_STATE, phase: 'loading' });
          start();
        }
        return;
      }

      if (message?.type !== 'SPARKLE_ATTENTION_EVENT') return;
      const p = message.payload || {};

      if (p.phase === 'no_permission') {
        // El documento offscreen no puede mostrar el diálogo de permisos (no
        // recibe foco), así que el service worker abre una pestaña visible que
        // lo pide. Se distingue de un error genérico para que la interfaz
        // pueda explicar qué está pasando en vez de mostrar un fallo opaco.
        setState((prev) => ({
          ...prev,
          phase: 'no_permission',
          detail: 'Se abrió una pestaña para conceder el permiso de cámara a la extensión',
          error: null,
        }));
        return;
      }
      if (p.phase === 'error') {
        setState((prev) => ({ ...prev, phase: 'error', error: p.message || 'Error de detección' }));
        return;
      }
      if (p.phase === 'loading') {
        setState((prev) => ({ ...prev, phase: 'loading', detail: p.detail || null }));
        return;
      }
      if (p.phase === 'stopped') {
        setState(INITIAL_STATE);
        return;
      }

      if (p.type === 'no_face') {
        // `detector.js` no manda `ts` para este caso (no es una "predicción"
        // con salida del modelo, es un descarte previo) — se estampa acá,
        // del lado del cliente, únicamente para que quien consuma
        // `lastUpdated` (hoy: `ui/AttentionDebugLog.jsx`, ver ese
        // archivo) pueda distinguir una evaluación sin rostro NUEVA de
        // seguir en la misma sin cambios, igual que ya hace con
        // `type: 'prediction'`. El desfase de reloj es despreciable: el
        // mensaje llega por `chrome.runtime` casi al instante de emitirse.
        //
        // Regla global — sin rostro = desatento: `inattentive: true` explícito
        // acá, no heredado del `...prev` (antes este spread dejaba pegado el
        // `inattentive` de la ÚLTIMA predicción real, así que un alumno que
        // pasaba de "atento" a "sin rostro" seguía leyendo `inattentive:
        // false` — stale — hasta la próxima predicción real). `concentration`
        // SÍ sigue en `null`: eso es una medición que el modelo nunca
        // calculó para esta ventana, algo distinto de la clasificación
        // atento/desatento, que acá SIEMPRE tiene una respuesta definida.
        setState((prev) => ({
          ...prev,
          phase: 'no_face',
          eventType: 'no_face',
          windowFilled: null,
          pInattention: null,
          detail: p.message,
          progress: 1,
          concentration: null,
          inattentive: true,
          // Mismo motivo por el que `inattentive` se pone explícito arriba: este
          // spread arrastraría el `ruleSource` de la última activación de regla
          // y la interfaz declararía "cabeza girada" sobre una ventana en la que
          // ni siquiera hay rostro. Se limpia.
          ruleSource: null,
          ruleDetail: null,
          noFaceFraction: p.noFaceFraction ?? null,
          faceConcentration: p.faceConcentration ?? null,
          modelConcentration: null,
          lastUpdated: Date.now(),
        }));
        return;
      }

      if (p.type === 'rule') {
        // Una regla geométrica se activó (R1 mirada fuera de pantalla, R2
        // somnolencia). Tiene PRIORIDAD sobre el modelo y no es una estimación
        // sino una condición verificada sobre el video, así que entra por la
        // fase `active` —es un juicio emitido, no una ausencia de juicio— pero
        // con `concentration: 0` y `ruleSource` para que la interfaz pueda
        // declarar de dónde viene.
        //
        // Se empuja al historial igual que una predicción: para el panel del
        // docente esta ventana ES desatención, y omitirla dejaría un hueco
        // justo en los tramos más inequívocos.
        const ruleConcentration = p.concentration ?? 0;
        historyRef.current.push({ ts: p.ts, concentration: ruleConcentration });
        const cutoff = Date.now() - 20 * 60 * 1000;
        historyRef.current = historyRef.current.filter((m) => m.ts >= cutoff);

        setState((prev) => ({
          ...prev,
          phase: 'active',
          detail: p.message,
          progress: 1,
          concentration: ruleConcentration,
          inattentive: p.inattentive ?? true,
          faceConcentration: p.faceConcentration ?? null,
          modelConcentration: p.modelConcentration ?? null,
          eventType: 'rule',
          windowFilled: null,
          dinamica: p.dinamica ?? null,
          // El modelo NO se consulto en esta ventana (la regla tiene prioridad
          // y `predict()` devuelve antes de la inferencia), de modo que no hay
          // probabilidad que informar. Explicito, porque el spread `...prev`
          // arrastraria la de la ultima prediccion real y quedaria una P que
          // este veredicto nunca usa -- el mismo defecto de estado pegado que
          // ya se corrigio dos veces en este archivo.
          pInattention: null,
          modelAbstained: false,
          rulesEvaluated: true,
          ruleSource: p.source,
          ruleDetail: p.detail ?? null,
          noFaceFraction: p.noFaceFraction ?? null,
          lastUpdated: Date.now(),
        }));
        return;
      }

      if (p.type === 'no_judgement') {
        // ── El modelo se abstuvo ─────────────────────────────────────────────
        // ANTES ESTA RAMA NO EXISTÍA, y era un defecto con consecuencia visible:
        // el mensaje llegaba, ninguna condición lo tomaba, y el estado CONSERVABA
        // EL ÚLTIMO VALOR. Como el modelo se abstiene en rachas largas (se
        // midieron 30 seguidas), una sola predicción `desatento` quedaba clavada
        // en pantalla durante minutos. La única forma de destrabarlo era tapar la
        // cámara, porque `no_face` era la otra única rama que escribía estado.
        //
        // Además anulaba en la práctica el mecanismo que el trabajo reporta y
        // defiende: la abstención se decidía en el detector y se descartaba acá,
        // de modo que la interfaz mostraba justamente el valor que el modelo
        // había declarado no sostener.
        //
        // QUÉ SE MUESTRA AHORA. Si las reglas alcanzaron a evaluarse y ninguna
        // se activó, el sistema **observó y no encontró evidencia de
        // desatención**: se reporta ATENTO. La definición operativa de
        // desatención del proyecto son los eventos observables que detectan las
        // reglas, y la opinión del modelo por debajo de su margen de confianza es
        // por definición insuficiente para contradecirlas (`Enmienda_7`).
        //
        // Si las reglas todavía NO se evaluaron (faltan 50 s de historia
        // geométrica), no hay evidencia de ninguna de las dos capas: ahí sí
        // corresponde no afirmar nada.
        const sinEvidencia = p.rulesEvaluated === true;
        // Con el puntaje de cara disponible, el detector ya manda `concentration`
        // e `inattentive` calculados solo con él. Sin él, `concentration` queda en
        // `null`: el modelo NO sostiene una medición para esta ventana.
        const faceOnly = p.concentration ?? null;
        if (faceOnly !== null) {
          historyRef.current.push({ ts: p.ts, concentration: faceOnly });
          const cutoff = Date.now() - 20 * 60 * 1000;
          historyRef.current = historyRef.current.filter((m) => m.ts >= cutoff);
        }
        setState((prev) => ({
          ...prev,
          phase: 'active',
          detail: sinEvidencia || faceOnly !== null ? null : p.message,
          progress: 1,
          concentration: faceOnly,
          inattentive: typeof p.inattentive === 'boolean' ? p.inattentive : (sinEvidencia ? false : null),
          faceConcentration: p.faceConcentration ?? null,
          modelConcentration: null,
          eventType: 'no_judgement',
          dinamica: p.dinamica ?? null,
          windowFilled: p.windowFilled === true,
          // La P de ESTA ventana, no la de la ultima prediccion emitida: el
          // detector la manda en el propio mensaje. Es ademas el campo que la
          // medicion de cobertura efectiva necesita, y heredarlo lo inutiliza.
          pInattention: p.pInattention ?? null,
          modelAbstained: true,
          rulesEvaluated: p.rulesEvaluated === true,
          ruleSource: null,
          ruleDetail: null,
          noFaceFraction: p.noFaceFraction ?? null,
          lastUpdated: Date.now(),
        }));
        return;
      }

      if (p.type === 'prediction') {
        historyRef.current.push({ ts: p.ts, concentration: p.concentration });
        // Ventana de 20 minutos, que es lo que muestra el panel del docente
        const cutoff = Date.now() - 20 * 60 * 1000;
        historyRef.current = historyRef.current.filter((m) => m.ts >= cutoff);

        setState({
          phase: 'active',
          detail: null,
          progress: 1,
          modelAbstained: false,
          eventType: 'prediction',
          dinamica: p.dinamica ?? null,
          windowFilled: p.windowFilled === true,
          rulesEvaluated: p.rulesEvaluated === true,
          concentration: p.concentration,
          pInattention: p.pInattention,
          inattentive: p.inattentive,
          // Refleja el umbral REAL con el que se evaluó esta predicción
          // puntual (`detector.js` lo devuelve en cada predicción, ver
          // `predict()`) — no un valor fijo del lado del cliente: si el
          // panel de ajuste rápido lo cambió a mitad de clase, esto ya lo
          // muestra correcto sin que este hook tenga que saber nada de esa
          // configuración.
          threshold: p.threshold,
          // El modelo la devuelve en TODA predicción (ver
          // `detector.js#predict`), no solo en el descarte `no_face` —
          // antes se perdía acá para el caso normal, dejando ese porcentaje
          // fuera del log de debug (`AttentionDebugLog.jsx`) aunque el
          // modelo sí lo hubiera calculado para esta ventana.
          noFaceFraction: p.noFaceFraction ?? null,
          faceConcentration: p.faceConcentration ?? null,
          modelConcentration: p.modelConcentration ?? null,
          lastUpdated: p.ts,
          error: null,
        });
        return;
      }

      // Evento de progreso mientras se llena la ventana de 10 s
      if (typeof p.progress === 'number' && p.progress < 1) {
        setState((prev) => ({ ...prev, phase: 'warming', progress: p.progress }));
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);
    start();

    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(onMessage);
      // Se corta siempre, incluso si el arranque había fallado: el documento
      // offscreen puede haber quedado a medio iniciar con la cámara ya tomada.
      stopAttentionDetection().catch((err) => {
        console.log(`[Sparkle] Error deteniendo la detección de atención: ${err.message}`);
      });
      setState(INITIAL_STATE);
    };
  }, [active]);

  return { ...state, history: historyRef.current };
}
