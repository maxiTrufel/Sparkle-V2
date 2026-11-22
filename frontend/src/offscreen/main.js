// Entry point del documento offscreen — el único lugar de la extensión donde
// puede correr la detección.
//
// Por qué acá y no en el content script: MediaPipe y LiteRT.js son ambos
// WebAssembly, y en Manifest V3 la ejecución de WASM necesita
// `'wasm-unsafe-eval'` en la CSP. Esa directiva se declara en
// `content_security_policy.extension_pages`, que aplica a las PÁGINAS de la
// extensión — un content script inyectado hereda la CSP de la página que lo
// hospeda (meet.google.com), sobre la que no tenemos control. Un documento
// offscreen es una página de extensión con su propia CSP, así que es el lugar
// correcto. El service worker tampoco sirve: no tiene DOM ni acceso a GPU.
//
// Por qué el offscreen abre su PROPIO stream de cámara en vez de recibir los
// cuadros del content script: `chrome.runtime.sendMessage` serializa los
// mensajes y no admite objetos transferibles, así que pasar un `ImageBitmap`
// por ahí obligaría a convertirlo a `ImageData` y copiar ~1,2 MB por cuadro
// (unos 7 MB/s a 6 fps). Pedir el stream directamente evita esa copia por
// completo. La contrapartida es que hay dos consumidores de la misma cámara
// mientras el preview del panel está visible; Chrome lo soporta y el indicador
// de cámara ya está encendido de todos modos, pero por eso el ciclo de vida se
// coordina explícitamente con los mensajes `iniciar`/`detener` que manda el
// panel a través del service worker.

import {
  initialize, processFrame, reset, isReady, windowProgress, configure, getConfiguration,
} from './detector.js';

let stream = null;
let video = null;
let loop = null;
let starting = false;
let lastError = null;

function log(message) {
  console.log(`[Sparkle][IA][offscreen] ${message}`);
}

/** Reporta al service worker, que lo reenvía al panel de la pestaña. */
function emit(event) {
  chrome.runtime.sendMessage({ type: 'attention_event', payload: event }).catch(() => {
    // El service worker puede estar suspendido o el panel desmontado; no es un
    // error recuperable ni vale la pena reintentar: la próxima predicción
    // llega en dos segundos.
  });
}

