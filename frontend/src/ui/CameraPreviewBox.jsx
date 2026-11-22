// Recuadro flotante del preview (Etapa 64 — vive FUERA de `.sparkle-panel`
// por completo, ver el punto de montaje en `App.jsx` como hermano de
// `<ToggleTab />`, y su posicionamiento en panel.css). Solo se muestra si
// `active` (switch + clase activa a la vez), o el mensaje de error si el
// intento más reciente falló. Puramente presentacional — toda la lógica
// vive en `useCameraPreference` (`hooks/useCameraPreference.js`).
//
// Detección de atención: se le superpone el estado que devuelve
// `useAttentionDetection`. Va acá y no en una pantalla propia porque es el
// único lugar donde el alumno ya está viendo su propia cámara, así que la
// relación entre "lo que se está analizando" y "lo que el modelo dice" queda
// explícita. Sigue siendo un componente presentacional: recibe `attention`
// resuelto y no consulta nada por su cuenta.
//
// `debugToolsVisible` — controlado por el switch "Modo debug" de
// `AttentionSettingsPanel.jsx` (vía `App.jsx`): tiene que ser PURAMENTE
// visual, nunca desmontar nada. Corrección: la primera versión de esto hacía
// `if (!debugToolsVisible) return null` ANTES de la rama `active`, lo que sí
// desmontaba el `<video>` cuando `active` seguía siendo `true` — el efecto de
// `useCameraPreference` que le asigna `videoRef.current.srcObject = stream`
// corre UNA sola vez (dependencias `[active, meetingCode, email]`, ninguna
// tocada por este switch), así que un `<video>` recién remontado nunca
// recuperaba el stream: el preview quedaba en negro al volver a prender el
// switch, aunque la cámara real siguiera prendida. Ahora, mientras `active`
// sea `true`, el `<video>` NUNCA se desmonta por este motivo — el switch solo
// agrega/saca una clase CSS (`--oculto`) sobre el mismo árbol. El stream real
// (`getUserMedia`) vive en `useCameraPreference` de todos modos, y la
// detección de atención corre en el documento offscreen con su PROPIO stream
// independiente (ver `offscreen/main.js`) — ninguno de los dos dependía
// nunca de este componente, pero ahora tampoco el `<video>` en sí.

function statusText(attention) {
  switch (attention?.phase) {
    case 'loading':
      return { text: attention.detail || 'Cargando modelo…', tone: 'neutro' };
    case 'warming':
      return {
        text: `Analizando… ${Math.round((attention.progress || 0) * 100)}%`,
        tone: 'neutro',
      };
    case 'no_face':
      return { text: 'No se detecta el rostro', tone: 'aviso' };
    case 'no_permission':
      return { text: 'Falta permiso de cámara', tone: 'aviso' };
    case 'error':
      return { text: attention.error || 'Error de detección', tone: 'error' };
    case 'active':
      return null; // se muestra el valor, no un texto de estado
    default:
      return null;
  }
}

// Corrección (auditoría de colores) — bug real: acá había TRES niveles de
// color (verde/amarillo/rojo, con una "banda de aviso" de 15 puntos
// hardcodeada entre el verde y el rojo). Pedido explícito: en TODO el
// sistema solo existen dos colores posibles — verde (atento) y rojo
// (desatento) — nunca un tercer estado intermedio, y el corte entre ambos
// es SIEMPRE el umbral Y vigente, nunca un margen fijo aparte. Esta función
// es ahora el único lugar de este archivo que decide el color, y solo tiene
// dos salidas posibles.
function concentrationColor(concentration, threshold) {
  // `threshold` YA es la concentración mínima de "atento", en fracción (0-1) —
  // se escala directo a porcentaje (0-100), sin invertir (`1 - umbral`, como
  // antes de la Corrección de semántica de Y, ya NO aplica). `>` estricto,
  // no `>=` — mismo corte que `detector.js#predecir` (`desatento:
  // concentracionFraccion <= umbral`): en el límite EXACTO
  // (concentración == umbral) el modelo ya clasifica `desatento: true`, así
  // que el color tiene que coincidir con esa clasificación real. Mismo
  // corte que `isAttentive()` en `screens/ConcentrationStats.jsx`.
  const thresholdPct = (threshold ?? 0.6) * 100;
  return concentration > thresholdPct ? 'verde' : 'roja';
}

