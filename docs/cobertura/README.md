# Cobertura de tests

Medida el 10/10/2026 con **c8 10.1.3** (cobertura nativa de V8), sobre el commit
siguiente a `0e5d79b`. Umbral obligatorio: **85 % de líneas y de sentencias** en
cada paquete, configurado en `backend/.c8rc.json` y `frontend/.c8rc.json` y
exigido por el CI (`.github/workflows/ci.yml`, pasos "Tests con cobertura").

```bash
cd backend && npm run test:coverage    # necesita MariaDB con el esquema migrado
cd frontend && npm run test:coverage   # ídem (7 archivos levantan el backend real)
```

## Resultado

| Paquete  | Tests | Líneas  | Sentencias | Ramas  | Funciones |
|----------|------:|--------:|-----------:|-------:|----------:|
| Backend  |   198 | 93,46 % | 93,46 %    | 84,25 % | 92,04 %  |
| Frontend |   293 | 92,50 % | 92,50 %    | 88,24 % | 80,96 %  |
| **Total**|   491 | **92,84 %** (22.597 / 24.340) | **92,84 %** | 86,73 % (3.092 / 3.565) | 85,14 % (653 / 767) |

El total suma las líneas, ramas y funciones de los dos paquetes. El umbral se
exige solo sobre líneas y sentencias: ramas del backend (84,25 %) y funciones
del frontend (80,96 %) quedan por debajo del 85 %.

Archivos de esta carpeta:

- `backend-coverage-summary.json`, `frontend-coverage-summary.json`: resumen por archivo (formato istanbul `json-summary`).
- `captura-cobertura-backend.png`, `captura-cobertura-frontend.png`: portada del reporte HTML (`<paquete>/coverage/index.html`).

### Nota de método

c8 trabaja por línea a partir de los rangos ejecutados que reporta V8; por eso
"líneas" y "sentencias" dan el mismo número. Una línea cuenta como cubierta si
no cae dentro de un rango que V8 marcó como no ejecutado (los comentarios
dentro de código ejecutado cuentan como cubiertos, y los que están dentro de
código no ejecutado, como no cubiertos).

Las pantallas de React no se pueden importar directo en Node (JSX): los tests
las empaquetan con esbuild (`tests/helpers/reactHarness.js`). Al medir
cobertura, ese paquete lleva source map y se conserva hasta el reporte, para que
c8 atribuya cada línea a su archivo de `src/`. El patrón `file:/**/frontend/src/**`
del `include` de `frontend/.c8rc.json` hace falta porque `v8-to-istanbul`
compara contra el filtro la ruta de cada fuente del source map en formato URL
(`file:///…`); sin él, el filtro descarta los tramos no ejecutados y las
pantallas aparecen con un 100 % falso.

## Exclusiones

Solo se excluye código que no puede correr en Node. Todo lo demás de
`backend/src` y `frontend/src` se mide, aunque ningún test lo cargue
(`"all": true`: un archivo sin tests cuenta como 0 %).

| Archivo | Por qué se excluye |
|---|---|
| `backend/src/server.js` | Punto de entrada: abre el puerto, arma CORS con las variables de entorno de producción y monta el WebSocket. Los tests montan el mismo router (`routes/meetings.js`) y el mismo `startWebSocketServer` en un puerto efímero, así que lo que hay detrás sí se mide. |
| `frontend/src/content/main.jsx` | Punto de entrada del content script: monta React dentro de la página de Meet. `App.jsx`, que es lo que monta, sí se mide. |
| `frontend/src/background/main.js` | Punto de entrada del service worker: registra los listeners de `chrome.runtime`/`chrome.tabs`/`chrome.alarms`. Las funciones a las que despacha (`services/api.js`, `services/wsClient.js`, `background/attentionOffscreen.js`) sí se miden. |
| `frontend/src/offscreen/main.js` | Punto de entrada del documento offscreen: abre la cámara (`getUserMedia`) y arranca el detector. |
| `frontend/src/permission/main.js` | Punto de entrada de `permission.html`: pide el permiso de cámara del navegador. |
| `frontend/src/offscreen/detector.js` | Detector con MediaPipe FaceLandmarker (WebAssembly + WebGL) sobre cuadros de video del navegador. Su lógica de ventana y abstención se prueba aparte (`detector.ventanaYAbstencion.test.js`), y los módulos que usa (features, preprocesamiento, ensemble, reglas, veredicto) se miden. |
| `frontend/src/offscreen/inference.js` | Ejecuta los modelos TFLite con LiteRT.js (WebAssembly/WebGPU del navegador). |
| `frontend/src/utils/playAlertSound.js` | Sonido de alerta con la Web Audio API, que no existe en Node ni en jsdom. |

