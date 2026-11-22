#!/usr/bin/env bash
# Backup diario de Sparkle V2 (paso I.1) — corre en el servidor, por cron.
#
# ⚠️ LOS DOS VOLÚMENES, EN LA MISMA CORRIDA Y CON LA MISMA FECHA.
#
# Los PDFs de los docentes viven en un volumen de Docker, FUERA de la base:
# la tabla `files` solo guarda la metadata (`stored_name`, el nombre del
# archivo en disco). Un backup que respalde solo el dump restaura una base
# que apunta a archivos que no existen — y el síntoma no es un error
# ruidoso, es una clase donde el documento de contexto simplemente no está.
#
# Por el mismo motivo el dump y el tar llevan la MISMA marca de tiempo y
# salen de la misma corrida: dos backups de momentos distintos reintroducen
# exactamente la inconsistencia que esto viene a evitar.
#
# Se instala solo, en cada deploy (ver .github/workflows/deploy.yml).
set -euo pipefail

DIRECTORIO_STACK="${DIRECTORIO_STACK:-/opt/sparkle}"
PROYECTO="sparkle-v2"           # `name:` del docker-compose.yml
RETENCION_LOCAL_DIAS=3          # en S3 la retención la maneja el lifecycle del bucket

cd "$DIRECTORIO_STACK"

# El bucket y las credenciales de la base salen del .env que escribe el
# deploy. `set -a` exporta todo lo que se lea a continuación.
set -a
# shellcheck disable=SC1091
source "${DIRECTORIO_STACK}/.env"
set +a

: "${DB_ROOT_PASSWORD:?falta DB_ROOT_PASSWORD en ${DIRECTORIO_STACK}/.env}"
: "${BUCKET_BACKUPS:?falta BUCKET_BACKUPS en ${DIRECTORIO_STACK}/.env — sale del terraform output}"
DB_NAME="${DB_NAME:-sparkle_v2}"

# Una sola marca de tiempo para todo lo que produce esta corrida. UTC a
# propósito: evita que el cambio de hora genere dos backups con el mismo
# nombre o un hueco de una hora.
FECHA="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
TRABAJO="/tmp/sparkle-backup-${FECHA}"
mkdir -p "$TRABAJO"
# Si algo falla a la mitad, no queda basura en /tmp ocupando disco.
trap 'rm -rf "$TRABAJO"' EXIT

echo "[backup] === ${FECHA} ==="

# ─── 1. La base ────────────────────────────────────────────────────────
#
# `--single-transaction` es lo que hace que el dump sea consistente SIN
# bloquear escrituras: toma una vista de la base en un instante. Sin él,
# `mariadb-dump` lockea las tablas y una clase en curso se congela mientras
# dura el backup.
#
# `--routines --events --triggers` no hacen falta hoy (el esquema no tiene
# ninguno de los tres) y van igual: el día que alguien agregue un trigger,
# el backup ya lo cubre en vez de perderlo en silencio.
echo "[backup] Dump de la base..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  mariadb-dump \
    --user=root \
    --password="$DB_ROOT_PASSWORD" \
    --single-transaction \
    --routines --events --triggers \
    --databases "$DB_NAME" \
  | gzip -9 > "${TRABAJO}/base.sql.gz"

# Un dump vacío o truncado pesa poco. Sin este chequeo, un fallo de
# `mariadb-dump` subiría un archivo de 20 bytes que pisa el backup bueno y
# nadie se entera hasta que hay que restaurar.
TAMANO_DUMP=$(stat -c%s "${TRABAJO}/base.sql.gz")
if [ "$TAMANO_DUMP" -lt 1024 ]; then
  echo "[backup] ERROR: el dump pesa ${TAMANO_DUMP} bytes. Algo falló, se aborta sin subir nada." >&2
  exit 1
fi
echo "[backup] Dump OK (${TAMANO_DUMP} bytes)."

# ─── 2. Los PDFs ───────────────────────────────────────────────────────
#
# Se lee el volumen desde un contenedor descartable y en SOLO LECTURA, en
# vez de desde el contenedor del backend: así el backup no depende de que
# el backend esté vivo, que es justo el escenario en el que uno más quiere
# poder respaldar.
echo "[backup] Tar del volumen de uploads..."
docker run --rm \
  -v "${PROYECTO}_uploads_data:/datos:ro" \
  -v "${TRABAJO}:/salida" \
  alpine:3 \
  tar czf /salida/uploads.tar.gz -C /datos .

echo "[backup] Uploads OK ($(stat -c%s "${TRABAJO}/uploads.tar.gz") bytes)."

# Un manifiesto chico al lado de los datos. Cuando haya que restaurar
# —probablemente con el servidor caído y con apuro— esto responde "¿de
# cuándo es esto y qué versión estaba corriendo?" sin tener que deducirlo.
cat > "${TRABAJO}/manifiesto.txt" <<MANIFIESTO
fecha_utc=${FECHA}
base=${DB_NAME}
version_desplegada=${IMAGE_TAG:-desconocida}
host=$(hostname)
dump_bytes=${TAMANO_DUMP}
uploads_bytes=$(stat -c%s "${TRABAJO}/uploads.tar.gz")
MANIFIESTO

# ─── 3. A S3 ───────────────────────────────────────────────────────────
#
# Sin credenciales: la CLI las saca del instance profile de la instancia
# (ver infra/terraform/iam.tf). El rol solo puede escribir y leer en este
# bucket — ni siquiera puede borrar, así que alguien que entre a la máquina
# no puede destruir los backups con lo que encuentre acá.
echo "[backup] Subiendo a s3://${BUCKET_BACKUPS}/${FECHA}/ ..."
aws s3 cp "$TRABAJO" "s3://${BUCKET_BACKUPS}/${FECHA}/" --recursive --only-show-errors

# ─── 4. Copia local, corta ─────────────────────────────────────────────
#
# Restaurar desde el disco es más rápido que bajar de S3, y cubre el caso
# más común (alguien rompió algo hoy). No reemplaza a S3: un backup en el
# mismo disco que la base no es un backup.
install -d /opt/sparkle/backups/datos
cp -r "$TRABAJO" "/opt/sparkle/backups/datos/${FECHA}"
find /opt/sparkle/backups/datos -maxdepth 1 -type d -name '20*' -mtime "+${RETENCION_LOCAL_DIAS}" -exec rm -rf {} +

echo "[backup] Listo: s3://${BUCKET_BACKUPS}/${FECHA}/"
