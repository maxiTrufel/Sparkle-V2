# syntax=docker/dockerfile:1

# ─── Backend de Sparkle V2 (Express + WebSocket) ─────────────────────────
#
# Imagen Debian (slim), NO Alpine, y Node 22 — para emparejar con el
# entorno local (v22.14.0) y con "engines": { "node": ">=22" } del
# package.json (paso 2.3 del plan). Desplegar sobre una versión distinta a
# la que se probó es exactamente lo que ese paso existe para evitar.
#
# Un solo stage a propósito: el backend es CommonJS plano, no hay paso de
# build (ni TypeScript ni bundler), así que un multi-stage no sacaría nada
# de la imagen final — solo agregaría una capa de indirección.
FROM node:22-slim

# tini como PID 1. Sin esto, `node` corre como PID 1 y Node NO instala los
# handlers de señales por defecto en ese caso: ignora SIGTERM, así que
# `docker compose down` espera los 10 s de gracia y termina matándolo con
# SIGKILL. Con tini de por medio, node queda en PID 2 con las
# disposiciones normales y termina al instante.
#   (Alternativa sin apt: `init: true` en el compose, que usa docker-init.
#    Se resuelve acá para que la imagen se comporte bien también con un
#    `docker run` suelto, sin depender de cómo la levanten.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

# Capa de dependencias separada del código: mientras package.json y
# package-lock.json no cambien, `npm ci` sale de cache y el rebuild tras
# tocar `src/` es de segundos.
#
# `npm ci` (no `npm install`) — instala exactamente lo que fija el
# lockfile. Acá es donde se baja @napi-rs/canvas-linux-x64-gnu (vía
# pdf-parse); por eso node_modules va excluido en .dockerignore: el local
# tiene el binario de win32 y no sirve adentro del contenedor.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# El código. Todo queda propiedad de root y el proceso corre como `node`:
# lectura sí, escritura no. Es deliberado — lo único que el backend
# necesita escribir son los uploads, que se preparan abajo.
COPY . .

# ⚠️ Punto de montaje del volumen de documentos (paso 3.3).
#
# `src/utils/uploadStorage.js:13` arma UPLOAD_DIR como
# path.join(__dirname, '..', '..', 'uploads', 'documents') — con
# WORKDIR /app eso es /app/uploads/documents — y la línea 14 hace
# mkdirSync AL CARGAR EL MÓDULO, no en cada request. O sea: el proceso
# necesita poder escribir ahí desde el arranque o el backend no levanta.
#
# El chown no es cosmético: cuando Docker inicializa un volumen nombrado
# vacío, copia el contenido Y EL OWNERSHIP del directorio de la imagen. Si
# esta ruta quedara de root, el volumen nacería de root y el usuario
# `node` no podría escribir los PDFs.
RUN mkdir -p /app/uploads/documents \
 && chown -R node:node /app/uploads

# La imagen node:* ya trae el usuario sin privilegios `node` (uid 1000).
USER node

# Documentativo: el puerto real sale de PORT (ver src/server.js:89, con
# default 3000). El mapeo lo hace el compose.
EXPOSE 3000

# Chequeo TCP contra el puerto, sin curl ni wget — node:22-slim no trae
# ninguno de los dos y no vale la pena instalarlos para esto.
#
# ⚠️ Alcance real: confirma que el servidor acepta conexiones, NO que la
# base responda. El backend arranca igual con MariaDB caída (server.js:91
# loguea un warning y sigue), así que un contenedor "healthy" no implica
# base sana. La dependencia con la DB se expresa en el compose (3.2).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "require('net').connect(Number(process.env.PORT)||3000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]

# `node src/server.js` directo, no `npm start`: npm agrega un proceso
# intermedio que no reenvía señales y volvería a romper el apagado limpio
# que tini vino a arreglar.
CMD ["node", "src/server.js"]
