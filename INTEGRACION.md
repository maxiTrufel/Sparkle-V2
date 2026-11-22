# INTEGRACIÓN.md — Levantar Sparkle V2 + Vexa de cero

Guía para dejar funcionando **el sistema completo** en una máquina nueva: la extensión de
Chrome, el backend de Sparkle, y Vexa (el servicio de transcripción) hablando entre sí.

Son **dos repositorios distintos**:

| Repo | Qué es | Remoto |
|---|---|---|
| `Sparkle_V2` | El proyecto de la tesis: extensión de Chrome + backend Express + MySQL | `github.com/maxiTrufel/Sparkle-V2` |
| `Sparkle_V2_Transcripcion` | Vexa — servicio de transcripción self-hosted (se usa tal cual, no se modifica) | `github.com/maxiTrufel/Sparkle_V2_Vexa_Transcripcion` |

> Los dos repositorios **se renombraron en GitHub el 7/9/2026**. La primera columna es el
> nombre de la **carpeta local** que usa el resto de este documento; la tercera, el remoto
> actual. GitHub redirige los nombres viejos, así que un clon anterior sigue funcionando.

Este documento cubre **los dos y cómo se conectan**. El `INSTALL.md` que está dentro de
`Sparkle_V2_Transcripcion` es el detalle profundo de Vexa solo — sirve como referencia, pero
**tiene un default que rompe la transcripción en español** (ver sección 3.2), así que seguí los
comandos de acá, no los de ahí.

---

## 1. El mapa: cómo encajan las piezas

```
┌─────────────────────────────────────────────┐
│ Extensión de Chrome (Sparkle_V2/frontend)   │
│ content script sobre meet.google.com/*      │
└───────────────┬─────────────────────────────┘
                │ HTTP + WebSocket
                │ VITE_BACKEND_URL → localhost:3000
                ▼
┌─────────────────────────────────────────────┐
│ Backend Sparkle (Sparkle_V2/backend)  :3000 │
│  ├── MySQL / MariaDB (XAMPP)                │
│  ├── OpenAI (preguntas, resúmenes, reporte) │
│  └── src/services/vexaService.js ───────┐   │
└─────────────────────────────────────────┼───┘
                                          │ X-API-Key
                                          ▼
┌─────────────────────────────────────────────┐
│ Vexa Lite (Sparkle_V2_Transcripcion) :8056  │
│  contenedores: vexa-lite, postgres,         │
│  minio, whisper (:8083)                     │
│                                             │
│  El "bot" = un Chromium con Playwright que  │
│  entra al Meet como invitado y transcribe   │
└─────────────────────────────────────────────┘
```

**El flujo real durante una clase:**

