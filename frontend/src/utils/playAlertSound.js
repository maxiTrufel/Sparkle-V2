// Beep discreto para notificaciones — generado con Web Audio API porque el
// proyecto no tiene assets de audio (agregar un archivo binario al bundle de
// la extensión solo para un beep sería desproporcionado). Un único
// `AudioContext` compartido por pestaña: crear uno nuevo por notificación los
// va acumulando sin cerrar, y los navegadores limitan cuántos pueden existir
// vivos a la vez.
let ctx = null;

function getContext() {
  if (!ctx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    ctx = new AudioContextClass();
  }
  return ctx;
}

/**
 * Tono único, corto y suave (envolvente con fade in/out, sin ataque seco) —
 * "discreto, no intrusivo" a propósito: pensado para acompañar una
 * notificación visual, no para llamar la atención por sí solo.
 */
export function playAlertSound() {
  try {
    const audioCtx = getContext();
    // Los navegadores arrancan el `AudioContext` en 'suspended' hasta el
    // primer gesto del usuario en la página — para cuando esto suena (varias
    // predicciones después de que el alumno ya interactuó con el panel) ya
    // debería estar 'running', pero se intenta resumir por las dudas.
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    const now = audioCtx.currentTime;
    const durationSeconds = 0.35;
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, now);

    // Pico de ganancia bajo (0.08) + rampas lineales de subida/bajada en vez
    // de un gain fijo: evita el "click" seco de prender/apagar un oscilador
    // de golpe.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.02);
    gain.gain.linearRampToValueAtTime(0, now + durationSeconds);

    oscillator.connect(gain);
    gain.connect(audioCtx.destination);

    oscillator.start(now);
    oscillator.stop(now + durationSeconds);
  } catch (err) {
    // Best-effort — un navegador sin Web Audio, o un AudioContext que no
    // pudo resumirse, no tiene por qué romper la notificación VISUAL, que es
    // la parte que de verdad importa.
    console.log(`[Sparkle] No se pudo reproducir el sonido de alerta: ${err.message}`);
  }
}
