#!/usr/bin/env bash
# Restauración de un backup de Sparkle V2 (paso I.3).
#
# Este script existe para que la restauración se pueda PROBAR. Un backup
# que nunca se restauró no es un backup, es una suposición — y el momento
# de descubrir que el procedimiento no funciona no es la semana de la
# defensa.
#
#   ./restaurar.sh                       # lista los backups disponibles
#   ./restaurar.sh 2026-09-05T07-00-00Z  # restaura ese
#   ./restaurar.sh --local <fecha>       # desde la copia local, sin bajar de S3
#
# ⚠️ ES DESTRUCTIVO: reemplaza la base y los PDFs actuales. Pide
# confirmación escrita antes de tocar nada.
set -euo pipefail

DIRECTORIO_STACK="${DIRECTORIO_STACK:-/opt/sparkle}"
PROYECTO="sparkle-v2"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

cd "$DIRECTORIO_STACK"
set -a
# shellcheck disable=SC1091
source "${DIRECTORIO_STACK}/.env"
set +a

: "${DB_ROOT_PASSWORD:?falta DB_ROOT_PASSWORD}"
: "${BUCKET_BACKUPS:?falta BUCKET_BACKUPS}"
DB_NAME="${DB_NAME:-sparkle_v2}"

DESDE_LOCAL=0
if [ "${1:-}" = "--local" ]; then
  DESDE_LOCAL=1
  shift
fi
FECHA="${1:-}"

if [ -z "$FECHA" ]; then
  echo "Backups en S3 (los más recientes abajo):"
  aws s3 ls "s3://${BUCKET_BACKUPS}/" | awk '{print "  " $2}' | sed 's#/$##' | tail -20
  echo
  echo "Uso: $0 [--local] <fecha>"
  exit 0
fi

TRABAJO="/tmp/sparkle-restore-${FECHA}"
rm -rf "$TRABAJO"
mkdir -p "$TRABAJO"

if [ "$DESDE_LOCAL" = "1" ]; then
  cp -r "/opt/sparkle/backups/datos/${FECHA}/." "$TRABAJO/"
else
  echo "[restaurar] Bajando de s3://${BUCKET_BACKUPS}/${FECHA}/ ..."
  aws s3 cp "s3://${BUCKET_BACKUPS}/${FECHA}/" "$TRABAJO/" --recursive --only-show-errors
fi

[ -s "${TRABAJO}/base.sql.gz" ]    || { echo "[restaurar] ERROR: no está base.sql.gz" >&2; exit 1; }
[ -s "${TRABAJO}/uploads.tar.gz" ] || { echo "[restaurar] ERROR: no está uploads.tar.gz" >&2; exit 1; }

echo
echo "─── Backup a restaurar ──────────────────────────────"
cat "${TRABAJO}/manifiesto.txt" 2>/dev/null || echo "(sin manifiesto)"
echo "─────────────────────────────────────────────────────"
echo
echo "⚠️  Esto REEMPLAZA la base \"${DB_NAME}\" y TODOS los PDFs actuales."
read -r -p '    Escribí "restaurar" para confirmar: ' confirmacion
[ "$confirmacion" = "restaurar" ] || { echo "Cancelado."; exit 1; }

# El backend se baja antes de tocar nada: si sigue vivo, puede escribir en
# la base mientras se restaura y dejar una mezcla de datos viejos y nuevos.
# La base se deja arriba, que es la que recibe el dump.
echo "[restaurar] Bajando el backend..."
$COMPOSE stop backend

echo "[restaurar] Restaurando la base..."
# El dump trae `CREATE DATABASE ... IF NOT EXISTS` y `USE` (por
# `--databases`), así que reconstruye la base entera sin que haga falta
# dropearla a mano.
gunzip -c "${TRABAJO}/base.sql.gz" \
  | $COMPOSE exec -T db mariadb --user=root --password="$DB_ROOT_PASSWORD"

echo "[restaurar] Restaurando los PDFs..."
# Se vacía el volumen antes de desempaquetar: sin esto, los archivos que
# existen hoy y no existían en el backup sobrevivirían, y el resultado no
# sería el estado del backup sino una mezcla.
docker run --rm \
  -v "${PROYECTO}_uploads_data:/datos" \
  -v "${TRABAJO}:/entrada:ro" \
  alpine:3 \
  sh -c 'rm -rf /datos/* /datos/.[!.]* 2>/dev/null; tar xzf /entrada/uploads.tar.gz -C /datos'

echo "[restaurar] Levantando todo..."
$COMPOSE up -d

# Migrar después de restaurar no es opcional: el dump puede ser de un
# esquema más viejo que el código que está corriendo ahora.
echo "[restaurar] Aplicando migraciones pendientes..."
$COMPOSE run --rm --no-deps backend npm run migrate

rm -rf "$TRABAJO"

echo
echo "[restaurar] Listo. Verificá A MANO antes de darlo por bueno:"
echo "  1. Abrí una clase que TENGA un PDF adjunto y confirmá que el documento está."
echo "     (Es el punto del ejercicio: el dump y el tar tienen que ser coherentes."
echo "      Si la base lista un archivo que no está en disco, el backup no servía.)"
echo "  2. curl -s -o /dev/null -w '%{http_code}\\n' https://\${DOMAIN}/"