1. El docente entra al Meet con la extensión instalada.
2. El backend detecta el rol `teacher` en su sala WebSocket y le pide a Vexa que mande un bot
   ([`ws/handlers.js:157`](backend/src/ws/handlers.js#L157)).
3. Alguien **admite al bot** desde la sala de espera del Meet (es un invitado más).
4. El backend hace polling a Vexa cada 10 s y persiste los segmentos en `transcript_segments`
   ([`services/vexaService.js`](backend/src/services/vexaService.js)).
5. Esa transcripción alimenta: generación de preguntas, resumen de clase, "recuperar
   contenido" y el análisis pedagógico del reporte final.
6. Cuando la sala WebSocket queda vacía, el bot se retira
   ([`ws/handlers.js:499`](backend/src/ws/handlers.js#L499)).

> **El código de integración ya está escrito y el contrato contra la API v0.12 de Vexa está
> verificado.** No hay que programar nada para conectar los dos sistemas — lo que falta es
> configurar el entorno. Todo lo que sigue es instalación y configuración.

---

## 2. Requisitos previos

| Herramienta | Para qué | Notas |
|---|---|---|
| **Docker Desktop** (Engine ≥ v26) | Correr Vexa | El Makefile de Vexa rechaza motores anteriores a v26 |
| **WSL2** | Correr `make` en Windows | En Mac/Linux no hace falta |
| **make** | Orquestar Vexa | Ya viene en Mac/Linux; en Windows va adentro de WSL |
| **git** | Clonar | **Obligatorio con historial** — el Makefile de Vexa usa `git rev-parse` |
| **Node.js** (≥ 20) | Backend + build de la extensión | |
| **MySQL / MariaDB** | Base de Sparkle | Lo más simple: [XAMPP](https://www.apachefriends.org/) |
| **Google Chrome** | Cargar la extensión | |

### Windows: instalar WSL2 y Docker

```powershell
# En PowerShell COMO ADMINISTRADOR, y después reiniciar
wsl --install
```

Si falla porque la virtualización no está habilitada, primero:

```powershell
wsl --install --no-distribution
```

Después instalar **Docker Desktop** con el backend WSL2 activado, y en
*Settings → Resources → WSL Integration* **activar Ubuntu** — sin eso, `docker` existe en
PowerShell pero **no** dentro de Ubuntu, que es desde donde corre Vexa. Finalmente, dentro de WSL:

```bash
sudo apt update && sudo apt install -y make
```

> **Regla para Windows:** los comandos de **Vexa** (`make ...`) se corren **desde WSL**.
> Los de **Sparkle** (`npm ...`) se corren desde PowerShell o Git Bash, como siempre.

### Clonar los dos repos

```bash
git clone https://github.com/maxiTrufel/Sparkle-V2.git Sparkle_V2
git clone https://github.com/maxiTrufel/Sparkle_V2_Vexa_Transcripcion.git Sparkle_V2_Transcripcion
```

Si en vez de clonar copiás la carpeta de Vexa (pendrive, zip), **`make` va a fallar** porque
necesita el historial de git. En ese caso, convertila en repo antes:

```bash
cd Sparkle_V2_Transcripcion && git init && git add -A && git commit -m "copia local"
```

---

## 3. Paso 1 — Levantar Vexa

Todo desde la raíz de `Sparkle_V2_Transcripcion` (en Windows: **desde WSL**).

### 3.1 Crear el `.env`

```bash
cp deploy/compose/.env.example .env
```

Para el arranque local **no hace falta tocar ninguna variable**: los defaults funcionan y la
transcripción se resuelve con un Whisper local (siguiente paso), sin tokens pagos ni GPU.

> ⚠️ **El fork de Vexa no tiene `.gitignore`**, así que ese `.env` **no está protegido** — un
> `git add -A` lo empuja al repo. Los dos `.env` de Sparkle sí están cubiertos por sus
> `.gitignore`; este no. Mientras queden los defaults de desarrollo el riesgo es bajo (la API
> key que consume Sparkle la mintea el contenedor en `/run/vexa/key.env`, no vive acá), pero si
> alguna vez ponen una key real ahí, conviene crear primero un `.gitignore` con `.env`.

### 3.2 🔴 Levantar con transcripción **en español**

```bash
make lite LOCAL_STT=1 WHISPER_MODEL=Systran/faster-whisper-small
```

**Por qué el `WHISPER_MODEL` explícito — leé esto, es el error más fácil de cometer.**

El default de Vexa es `Systran/faster-whisper-tiny.en`
([`deploy/lite/Makefile:51`](../Sparkle_V2_Transcripcion/deploy/lite/Makefile#L51)). El sufijo
**`.en` significa modelo solo-inglés**. Sparkle manda `language: 'es'` y ese parámetro llega
correctamente al servidor de Whisper, pero el modelo no puede honrarlo: sobre audio en español
devuelve texto incoherente o una transcripción fonética al inglés.

Y **falla en silencio**: el bot entra, graba, y devuelve texto. No hay ningún error en los
logs. Simplemente todo lo que se alimenta de la transcripción (preguntas, resúmenes, reporte)
queda envenenado sin que nada lo avise. Si seguís el `INSTALL.md` tal cual está, te pasa esto.

`Systran/faster-whisper-small` es multilingüe (sin `.en`) y es el piso razonable para español
en CPU. Existe `Systran/faster-whisper-tiny` (multilingüe también), pero rinde bastante peor.

La primera vez tarda unos minutos: descarga la imagen de Vexa y el modelo de Whisper.

### 3.3 Obtener la API key

```bash
docker exec vexa-lite cat /run/vexa/key.env
```

Devuelve dos valores (`VEXA_API_KEY` y `VEXA_BOT_API_KEY`). **Los dos se mintean con los mismos
permisos** (`scopes=bot,tx`, ver
[`provision-key.sh:46-52`](../Sparkle_V2_Transcripcion/deploy/lite/bin/provision-key.sh#L46)),
así que en Sparkle podés usar **el mismo valor** para las dos variables. Guardalo, lo necesitás
en el paso 2.

Verificado en la práctica: la misma key responde `200` tanto en `/bots/status` (scope `bot`)
como en `/meetings` (scope `tx`).

### 3.4 Verificar que Vexa quedó arriba

```bash
docker ps --filter "name=vexa-lite"
```

Tienen que aparecer **4 contenedores**: `vexa-lite`, `vexa-lite-postgres`, `vexa-lite-minio`,
`vexa-lite-whisper`.

| Puerto | Servicio |
|---|---|
| `8056` | API de Vexa (lo que consume Sparkle) — docs en `/docs` |
| `3001` | UI web de Vexa ("Terminal") — no la usa Sparkle, sirve para debug |
| `8083` | Whisper local |

> El `INSTALL.md` de Vexa dice que noVNC (ver la pantalla del bot en vivo) queda en `:6080`.
> **En modo Lite eso no es cierto**: el Makefile publica únicamente 8056, 3001 y 8100
> ([`deploy/lite/Makefile:168`](../Sparkle_V2_Transcripcion/deploy/lite/Makefile#L168)) — no hay
> `-p 6080`. El entorno gráfico existe dentro del contenedor, pero no está expuesto al host. Para
> ver qué está haciendo el bot, usar `docker logs -f vexa-lite`.

---

## 4. Paso 2 — Backend de Sparkle

Desde `Sparkle_V2/backend`:

```bash
npm install
cp .env.example .env
```

Editá `backend/.env` y completá:

```ini
PORT=3000

# XAMPP con su config default
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=sparkle_v2

# Vexa — las dos pueden llevar el MISMO valor (ver 3.3)
VEXA_API_URL=http://localhost:8056
VEXA_BOT_API_KEY=vxa_...
VEXA_TX_API_KEY=vxa_...

# Se completa en el paso 3, cuando Chrome asigne el ID
ALLOWED_EXTENSION_IDS=

# Funciones de IA
OPENAI_API_KEY=sk-...
```

`.env.example` documenta el resto de las variables (modelos de OpenAI, flags para apagar cada
función de IA por separado). Los defaults están bien para empezar.

### Crear la base de datos

Con MySQL corriendo (arrancá XAMPP primero):

```bash
npm run init-db
```

> ⚠️ **`init-db` dropea y recrea las 9 tablas** — borra todos los datos existentes. Está bien la
> primera vez y cuando cambia el esquema, pero no lo corras a mitad de una serie de pruebas
> cuyos datos te importen. Desde el commit `7ae64c9` el script aborta si `NODE_ENV=production`,
> salvo que se pase `-- --force`.

### Levantar el servidor

```bash
npm start
```

(`npm run dev` hace lo mismo pero reinicia solo ante cada cambio de código.)

---

## 5. Paso 3 — La extensión de Chrome

Desde `Sparkle_V2/frontend`:

```bash
npm install
cp .env.example .env
```

`frontend/.env` con:

```ini
VITE_BACKEND_URL=http://localhost:3000
```

> Este valor se lee **en tiempo de build**, no en runtime — un service worker de Manifest V3 no
> puede leer un `.env`. Si lo cambiás, hay que **volver a buildear**.

### ⚠️ Windows: arreglar el shell de npm antes de buildear

El script `prebuild` del frontend usa `rm -rf dist`, un comando de Unix. En Windows npm corre
los scripts con `cmd.exe`, que no lo conoce, y **el build falla antes de empezar**. Se arregla
una sola vez apuntando npm a Git Bash:

```powershell
npm config set script-shell "C:\Program Files\Git\bin\bash.exe"
```

En Mac/Linux no hace falta.

### Los modelos de detección de atención (antes de buildear)

Los artefactos del modelo **no están versionados** (son binarios, se regeneran desde el pipeline
de entrenamiento) y tienen que estar en `frontend/public/models/` **antes** del build:

| Archivo | Origen |
|---|---|
| `preprocesamiento.json` | Drive → `SparkleV2/modelo_final/` |
| `cnn_extractor.tflite` | Drive → `SparkleV2/modelo_final/` |
| `modelo_A_resumen_lineal.tflite` | Drive → `SparkleV2/modelo_final/` |
| `modelo_B_tcn_fusion.tflite` *(opcional)* | Drive → `SparkleV2/modelo_final/` |
| **`modelo_ensemble.json`** | Drive → `SparkleV2/fase3_6_cierre/` — **o copiarlo de `frontend/tests/fixtures/`, que es byte-idéntico** |
| `face_landmarker.task` | Descarga directa (abajo) |

```bash
curl -L -o public/models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
```

#### ⚠️ `modelo_ensemble.json` no lo chequea el build

`scripts/copy-model-assets.js` valida solo 4 archivos
([líneas 67-70](frontend/scripts/copy-model-assets.js#L67)) y **`modelo_ensemble.json` no está en
esa lista** — pero el detector sí lo carga en runtime
([`offscreen/detector.js:365`](frontend/src/offscreen/detector.js#L365)).

Si falta, el build pasa en verde y la extensión arranca igual, pero cae al modelo A de reserva
**con la abstención desactivada** — el margen de confianza está calibrado para el ensemble y con
otro modelo no da la cobertura de 0,60. O sea: la detección "funciona", pero no es el modelo
validado de la tesis. Para resultados que valgan, este archivo tiene que estar.

Se ve en la consola del offscreen: `Sin ensemble (...); se usa el modelo A de reserva`.

#### Verificar que el modelo es el correcto

```bash
node --test tests/ensemble.fidelidadConPython.test.js
```

Comprueba que la implementación en JavaScript del ensemble reproduce las probabilidades que
produce Python, contra fixtures generados por el mismo código que ajustó el modelo. **Si este
test falla, la extensión no está corriendo el modelo validado** — y el modo de falla es
silencioso (devuelve probabilidades plausibles y equivocadas), así que no se detecta a ojo.
Corrélo después de cualquier cambio en los artefactos del modelo.

### Buildear y cargar

```bash
npm run build
```

Después, en Chrome:

1. Ir a `chrome://extensions`
2. Activar **"Modo de desarrollador"** (arriba a la derecha)
3. **"Cargar descomprimida"** → elegir la carpeta `frontend/dist`
4. **Copiar el ID** que Chrome le asigna a la extensión

### Cerrar el círculo de CORS

Pegá ese ID en `backend/.env`:

```ini
ALLOWED_EXTENSION_IDS=abcdefghijklmnopabcdefghijklmnop
```

y **reiniciá el backend**. Sin esto el backend arranca igual, pero la extensión se queda pegada
con un error de CORS. Acepta varios IDs separados por coma (útil si cada uno la carga desde una
carpeta distinta — el ID cambia por instalación).

---

## 6. Verificación — probá los eslabones **en este orden**

La tentación es armar una reunión con gente y ver si funciona. **No hagas eso primero**: si algo
falla no vas a saber qué eslabón fue, y armar una clase de prueba es caro en tiempo de todos.

### 6.1 Vexa responde

```bash
curl -sf http://localhost:8056/health
```

### 6.2 🔴 Whisper transcribe **español** (el eslabón crítico)

Este es el que hay que probar sí o sí, porque es el que falla en silencio. Grabá 10 segundos de
audio hablando en español (cualquier grabadora, guardalo como `prueba.mp3`) y mandalo directo al
Whisper local:

```bash
curl -s http://localhost:8083/v1/audio/transcriptions \
  -F "file=@prueba.mp3" -F "model=whisper-1" -F "language=es"
```

**Tiene que devolver tu frase en español, legible**, y el campo `"language":"es"` en la
respuesta. Si devuelve inglés, texto incoherente o fonética rara → estás corriendo un modelo
`.en` (ver 3.2): bajá todo y volvé a levantar con `WHISPER_MODEL=Systran/faster-whisper-small`.

> No uses `make -C deploy/lite stt-smoke` para verificar esto. Ese smoke test sintetiza una
> frase **en inglés** ("the quick brown fox…"), así que **pasa en verde con el modelo `.en`** y
> no detecta el problema. Sirve para saber si Whisper está vivo, no si sirve para tu caso.

### 6.3 El bot entra a un Meet

Armá un Meet vacío vos solo y mandá el bot a mano, con la key del paso 3.3:

```bash
curl -X POST "http://localhost:8056/bots" \
  -H "X-API-Key: vxa_..." -H "Content-Type: application/json" \
  -d '{"meeting_url":"https://meet.google.com/abc-defg-hij","bot_name":"Sparkle Bot","language":"es"}'
```

En segundos tiene que aparecer en la sala de espera. **Admitilo.** Para seguir lo que hace por
dentro: `docker logs -f vexa-lite`. Hablá un rato y pedí la transcripción:

```bash
curl -H "X-API-Key: vxa_..." "http://localhost:8056/transcripts/google_meet/abc-defg-hij"
```

Para sacarlo:

```bash
curl -X DELETE "http://localhost:8056/bots/google_meet/abc-defg-hij" -H "X-API-Key: vxa_..."
```

### 6.4 El circuito completo

Recién ahora: entrá a un Meet con la extensión, confirmá el rol de docente, y verificá que el
bot entra solo. Con la clase andando, chequeá que los segmentos están llegando a la base:

```sql
SELECT COUNT(*), MAX(absolute_start_time) FROM transcript_segments WHERE meeting_code = 'abc-defg-hij';
```

Si eso sube, la integración está completa y las funciones de IA tienen de dónde comer.

---

## 7. Problemas conocidos

| Síntoma | Causa | Solución |
|---|---|---|
| **La transcripción sale en inglés / incoherente** | Modelo `.en` (solo inglés) | Sección 3.2 — relevantar con `WHISPER_MODEL=Systran/faster-whisper-small` |
| `npm run build` falla con `rm no se reconoce` | npm usando `cmd.exe` en Windows | Sección 5 — `npm config set script-shell` |
| `docker: command not found` dentro de Ubuntu | Falta la integración WSL en Docker Desktop | *Settings → Resources → WSL Integration* → activar Ubuntu |
| La extensión no llega al backend (CORS) | Falta el ID en `ALLOWED_EXTENSION_IDS` | Sección 5 — pegar el ID y reiniciar el backend |
| `make lite` falla con `git rev-parse` | Carpeta copiada sin historial de git | `git init && git add -A && git commit -m "copia local"` |
| El bot queda esperando y no entra | Sala de espera del Meet | Alguien lo tiene que admitir a mano, como a cualquier invitado |
| El bot entra pero no hay texto | STT mal configurado | Verificar 6.2; revisar `docker logs vexa-lite-whisper` |
| `401 Missing/Invalid API key` | Key mal copiada o regenerada | Volver a sacarla: `docker exec vexa-lite cat /run/vexa/key.env` |
| Puerto ocupado (`8056`, `3001`, `8083`) | Otro proceso lo tomó | `make lite LOCAL_STT=1 WHISPER_MODEL=... HOST_GATEWAY_PORT=8057` (y actualizar `VEXA_API_URL`) |
| Procesos `chrome`/`node` colgados post-reunión | Bug conocido de imágenes viejas de Lite | `docker restart vexa-lite` |
| El backend no encuentra las tablas | Falta `init-db` o MySQL apagado | Arrancar XAMPP y correr `npm run init-db` |

**Empezar Vexa de cero:**

```bash
make -C deploy/lite down
docker volume rm vexa-lite-pgdata vexa-lite-miniodata
make lite LOCAL_STT=1 WHISPER_MODEL=Systran/faster-whisper-small
```

---

## 8. Cosas que **no** hacen falta (para ahorrar tiempo buscándolas)

- **No hace falta ninguna credencial de Google, Zoom ni Microsoft.** Vexa no usa el Meeting SDK
  de Zoom ni OAuth de Google: el bot es un Chromium real con Playwright que navega a la URL y
  hace clic en la UI como una persona. Entra como invitado anónimo.
- **No hace falta token pago de transcripción.** El Whisper local (`LOCAL_STT=1`) lo resuelve
  gratis en CPU.
- **No hace falta configurar el LLM de Vexa** (`VEXA_LLM_*`, `ANTHROPIC_API_KEY`). Esa es la
  función de "chat con IA" propia de Vexa, que Sparkle no usa — Sparkle llama a OpenAI por su
  cuenta desde su backend. Dejalas vacías.
- **No hace falta login OAuth en la UI de Vexa** (`GOOGLE_CLIENT_ID`, etc.). Solo afecta el
  login de humanos a la UI de Vexa en `:3001`, que Sparkle no usa.
- **No hace falta compilar el bot** (`make bot`). La imagen `vexa-lite` ya lo trae adentro.

### Una limitación a tener presente

El **"bot autenticado"** (que el bot entre logueado con una cuenta real) **no existe en modo
Lite** — solo en el modo Compose. Si las reuniones de prueba son de una cuenta institucional que
bloquea participantes anónimos, el bot no va a poder entrar y habría que migrar a Compose
(sección 8 del `INSTALL.md` de Vexa). Con cuentas personales de Gmail no hay problema: alguien lo
admite del lobby y listo.

---

## 9. Nota de mantenimiento

[`vexaService.js:8`](backend/src/services/vexaService.js#L8) — la función `normalizeTimestamp`
resta **3 horas fijas** para convertir los timestamps UTC de Vexa a hora argentina. Funciona
mientras las máquinas estén en UTC-3. Si alguien corre el proyecto en otra zona horaria, las
ventanas de tiempo de "recuperar contenido" se van a desalinear. No es urgente, pero si comparan
resultados entre máquinas y las ventanas no coinciden, es acá.
