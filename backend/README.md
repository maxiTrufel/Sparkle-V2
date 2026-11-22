# Sparkle V2 — Backend

API en Node.js + Express que registra y resuelve el rol (`profesor` / `alumno` / sin definir) de un email **para una reunión de Meet puntual** (no de forma global por cuenta — ver Etapa 17 en [DOCUMENTACION.md](../DOCUMENTACION.md)), usando MySQL/MariaDB como base de datos.

## Requisitos

Un servidor MySQL o MariaDB corriendo en `localhost:3306` — la forma más simple en desarrollo es [XAMPP](https://www.apachefriends.org/) (incluye phpMyAdmin para inspeccionar la base a ojo). Con la instalación default de XAMPP alcanza: usuario `root`, sin contraseña.

## Instalar y levantar el servidor

```bash
cd backend
npm install
```

Copiá `.env.example` a `.env` y completá los valores:

```bash
cp .env.example .env
```

- `PORT` — puerto del servidor (default `3000`).
- `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` — conexión a MySQL/MariaDB. Con XAMPP en su configuración default: `DB_HOST=localhost`, `DB_PORT=3306`, `DB_USER=root`, `DB_PASSWORD=` (vacío), `DB_NAME=sparkle_v2`.
- `ALLOWED_EXTENSION_IDS` — **obligatorio** para que la extensión pueda llamar al backend (ver la sección CORS más abajo). Sin esto, el servidor arranca igual pero el service worker de la extensión se queda pegado con un error de CORS.

Con MySQL/MariaDB corriendo y el `.env` completo, creá la base de datos y las tablas (una sola vez, o cada vez que se agregue una tabla nueva al esquema):

```bash
npm run init-db
```

Esto crea la base `sparkle_v2` (si no existe) y las tablas `usuarios`, `reuniones`, `participaciones` y `archivos` — ver la sección "Modelo de datos" más abajo. Se puede correr de nuevo sin problema, pero **ojo**: dropea y recrea las tablas del esquema (no solo `CREATE TABLE IF NOT EXISTS`), así que borra los datos existentes cada vez que se corre — es la forma más simple de mantener el esquema al día en un prototipo de desarrollo.

Recién ahí:

```bash
npm start
```

Por defecto corre en `http://localhost:3000`. Si te olvidaste de correr `npm run init-db` (o MySQL no está corriendo), el servidor arranca igual pero avisa en consola: `No se pudo verificar la tabla "usuarios"...`.

También existe `npm run dev`, que corre el servidor con `node --watch` y lo reinicia automáticamente ante cada cambio de código.

## Modelo de datos

Cuatro tablas — el rol vive en `participaciones`, por combinación de reunión + usuario, no como columna de `usuarios` (ver Etapa 17 en [DOCUMENTACION.md](../DOCUMENTACION.md) para el detalle completo de por qué se armó así).

```
usuarios              reuniones              participaciones              archivos
────────────          ────────────           ─────────────────           ─────────────────
id          PK        id          PK         id                PK        id               PK
email       UNIQUE    meeting_code UNIQUE     reunion_id   FK → reuniones.id  reunion_id  FK → reuniones.id
fecha_registro         fecha_creacion         usuario_id   FK → usuarios.id   nombre_archivo
                                               rol          ENUM              ruta_o_url  (NULL por ahora)
                                               fecha_union                    fecha_subida
                                               UNIQUE (reunion_id, usuario_id)
```

El índice único `(reunion_id, usuario_id)` en `participaciones` es lo que garantiza "un solo rol por persona por reunión" a nivel de base de datos — la misma persona puede tener un rol distinto en cada reunión sin ningún conflicto.

Por ahora **ningún endpoint usa `archivos` todavía** — solo existe la tabla, lista para cuando se implemente esa funcionalidad.

## Endpoints

### `POST /api/reuniones/registrar-rol`

Registra (o actualiza) el rol de un email para una reunión puntual. Crea el usuario y la reunión si no existían todavía.

Body (JSON):

```json
{ "meetingCode": "abc-defg-hij", "email": "docente@ejemplo.com", "rol": "profesor" }
```

Respuestas:

- `200` con `{ "mensaje": "...", "meetingCode": "...", "email": "...", "rol": "..." }`.
- `400` si falta `meetingCode` o `email`, o si `rol` no es exactamente `"profesor"` o `"alumno"`.

### `GET /api/reuniones/rol?meetingCode=xxx&email=yyy`

Devuelve el rol de ese email en esa reunión puntual — **no** el rol que pueda tener en otra reunión distinta.

Respuestas:

- `200` con `{ "rol": "profesor" }`, `{ "rol": "alumno" }`, o `{ "rol": null }` si esa cuenta nunca participó en esa reunión.
- `400` si falta `meetingCode` o `email` en la query string.

### `POST /api/profesores/reset` ⚠️ solo desarrollo/testing

Borra **todo**: `usuarios`, `reuniones`, `participaciones` y `archivos` (el path se mantiene en `/profesores/reset` por compatibilidad con la herramienta de test ya armada en el frontend). No tiene ningún chequeo de autorización — no debería exponerse en un entorno que no sea local.

Respuesta: `200` con `{ "mensaje": "Base de datos reseteada por completo." }`.

## Probar con curl

```bash
# Registrar el mismo email como profesor en una reunión...
curl -X POST http://localhost:3000/api/reuniones/registrar-rol \
  -H "Content-Type: application/json" \
  -d '{"meetingCode":"aaa-bbbb-ccc","email":"maxi@ejemplo.com","rol":"profesor"}'

# ...y como alumno en otra reunión distinta (mismo email, rol distinto por reunión)
curl -X POST http://localhost:3000/api/reuniones/registrar-rol \
  -H "Content-Type: application/json" \
  -d '{"meetingCode":"ddd-eeee-fff","email":"maxi@ejemplo.com","rol":"alumno"}'

# Consultar el rol en cada reunión
curl "http://localhost:3000/api/reuniones/rol?meetingCode=aaa-bbbb-ccc&email=maxi@ejemplo.com"  # → "profesor"
curl "http://localhost:3000/api/reuniones/rol?meetingCode=ddd-eeee-fff&email=maxi@ejemplo.com"  # → "alumno"

# Consultar una reunión en la que ese email nunca participó (→ null)
curl "http://localhost:3000/api/reuniones/rol?meetingCode=nnn-oooo-ppp&email=maxi@ejemplo.com"

# Cambiar el rol dentro de la MISMA reunión (mismo endpoint, upsert)
curl -X POST http://localhost:3000/api/reuniones/registrar-rol \
  -H "Content-Type: application/json" \
  -d '{"meetingCode":"aaa-bbbb-ccc","email":"maxi@ejemplo.com","rol":"alumno"}'

# Resetear todo (solo dev/testing)
curl -X POST http://localhost:3000/api/profesores/reset
```

## CORS

Quien llama al backend es el **service worker** de la extensión (no el content script — ver Etapa 8 en [DOCUMENTACION.md](../DOCUMENTACION.md)), así que el origen que llega en el header `Origin` es `chrome-extension://<id-de-la-extension>`, no `https://meet.google.com`. El servidor solo acepta ese origen si el ID está en la variable de entorno `ALLOWED_EXTENSION_IDS` (ver Etapa 9 en [DOCUMENTACION.md](../DOCUMENTACION.md) para el detalle completo y el trade-off de seguridad).

**Cómo encontrar el ID de tu extensión:**

1. Abrí `chrome://extensions`.
2. Activá el "Modo de desarrollador" (switch arriba a la derecha) si no está activo.
3. Buscá la tarjeta de "Sparkle V2" — el ID aparece debajo del nombre (ej. `amldcfjomclijbkhpnipkdhllpchaekn`).
4. Pegalo en `.env`:

   ```
   ALLOWED_EXTENSION_IDS=amldcfjomclijbkhpnipkdhllpchaekn
   ```

5. Reiniciá el backend (`npm start`) para que tome el nuevo valor.

Ese ID cambia si la extensión se recarga desde otra carpeta o en otra máquina (típico en pruebas de tesis en más de un equipo) — cuando pase, hay que actualizar `.env` con el ID nuevo. Se puede poner más de uno separado por comas (`ALLOWED_EXTENSION_IDS=id1,id2`) si vas a probar desde varias instalaciones al mismo tiempo.

`https://meet.google.com` se mantiene en la whitelist además del/los ID de extensión, por compatibilidad con pruebas manuales o un eventual regreso a llamadas desde el content script.

### Private Network Access (PNA)

Además del CORS "normal", Chrome exige un permiso separado para que un origen que no sea de red privada le pegue a una dirección local como `localhost` — si no, tira un error de CORS que menciona explícitamente el `loopback` address space. El servidor ya contesta ese chequeo (`Access-Control-Allow-Private-Network: true` en el preflight, seteado a mano en `src/server.js` porque el paquete `cors` todavía no lo soporta). Ver la Etapa 7 en [DOCUMENTACION.md](../DOCUMENTACION.md) para el detalle completo del error y la solución.

## Estructura

Arquitectura por capas (Etapa 74 de [DOCUMENTACION.md](../DOCUMENTACION.md), "Etapa 3 de limpieza"): rutas → controladores → servicios → repositorios, con la capa WebSocket reusando los mismos servicios que la capa REST — ninguna regla de negocio vive en dos lugares.

```
backend/
├── src/
│   ├── server.js                        Entry point: Express, CORS, monta el router,
│   │                                     crea el http.Server y arranca el WS.
│   ├── db.js                            Pool de conexiones a MySQL/MariaDB.
│   ├── routes/
│   │   └── reuniones.js                 Solo Router() + endpoint → controller. Sin SQL, sin reglas de negocio.
│   ├── controllers/
│   │   └── reunionesController.js       Valida la forma de la entrada, llama al service, arma la respuesta HTTP.
│   ├── services/                        Reglas de negocio del dominio, por concepto (no por tabla):
│   │   ├── rolesService.js                registrar/consultar rol, hayOtroProfesorRegistrado(), etc.
│   │   ├── clasesService.js               iniciar/finalizar/reanudar clase, esReanudable().
│   │   ├── sesionesService.js             historial + apertura/cierre de sesiones de conexión.
│   │   └── camaraService.js               preferencia de cámara (herramienta de prueba).
│   ├── repositories/                    SQL puro, uno por tabla:
│   │   ├── usuariosRepository.js
│   │   ├── reunionesRepository.js
│   │   ├── participacionesRepository.js
│   │   └── sesionesConexionRepository.js
│   ├── ws/
│   │   ├── index.js                     Bootstrap del WebSocketServer (verifyClient, heartbeat, dispatch).
│   │   ├── salas.js                     Estado EN MEMORIA de las salas WS + helpers puros, sin acceso a datos.
│   │   └── handlers.js                  Handlers de cada mensaje — delegan en `services/`, cero SQL directo.
│   └── utils/
│       └── ejecutarConReintentoDeadlock.js
├── scripts/
│   └── init-db.js          `npm run init-db`: dropea y recrea la base
│                            "sparkle_v2" y las tablas usuarios/reuniones/
│                            participaciones/sesiones_conexion/archivos.
├── .env.example            Variables de entorno de referencia (PORT, DB_*,
│                           ALLOWED_EXTENSION_IDS). `.env` real es gitignored.
└── package.json
```
