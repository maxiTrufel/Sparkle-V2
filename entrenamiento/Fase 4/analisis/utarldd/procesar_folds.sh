#!/usr/bin/env bash
# Orquestador: extraer -> procesar -> VERIFICAR -> borrar, fold por fold.
#
# QUE HACE
#   Para cada fold que se le pase:
#     1. espera a que sus dos zips esten completos (sirve si todavia se estan bajando)
#     2. los descomprime en la carpeta de videos
#     3. corre extraer_utarldd.py  (idempotente: lo ya hecho lo saltea)
#     4. VERIFICA que ese fold haya producido 36 CSV, 12 sujetos y 12 de cada nivel
#     5. si la verificacion pasa, borra videos y zips. Si NO pasa, reintenta el
#        paso 3 hasta REINTENTOS veces y, si sigue mal, SE DETIENE SIN BORRAR NADA.
#
# LO QUE NO HACE, A PROPOSITO
#   No corre medir_utarldd.py. La medicion se hace UNA sola vez, a mano, cuando
#   estan los 180 videos. Automatizarla aca invitaria a mirar resultados
#   parciales, que es lo que el Preregistro_UTA_RLDD.md existe para impedir.
#
# NUNCA BORRA SIN VERIFICAR
#   El borrado es irreversible y los zips son 20 GB por fold. Cada `rm` de este
#   script esta despues de un `verificar_fold` que devolvio 0.
#
# USO
#   bash procesar_folds.sh 2 3 4
#   bash procesar_folds.sh 2 3 4 5
#
# Conviene correrlo en una terminal NUEVA: si el extractor del fold 2 sigue
# andando en otra, este espera a que termine antes de tocar nada.
set -u

AQUI="$(cd "$(dirname "$0")" && pwd)"
VIDEOS="${UTARLDD_VIDEOS:-datasets/UTA-RLDD/videos}"
CUADROS="$AQUI/salida/cuadros"
ZIPS="${UTARLDD_ZIPS:-datasets}"
DESCARGAS="${UTARLDD_DESCARGAS:-$HOME/Downloads}"
BUSCAR_ZIPS=("$ZIPS" "$DESCARGAS")
REINTENTOS=3
MIN_LIBRE_GB=40          # por debajo de esto no se arranca a extraer un fold
LOG="$AQUI/procesar_folds.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

libre_gb() { df -BG "$AQUI" | tail -1 | awk '{gsub("G","",$4); print $4}'; }

# Espera a que no quede ningun python.exe corriendo. Es deliberadamente romo:
# `tasklist` no muestra argumentos, asi que no se puede distinguir el extractor
# de otro python. Se asume que no hay otro corriendo. Correr dos extractores a
# la vez no corrompe nada (cada CSV se escribe de forma atomica) pero se pelean
# por la CPU y tardan el doble.
esperar_python() {
  local primero=1
  while tasklist 2>/dev/null | grep -qi '^python\.exe'; do
    if [ $primero -eq 1 ]; then
      log "hay un python corriendo (el extractor de otra terminal). Esperando..."
      primero=0
    fi
    sleep 30
  done
  [ $primero -eq 0 ] && log "el python anterior termino."
  return 0
}

# Los dos zips del fold, completos. Devuelve las rutas por stdout.
zips_de() {
  local n="$1" encontrados=()
  for parte in 1 2; do
    local hallado=""
    for d in "${BUSCAR_ZIPS[@]}"; do
      local z="$d/Fold${n}_part${parte}.zip"
      # .crdownload al lado = la descarga sigue en curso
      if [ -f "$z" ] && [ ! -f "${z}.crdownload" ]; then hallado="$z"; break; fi
    done
    [ -z "$hallado" ] && return 1
    encontrados+=("$hallado")
  done
  printf '%s\n' "${encontrados[@]}"
}

esperar_zips() {
  local n="$1" avisado=0
  while ! zips_de "$n" >/dev/null; do
    if [ $avisado -eq 0 ]; then
      log "fold $n: faltan zips completos (Fold${n}_part1.zip / _part2.zip). Esperando la descarga..."
      avisado=1
    fi
    sleep 60
  done
  [ $avisado -eq 1 ] && log "fold $n: los dos zips ya estan."
  return 0
}

# Deja los zips del fold en $ZIPS. Si $DESCARGAS esta en el mismo volumen,
# `mv` es un renombre instantaneo: no copia los 20 GB.
mover_a_datasets() {
  local n="$1"
  mkdir -p "$ZIPS"
  for parte in 1 2; do
    local origen="$DESCARGAS/Fold${n}_part${parte}.zip"
    local destino="$ZIPS/Fold${n}_part${parte}.zip"
    if [ -f "$origen" ] && [ ! -f "$destino" ]; then
      mv "$origen" "$destino" && log "fold $n: movido part${parte} a $ZIPS"
    fi
  done
}

