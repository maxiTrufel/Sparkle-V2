# Sparkle V2

Extensión de Chrome para Google Meet con detección de atención mediante IA.

## Estructura del proyecto

- `public/manifest.json` — manifest de la extensión (Manifest V3).
- `src/App.jsx` — router raíz: decide qué pantalla mostrar dentro del panel, según el estado de la llamada y el rol resuelto para la reunión.
- `src/content/main.jsx` — content script: monta `<App/>` dentro de un Shadow DOM inyectado en `meet.google.com`. Corre en el origen de la página, así que no llama al backend directamente (ver más abajo).
- `src/background/main.js` — service worker de la extensión: recibe mensajes del content script (`chrome.runtime.onMessage`) y es quien efectivamente llama al backend por HTTP/WebSocket (`src/services/`).
- `src/screens/` — pantallas completas que `App.jsx` monta según el estado del router: `Welcome`, `ConfirmarDocente`, `NombreAlumno`, `PanelDocente`, `PanelAlumno`, `HistorialAlumnos`, `LobbyScreen`, `CallEndedScreen`.
- `src/ui/` — componentes reutilizables/presentacionales que las pantallas usan como ingrediente: `Header`, `ToggleTab`, `CameraSwitch`, `CameraPreviewBox`, `icons` (íconos SVG inline compartidos).
- `src/hooks/` — lógica de estado/efectos de React extraída para que `App.jsx` no la mezcle con el routing: `useCallStage` (suscripción al estado de la llamada), `useResolucionRolInicial` (boot: email + rol + si ya hay un docente), `useClaseEnVivo` (unión a la sala WS, keepalive, eventos en vivo), `useCameraPreference` (herramienta de prueba de preview de cámara).
- `src/services/` — comunicación con el exterior: `api.js` (llamadas `fetch` reales al backend; solo las usa `background/main.js`), `backendMessaging.js` (la misma API para el content script, vía `chrome.runtime.sendMessage` en vez de `fetch` directo), `wsClient.js` (WebSocket real; solo lo usa `background/main.js`).
- `src/utils/` — utilidades puras, sin React ni red: `callStage.js` (detección de lobby/en-llamada/salida por DOM), `detectEmail.js`, `meetContext.js`, `storage.js` (sin uso actualmente), `togglePosition.js`, `conTimeout.js`.
- `src/styles/panel.css` — estilos del panel (se inyectan dentro del Shadow DOM).

Ver [DOCUMENTACION.md](../DOCUMENTACION.md), "Etapa 2 de limpieza", para el criterio completo detrás de esta separación (`screens/` vs `ui/` vs `hooks/` vs `services/` vs `utils/`).

Proyecto en JavaScript puro (sin TypeScript): sin `tsconfig.json` ni dependencias `@types/*`. Ver [DOCUMENTACION.md](../DOCUMENTACION.md) para el detalle de decisiones de arquitectura y el historial de cambios — en particular la Etapa 8, que explica por qué el backend se llama desde el background script y no desde el content script.

## Compilar (build)

```bash
npm install
npm run build
```

Esto genera la carpeta `dist/` con `manifest.json`, `content.js` y `background.js`, listos para cargar en Chrome. `npm run build` corre Vite dos veces (una por cada entry point — Rollup no soporta más de un entry point en un mismo bundle IIFE) y limpia `dist/` una sola vez antes de arrancar. También existe `npm run dev`, que corre ambos builds con `--watch` en paralelo y recompila automáticamente ante cada cambio (hay que recargar la extensión en `chrome://extensions` para ver los cambios).

## Cargar la extensión en Chrome

1. Ejecutar `npm run build` para generar `dist/`.
2. Abrir `chrome://extensions` en Chrome.
3. Activar el **Modo de desarrollador** (switch arriba a la derecha).
4. Click en **Cargar descomprimida** ("Load unpacked").
5. Seleccionar la carpeta `dist/` del proyecto.
6. Entrar a una videollamada en `https://meet.google.com/...`. El panel de Sparkle V2 debería aparecer fijo del lado derecho de la pantalla.