## Tests por categoría

**Frontend** (mismas categorías que la Tabla 6.1 de la tesis):

| Categoría | Antes | Ahora | Archivos nuevos |
|---|---:|---:|---|
| Detección | 89 | 119 | `features.extraccion` (10), `preprocessing.secuencias` (8), `ensemble.cargaYPrediccion` (3), `attentionOffscreen.ciclo` (9) |
| Reglas | 32 | 32 | — |
| Comunicación | 23 | 45 | `api.endpoints` (22) |
| Interfaz | 72 | 97 | `pantallas.alumnoFinDeClase` (9), `pantallas.docente` (10), `generateClassReport.pdf` (6) |
| **Total** | **216** | **293** | |

**Backend** (agrupación nueva, por área):

| Área | Archivos | Antes | Ahora |
|---|---|---:|---:|
| IA (preguntas, resúmenes, quiz, reporte, análisis del documento) | `aiQuestionGeneration`, `classSummary`, `finalQuiz`, `documentAnalysis`, `documentAnalysisCache`, **`classReport` (9)**, **`recoverySummary` (10)** | 71 | 90 |
| Tiempo real (WebSocket, preguntas en vivo, gracias de desconexión, bot de Vexa) | `ws`, `questions`, `teacherDisconnectGrace`, `emptyRoomBotGrace`, `botAlArrancarClase`, `vexaSesionFantasma` | 51 | 51 |
| REST, datos y control de acceso | `meetings`, `questionsHistory`, `studentStats`, `documentUpload`, `apiKey`, **`attentionSnapshots` (6)**, **`validacionYErrores` (7)** | 44 | 57 |
| **Total** | | **166** | **198** |

## Test intermitente corregido

`backend/tests/questions.test.js` ("El alumno responde, el backend calcula
isCorrect…") fallaba de vez en cuando con `0 !== 1`. El servidor le manda la
pregunta al alumno y recién después, tras una consulta a la base, le manda al
docente sus estadísticas iniciales (0 respuestas). El test borraba los mensajes
del docente apenas el alumno recibía la pregunta: si las estadísticas iniciales
llegaban después de ese borrado, las tomaba como las posteriores a la respuesta.
Se corrigió solo el test (espera esas estadísticas antes de borrar), en ese
caso y en otros tres del mismo archivo con la misma carrera. El código de la app
no cambió.

## Medición de la entrega final (22/11/2026)

Los valores de arriba son los que informa la tesis (sección 6.2) y corresponden a
la versión v0.1.15. Para la entrega final se volvió a medir, con el mismo
comando y en UTC, sobre el código entregado:

| Paquete  | Tests | Líneas  | Sentencias | Ramas  | Funciones |
|----------|------:|--------:|-----------:|-------:|----------:|
| Backend  |   198 | 93,46 % | 93,46 %    | 84,25 % | 92,04 %  |
| Frontend |   274 (7 omitidos) | 92,09 % | 92,09 %    | 88,45 % | 80,09 %  |
| **Total**|   472 | **92,60 %** (21.389 / 23.099) | **92,60 %** | 86,79 % (2.956 / 3.406) | 84,82 % (620 / 731) |

Los 7 tests omitidos son los de `reglas.equivalenciaPython`. Comparan las
reglas geométricas con su referencia en Python sobre 400 ventanas de DAiSEE, y
ese archivo de referencia no se distribuye porque contiene medidas extraídas de
los videos (Etapa 92 de `DOCUMENTACION.md`). Con el archivo presente pasan los
7. Quitarlos no bajó la cobertura: `reglas.js` sigue cubierto por los demás
tests de las reglas. Las diferencias de centésimas con la medición anterior
(ramas del backend, líneas del frontend) son variaciones entre corridas: el
código del backend no cambió.

El backend no cambió. La diferencia del frontend (293 → 274) se explica así:

- **+2** `meetContext.rutas`: reconocimiento de las reuniones con dirección
  `/meet/` (commit 07fd595).
- **−17** `guion.protocolo` (13) y `guion.registroDeSesion` (4), y **−4** de
  `pantallas.docente`: probaban las herramientas internas de calibración (el
  registro y los ajustes que se abrían con Ctrl+Q), que se quitaron de la
  entrega porque solo las usaba el equipo durante el desarrollo (Etapa 91 de
  `DOCUMENTACION.md`).