async function startDetection() {
  if (stream || starting) return;
  starting = true;
  lastError = null;

  try {
    if (!isReady()) {
      emit({ phase: 'loading' });
      await initialize({ onStatus: (m) => emit({ phase: 'loading', detail: m }) });
    }

    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
    });

    video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    // El elemento TIENE que estar en el DOM. Un <video> desprendido reproduce
    // el stream pero Chrome no lo compone, así que no produce cuadros
    // observables: `requestVideoFrameCallback` no dispara nunca y el bucle
    // queda mudo sin dar ningún error. El documento offscreen es invisible de
    // por sí, así que agregarlo no muestra nada en pantalla.
    video.style.position = 'absolute';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    document.body.appendChild(video);

    await video.play();

    // Esperar a que haya dimensiones reales: `play()` resuelve antes de que
    // llegue el primer cuadro decodificado, y MediaPipe necesita un cuadro con
    // ancho y alto distintos de cero.
    if (!video.videoWidth) {
      await new Promise((resolve) => {
        const onReady = () => { video.removeEventListener('loadeddata', onReady); resolve(); };
        video.addEventListener('loadeddata', onReady);
        setTimeout(resolve, 3000);
      });
    }

    reset();
    emit({ phase: 'active' });
    log(`detección iniciada — video ${video.videoWidth}x${video.videoHeight}, `
        + `readyState=${video.readyState}, pausado=${video.paused}`);

    // Traza del calentamiento: la primera predicción tarda 10 s (hay que llenar
    // la ventana), y sin esto la consola queda muda todo ese rato y parece
    // colgado. Se reporta cada 25 % y después solo las predicciones.
    let lastLoggedStage = -1;

    const onFrame = async (now) => {
      if (!stream) return;
      try {
        const result = await processFrame(video, now);
        if (result) {
          emit({ phase: 'active', ...result, progress: 1 });
          if (result.type === 'prediction') {
            log(
              `P(desatencion)=${result.pInattention.toFixed(3)} `
              + `-> ${result.state} (modelo: ${result.modelOpinion}) `
              + `| concentracion ${result.concentration}% `
              + `(modelo fran ${result.modelConcentration ?? '—'}% · modelo maxi ${result.faceConcentration ?? '—'}%) `
              + `| ventana ${result.windowSamples}/${(result.windowSpanMs / 1000).toFixed(0)}s`
              + `${result.windowFilled ? '' : ' (incompleta)'} `
              + `| sin rostro ${(result.noFaceFraction * 100).toFixed(0)}%`,
            );
          } else if (result.type === 'no_judgement') {
            // Sin este log la abstención es INVISIBLE: no habría forma de
            // distinguir "el sistema decidió no opinar" de "el sistema se
            // colgó", que es justo lo que hay que poder auditar.
            log(
              `SIN JUICIO — P(desatencion)=${result.pInattention.toFixed(3)} `
              + `a ${result.confidence.toFixed(3)} de la frontera `
              + `(margen ${result.confidenceMargin}) -> ${result.state} por el puntaje de cara`,
            );
          } else if (result.type === 'rule') {
            // La alerta declara su fuente. El docente tiene que poder
            // distinguir "el modelo estima desatención" de "esta persona tuvo
            // la cabeza girada 18 de los últimos 50 segundos": son afirmaciones
            // con respaldo distinto y el log es donde eso se audita.
            const d = result.detail;
            log(
              `REGLA ${result.source} — DESATENTO (confianza 1,0; modelo: ${result.modelOpinion}) `
              + `| desviado ${(d.fracDesviado * 100).toFixed(1)}% de la ventana `
              + `(racha ${d.rachaSeg.toFixed(1)}s) `
              + `| PERCLOS ${(d.perclos * 100).toFixed(1)}% `
              + `(cierre ${d.microsuenoSeg.toFixed(1)}s, base ${d.baselineEar === null ? 'sin calibrar' : d.baselineEar.toFixed(4)})`,
            );
          } else if (result.type === 'no_face') {
            log(`sin rostro en el ${(result.noFaceFraction * 100).toFixed(0)}% de la ventana: no se predice`);
          }
        } else {
          const progress = windowProgress();
          emit({ phase: 'active', progress });
          const stage = Math.floor(progress * 4);
          if (progress < 1 && stage !== lastLoggedStage) {
            lastLoggedStage = stage;
            log(`llenando la ventana de 10 s: ${Math.round(progress * 100)}%`);
          }
        }
      } catch (err) {
        lastError = err.message;
        log(`error procesando cuadro: ${err.message}`);
        console.error(err);
        emit({ phase: 'error', message: err.message });
      }
    };

    // Se usa `setInterval` y no `requestVideoFrameCallback` a propósito. rVFC
    // entrega un callback por cuadro decodificado, que suena ideal, pero
    // depende de que el compositor esté produciendo cuadros — en un documento
    // offscreen (que nunca se pinta) ese comportamiento no está garantizado, y
    // cuando no dispara lo hace en silencio, sin error. El detector filtra por
    // intervalo internamente, así que un temporizador de 100 ms alcanza:
    // muestrea geometría cada ~167 ms y apariencia cada ~625 ms igual, con un
    // comportamiento predecible y observable.
    loop = setInterval(() => {
      if (!stream || !video) return;
      if (video.readyState < 2) return;   // HAVE_CURRENT_DATA: todavía sin cuadro
      onFrame(performance.now());
    }, 100);
  } catch (err) {
    lastError = err.message;
    log(`no se pudo iniciar: ${err.name}: ${err.message}`);

    // `NotAllowedError` acá casi nunca significa que el usuario dijo que no:
    // este documento no puede recibir foco (ver la doc de `chrome.offscreen`),
    // así que Chrome descarta el diálogo de permisos sin llegar a mostrarlo y
    // devuelve "Permission dismissed". El permiso hay que pedirlo desde una
    // página visible de la extensión — `src/permission/main.js`. Se reporta
    // como fase propia para que el service worker la abra y el panel pueda
    // explicarlo, en vez de mostrar un error críptico.
    if (err.name === 'NotAllowedError') {
      emit({ phase: 'no_permission', message: 'Falta el permiso de cámara para la extensión' });
    } else if (err.name === 'NotFoundError') {
      emit({ phase: 'error', message: 'No se encontró ninguna cámara conectada' });
    } else {
      emit({ phase: 'error', message: err.message });
    }
    // Sin avisar `stopped`: ese evento borraba en el panel el aviso que se
    // acaba de mandar, y el recuadro quedaba sin ningún mensaje, como trabado.
    releaseCamera();
  } finally {
    starting = false;
  }
}

// Suelta la cámara y el bucle, sin avisarle nada al panel.
function releaseCamera() {
  if (loop) {
    clearInterval(loop);
    loop = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (video) {
    video.srcObject = null;
    video.remove();          // sale del DOM del documento offscreen
    video = null;
  }
  reset();
}

function stopDetection() {
  releaseCamera();
  emit({ phase: 'stopped' });
  log('detección detenida');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  if (message.type === 'start_detection') {
    startDetection();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'stop_detection') {
    stopDetection();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'configure_detection') {
    // No depende de `stream`/`ready` — se puede ajustar ANTES de arrancar la
    // cámara (el panel de ajuste rápido no obliga a tener la detección
    // corriendo), `detector.js` guarda el valor en su propio estado de
    // módulo y lo aplica a partir de la próxima predicción.
    const configuration = configure(message.payload);
    sendResponse({ ok: true, configuration });
    return false;
  }
  if (message.type === 'detection_status') {
    sendResponse({
      active: Boolean(stream),
      ready: isReady(),
      progress: windowProgress(),
      error: lastError,
      configuration: getConfiguration(),
    });
    return false;
  }
  return false;
});

log('documento offscreen cargado');