# 36 CSV, 12 sujetos, 12 de cada nivel. Cualquier desvio devuelve != 0.
verificar_fold() {
  local n="$1"
  local total suj n0 n5 n10
  total=$(ls "$CUADROS"/f${n}_s*_n*.csv 2>/dev/null | wc -l)
  suj=$(ls "$CUADROS"/f${n}_s*_n*.csv 2>/dev/null | sed 's/.*_s\([0-9]*\)_.*/\1/' | sort -u | wc -l)
  n0=$(ls "$CUADROS"/f${n}_s*_n0.csv 2>/dev/null | wc -l)
  n5=$(ls "$CUADROS"/f${n}_s*_n5.csv 2>/dev/null | wc -l)
  n10=$(ls "$CUADROS"/f${n}_s*_n10.csv 2>/dev/null | wc -l)
  log "fold $n: $total CSV · $suj sujetos · niveles 0/5/10 = $n0/$n5/$n10"
  [ "$total" -eq 36 ] && [ "$suj" -eq 12 ] && \
  [ "$n0" -eq 12 ] && [ "$n5" -eq 12 ] && [ "$n10" -eq 12 ]
}

procesar_fold() {
  local n="$1"

  if verificar_fold "$n"; then
    log "fold $n: YA ESTABA COMPLETO. No se reprocesa."
  else
    esperar_zips "$n"
    mover_a_datasets "$n"
    mapfile -t Z < <(zips_de "$n")

    local libre; libre=$(libre_gb)
    if [ "$libre" -lt "$MIN_LIBRE_GB" ]; then
      log "ABORTA: solo $libre GB libres, hacen falta $MIN_LIBRE_GB. No se extrae."
      return 1
    fi

    mkdir -p "$VIDEOS"
    local ya; ya=$(find "$VIDEOS" -path "*Fold${n}_part*" -type f 2>/dev/null | wc -l)
    if [ "$ya" -ge 36 ]; then
      # Ya estan descomprimidos (p. ej. el fold que se estaba procesando a mano).
      # Volver a descomprimir serian 20 GB de I/O para nada.
      log "fold $n: los videos ya estaban descomprimidos ($ya archivos). No se repite."
    else
      # Integridad antes de gastar media hora descomprimiendo. Leer el indice
      # central es instantaneo y detecta un zip truncado, que es como se perdio
      # el Train.zip de EngageNet: la descarga se corto, el archivo quedo con
      # nombre de .zip y el problema aparecio mucho despues.
      for z in "${Z[@]}"; do
        if ! unzip -l "$z" >/dev/null 2>&1; then
          log "🔴 ABORTA: $z esta corrupto o incompleto. Volver a bajarlo."
          return 1
        fi
      done
      log "fold $n: los dos zips leen bien (indice central OK)"

      log "fold $n: extrayendo ${Z[0]} y ${Z[1]}  ($libre GB libres)"
      unzip -q -o "${Z[0]}" -d "$VIDEOS" || { log "ABORTA: fallo unzip de ${Z[0]}"; return 1; }
      unzip -q -o "${Z[1]}" -d "$VIDEOS" || { log "ABORTA: fallo unzip de ${Z[1]}"; return 1; }
      log "fold $n: descomprimido ($(find "$VIDEOS" -path "*Fold${n}_part*" -type f | wc -l) archivos)"
    fi

    local intento=1
    while [ $intento -le $REINTENTOS ]; do
      log "fold $n: extractor, intento $intento de $REINTENTOS (esto tarda ~2 h)"
      python "$AQUI/extraer_utarldd.py" --raiz "$VIDEOS" 2>&1 | tee -a "$LOG"
      if verificar_fold "$n"; then break; fi
      log "fold $n: la verificacion NO paso. Reintentando el extractor."
      intento=$((intento + 1))
    done

    if ! verificar_fold "$n"; then
      log "🔴 ABORTA en el fold $n: sigue incompleto tras $REINTENTOS intentos."
      log "   NO SE BORRO NADA. Los videos y los zips siguen en su lugar."
      return 1
    fi
  fi

  # --- Solo se llega aca con la verificacion en verde ---
  log "fold $n: verificado. Borrando videos y zips."
  # Solo los directorios de ESTE fold: si por lo que sea hubiera videos de
  # otro en la misma carpeta, no se los lleva puestos.
  rm -rf "${VIDEOS:?}"/Fold${n}_part*
  mapfile -t Z < <(zips_de "$n" 2>/dev/null) || true
  for z in "${Z[@]:-}"; do [ -n "$z" ] && [ -f "$z" ] && rm -f "$z" && log "   borrado $z"; done
  log "fold $n: LISTO. $(libre_gb) GB libres."
  return 0
}


FOLDS=("$@")
if [ ${#FOLDS[@]} -eq 0 ]; then
  echo "uso: bash procesar_folds.sh 2 3 4 [5]"; exit 1
fi

log "================================================================"
log "procesar_folds: folds ${FOLDS[*]}"
log "================================================================"
esperar_python

for n in "${FOLDS[@]}"; do
  log "----------------------------------------------------------------"
  if ! procesar_fold "$n"; then
    log "Se detiene la cadena en el fold $n. Revisar antes de seguir."
    exit 1
  fi
done

TOT=$(ls "$CUADROS"/*.csv 2>/dev/null | wc -l)
log "================================================================"
log "TERMINO. $TOT CSV en total (de 180 esperados)."
if [ "$TOT" -eq 180 ]; then
  log "Estan los 180. Ahora si, y recien ahora, corresponde:"
  log "    python medir_utarldd.py"
else
  log "Faltan folds. NO correr medir_utarldd.py con el conjunto incompleto:"
  log "el pre-registro fija los criterios sobre 180 videos de 60 sujetos."
fi
log "================================================================"