export function CameraPreviewBox({
  active, error, videoRef, attention, inattentiveInWindow = 0, k = null, debugToolsVisible = true,
}) {
/**
 * Texto del tooltip de la insignia de atención.
 *
 * NO se puede asumir que `pInattention` exista siempre que haya `concentration`.
 * Cuando una regla geométrica se activa, el modelo NO SE CONSULTA —la regla
 * tiene prioridad y `predict()` devuelve antes de la inferencia—, de modo que
 * hay `concentration` (0) y NO hay probabilidad.
 *
 * Ese supuesto roto causaba un `TypeError: Cannot read properties of null
 * (reading 'toFixed')` durante el render. Sin Error Boundary en el árbol, la
 * excepción desmontaba TODO `App`, el cleanup de `useLiveClass` cerraba el
 * WebSocket sin argumentos (`code=1005`) y el backend finalizaba la clase por
 * "desconexión del docente". Cuatro cortes de clase en dos horas de prueba, que
 * parecían de red y eran esto. Mismo encadenamiento que documenta
 * `tests/App.regresionCrashModoAtencion.test.js`.
 */
function tituloDeLaInsignia(attention) {
  if (attention.ruleSource) {
    const detalle = attention.ruleSource === 'R1'
      ? 'cabeza orientada fuera de la pantalla'
      : 'signos de somnolencia sostenidos';
    return `Regla ${attention.ruleSource} — ${detalle}. `
      + 'Condición verificada sobre el video: no se consultó al modelo.';
  }
  // Se liga a un local DESPUÉS de la guarda, en vez de volver a acceder al
  // campo: así el uso es seguro por construcción y no depende de que quien lea
  // el código recuerde que hay un `if` más arriba.
  const p = attention.pInattention;
  if (typeof p !== 'number') {
    return `Umbral ${attention.threshold ?? 0.6}`;
  }
  return `P(desatención) = ${p.toFixed(3)} · umbral ${attention.threshold ?? 0.6}`;
}

  if (active) {
    const status = statusText(attention);
    const measuring = attention?.phase === 'active' && attention.concentration !== null;
    const color = measuring ? concentrationColor(attention.concentration, attention.threshold) : null;

    return (
      <div className={`sparkle-camera-preview ${debugToolsVisible ? '' : 'sparkle-camera-preview--oculto'}`}>
        <video ref={videoRef} autoPlay muted playsInline className="sparkle-camera-video" />

        {measuring && (
          <div
            className={`sparkle-attention-badge sparkle-attention-badge--${color}`}
            title={tituloDeLaInsignia(attention)}
          >
            <span className="sparkle-attention-badge-value">{attention.concentration}%</span>
            <span className="sparkle-attention-badge-label">atención</span>
            {k !== null && (
              <span className="sparkle-attention-badge-ventana" title="Capturas desatentas en la ventana / tamaño de la ventana (K)">
                {inattentiveInWindow}/{k}
              </span>
            )}
          </div>
        )}

        {status && (
          <div className={`sparkle-attention-status sparkle-attention-status--${status.tone}`}>
            {status.text}
          </div>
        )}
      </div>
    );
  }

  if (error) {
    // Acá sí alcanza con no renderizar nada si el switch está apagado — a
    // diferencia de la rama `active` de arriba, no hay ningún `<video>` ni
    // binding que preservar en este caso.
    if (!debugToolsVisible) return null;
    return (
      <div className="sparkle-camera-preview sparkle-camera-preview--error">
        <p className="sparkle-text sparkle-text-error">{error}</p>
      </div>
    );
  }

  return null;
}