Cada vez que se modifique el código y se vuelva a correr `npm run build` (o mientras corre `npm run dev`), hay que ir a `chrome://extensions` y apretar el botón de recargar (⟳) en la tarjeta de la extensión para que tome los cambios — esto reinicia también el service worker. Si se editó el content script, además conviene recargar la pestaña de Meet.

## Subir a la Chrome Web Store

### Rechazos que ya tuvimos

| Versión | Violación | Qué marcaron | De dónde venía | Arreglo |
|---|---|---|---|---|
| 0.1.2 | **Blue Argon** (código remoto) | Una URL de cdnjs (PDFObject) en `content.js` | **jsPDF**, en `output('pdfobjectnewwindow')` | `sinCodigoRemoto()` + `verificar-sin-codigo-remoto.js` |
| — | `key field is not allowed in manifest` | El campo `key` del manifest | Nuestro manifest (sirve para la versión descomprimida) | El deploy arma dos zip: con `key` y sin `key` (`deploy.yml`) |
| 0.1.7 | **Red Titanium** (código ofuscado) | core-js minificado | **jsPDF** (vía canvg) | `minify: false`, jsPDF legible, sin decodificador WebP (Etapa 81) |
| 0.1.9 | **Red Titanium** (código ofuscado) | core-js legible: `ActiveXObject`, iframe `javascript:`, `document.write` | **jsPDF** (vía canvg) | Sin canvg, html2canvas, DOMPurify ni salidas a ventana nueva (Etapa 88) |

**3 de los 4 vinieron de jsPDF**, no de nuestro código. jsPDF trae adentro muchas cosas que el informe no usa (dibujos SVG, convertir HTML en PDF, abrir el PDF en otra ventana), y como la extensión se compila en un solo archivo, todo eso entraba al paquete.

### Qué acepta y qué no la Store

- **Se acepta** la minificación: sacar espacios y comentarios, **acortar nombres de variables** y juntar archivos. Por eso React y MediaPipe, que vienen con nombres cortos de fábrica, están bien.
- **No se acepta** lo que parece esconder qué hace la extensión: scripts cargados de otro servidor, código armado a partir de texto (`eval`, `new Function`), scripts o HTML inyectados en otra ventana, trucos para navegadores viejos como `ActiveXObject`. El revisor lo marca aunque sea código de una librería y nunca se ejecute.

### Antes de subir

1. Se sube **`extension-store-vX.Y.Z.zip`** del Release, el que dice "store". El otro trae `key` y la Store lo rechaza.
2. No subir otro paquete mientras haya uno en revisión.
3. Los tags no se reusan: si rechazan una versión, el arreglo sale con el número siguiente.
4. `npm run build` tiene que pasar los dos controles (el deploy los corre solo, y si fallan no hay zip):
   - `verificar-sin-codigo-remoto`: ninguna URL de script remoto.
   - `verificar-codigo-legible`: nada minificado, y nada de core-js, `ActiveXObject`, `document.write`, URLs `javascript:`, `eval`, `new Function` ni `<script>` armados a mano (salvo el de MediaPipe en el offscreen).

### Al actualizar o sumar una librería

- **jsPDF:** `vite.config.js` le recorta cuatro partes (la URL de cdnjs, el decodificador WebP, las cargas de canvg/html2canvas/DOMPurify y las salidas a ventana nueva). Si una versión nueva cambia ese código, el build falla con "No se encontró … dentro de jsPDF". Eso es a propósito: hay que revisar el recorte, no sacarlo.
- **Cualquier librería nueva:** después de `npm run build`, si alguno de los dos controles falla, fijarse de qué librería viene (`npm ls <paquete>`) y si esa parte se usa. Si no se usa, recortarla en `vite.config.js` como las de jsPDF.

### Si igual la rechazan

1. Leer el fragmento que viene en el mail y buscarlo en `dist/content.js` (o en el archivo que diga).
2. Ver de qué librería es y si Sparkle lo usa.
3. Sacarlo en la compilación y sumar el patrón a `verificar-codigo-legible.js`, así no vuelve.
4. Documentarlo como una Etapa nueva y agregar una fila a la tabla de arriba.
