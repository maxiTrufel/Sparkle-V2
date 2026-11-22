"""Extracción de features por cuadro sobre UTA-RLDD. NO mide nada.

QUÉ HACE Y QUÉ NO
-----------------
Recorre los videos de UTA-RLDD, muestrea a 6 fps y escribe, por cada video, un CSV
con `ear_avg`, el ancho de rostro en píxeles y si hubo detección.

**No calcula R2, ni ventanas, ni especificidad, ni contraste.** Eso lo hace
`medir_utarldd.py`, una sola vez, sobre los CSV de los cinco folds.

La separación es deliberada y está en el `Preregistro_UTA_RLDD.md`: si se midiera
fold por fold se podría mirar un resultado parcial y decidir si seguir, que es
elegir el n después de ver datos. Extraer no es medir.

POR QUÉ UN CSV POR VIDEO
------------------------
El trabajo son ~648.000 cuadros y varias horas. Un archivo por video hace el
proceso reanudable —lo ya hecho se saltea— y evita que una interrupción deje un
CSV a medio escribir que después se lea como completo.

PERMITE BORRAR LOS VIDEOS
-------------------------
Los CSV pesan megabytes; los videos, 111 GB. Con 200 GB libres en un solo disco
no entran los zips más lo extraído. Flujo previsto: bajar un fold, extraerlo,
correr esto, **borrar los videos de ese fold**, seguir con el siguiente.

FIDELIDAD CON EL PRODUCTO
-------------------------
- `ear_avg` se calcula con los MISMOS índices de landmarks y la MISMA fórmula que
  `frontend/src/offscreen/features.js` (EAR sobre coordenadas de píxel, promedio
  de los dos ojos). Medir de otra forma mediría otro detector.
- El ancho de rostro se mide sobre la malla, `(max(x) - min(x)) * w`, igual que
  `engagenet/medir_engagenet.py`, para que las cifras sean comparables con el
  p5 = 179,6 px de EngageNet.
- El modelo es `fl_v1.task`, el mismo binario que despacha la extensión. Se repone
  con `analisis/preparar_entorno.py` (descarga fijada + SHA-256).
- Muestreo **por tiempo, no por índice de cuadro**: los videos vienen a 25 y a 30
  fps, y saltear cada N cuadros daría 6,25 fps en unos y 6,00 en otros. Como
  `reglas_geometricas.py` convierte rachas a segundos con FPS = 6,0 constante, esa
  diferencia correría el umbral de microsueño un 4 %. Se toma el cuadro más cercano
  a cada múltiplo de 1/6 s.

USO
---
    python extraer_utarldd.py --raiz datasets/UTA-RLDD/videos
    python extraer_utarldd.py --raiz ... --salida ./salida    # por defecto ./salida
"""
import sys

# La consola de Windows suele venir en cp1252, donde los emoji NO existen: un
# `print` con uno lanza UnicodeEncodeError y aborta el script. Acá eso pasaría
# DESPUES de horas de trabajo, en la línea final del informe. Se fuerza UTF-8 y
# se degrada a `?` en vez de fallar.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import argparse
import csv
import io
import math
import os
import re
import time

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

AQUI = os.path.dirname(os.path.abspath(__file__))

FPS_MUESTREO = 6.0        # tasa de la rama geométrica (reglas.js: FPS = 6.0)
MODELO = os.path.join(AQUI, "fl_v1.task")

# Índices de landmarks, copiados de `frontend/src/offscreen/features.js`.
RIGHT_EYE = [33, 160, 158, 133, 153, 144]
LEFT_EYE = [362, 385, 387, 263, 373, 380]

# La etiqueta ES el nombre del archivo (verificado sobre los zips el 2026-08-27).
NIVELES = {"0": "alerta", "5": "vigilancia_baja", "10": "somnoliento"}

# Extensiones observadas: .mp4, .mov y .MOV, mezcladas incluso dentro de un mismo
# sujeto. El recorrido es agnóstico de extensión y case-insensitive a propósito:
# un glob por extensión perdería videos EN SILENCIO.
EXT_VIDEO = {".mp4", ".mov", ".avi", ".m4v"}

COLUMNAS = ["i", "t_seg", "detectado", "ear_avg", "ear_left", "ear_right",
            "ancho_px", "ancho_rel", "alto_px"]


def ear(landmarks, ids, w, h):
    """EAR sobre coordenadas de PÍXEL — port exacto de `features.js`."""
    p = [(landmarks[i].x * w, landmarks[i].y * h) for i in ids]
    horiz = math.dist(p[0], p[3])
    if horiz == 0:
        return float("nan")
    return (math.dist(p[1], p[5]) + math.dist(p[2], p[4])) / (2 * horiz)


def listar_videos(raiz):
    """(fold, sujeto, nivel, [rutas en orden]) por cada grabación bajo `raiz`.

    Estructura: <Fold N_part M>/<sujeto de 2 dígitos>/<etiqueta>.<ext>

    GRABACIONES PARTIDAS EN VARIOS ARCHIVOS
    ---------------------------------------
    El sujeto 32 del fold 3 tiene su nivel 10 en `10_1.mp4` (7,02 min) y
    `10_2.mp4` (3,05 min). **Suman 10,06 min**, que es la duración nominal de
    todas las demás grabaciones: no son dos tomas, es UNA sesión partida —
    presumiblemente por un corte de la grabación del teléfono.

    Se tratan como un solo video, concatenando las partes EN ORDEN. Es lo fiel:
    la línea base de R2 sale de los primeros 30 s de la sesión, y esos 30 s están
    al principio de la parte 1. Descartar la parte 2, o tomar cada parte como una
    sesión con su propia línea base, describiría algo que no ocurrió.

    Declarado en `Preregistro_UTA_RLDD.md` §7.bis antes de medir nada.
    """
    grupos, ignorados = {}, []
    for dirpath, _, files in os.walk(raiz):
        for f in files:
            base, ext = os.path.splitext(f)
            if ext.lower() not in EXT_VIDEO:
                continue
            ruta = os.path.join(dirpath, f)
            sujeto = os.path.basename(dirpath)
            m = re.search(r"Fold(\d+)", ruta, re.IGNORECASE)
            fold = m.group(1) if m else "?"

            # `10` -> nivel 10, parte 1.   `10_2` -> nivel 10, parte 2.
            mp = re.fullmatch(r"(0|5|10)(?:_(\d+))?", base)
            if not mp:
                # No se adivina: un archivo que no encaja no tiene etiqueta, y
                # asignarle una sería fabricar ground truth.
                ignorados.append(ruta)
                continue
            nivel, parte = mp.group(1), int(mp.group(2) or 1)
            grupos.setdefault((fold, sujeto, nivel), []).append((parte, ruta))

    encontrados = []
    for (fold, sujeto, nivel), partes in grupos.items():
        rutas = [r for _, r in sorted(partes)]
        if len(rutas) == 1 or _es_una_sesion_partida(rutas):
            encontrados.append((fold, sujeto, nivel, rutas, ""))
        else:
            # Grabaciones distintas: cada una con su propia linea base, que es
            # lo que hace el producto con dos sesiones separadas.
            for k, r in enumerate(rutas, 1):
                encontrados.append((fold, sujeto, nivel, [r], f"_p{k}"))
    return sorted(encontrados), ignorados


# Rango nominal de duracion de una grabacion de UTA-RLDD. Todas rondan los
# 10 min; la holgura es amplia a proposito, porque el criterio solo tiene que
# separar "una sesion interrumpida" de "dos grabaciones distintas".
NOMINAL_SEG = (7 * 60, 16 * 60)


def _es_una_sesion_partida(rutas):
    """True si las partes son UNA grabacion cortada, no dos grabaciones.

    Los dos casos que trae el conjunto:

      sujeto 32 -> 7,02 + 3,05 = 10,06 min, ambas 1080x1920  -> SI, una sesion
      sujeto 49 -> 5,30 + 19,52 = 24,82 min, 270x480 y ?x288 -> NO, dos grabaciones

    El criterio es ESTRUCTURAL —misma resolucion y duracion total dentro del
    rango nominal— y se decide sobre metadatos, sin medir nada.

    Concatenar el caso del sujeto 49 daria un video de 24,8 min que mezcla dos
    camaras bajo una sola linea base, y le daria a ese sujeto el triple de
    ventanas que a los demas. Ver `Preregistro_UTA_RLDD.md` §7.bis.1.
    """
    dims, total = set(), 0.0
    for r in rutas:
        c = cv2.VideoCapture(r)
        fps = c.get(cv2.CAP_PROP_FPS) or 0
        n = c.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        dims.add((int(c.get(cv2.CAP_PROP_FRAME_WIDTH)),
                  int(c.get(cv2.CAP_PROP_FRAME_HEIGHT))))
        total += (n / fps) if fps else 0
        c.release()
    return len(dims) == 1 and NOMINAL_SEG[0] <= total <= NOMINAL_SEG[1]


def procesar(rutas, detector):
    """Devuelve (filas, meta). Una fila por muestra a 6 fps.

    `rutas` es la lista de partes EN ORDEN. El índice de muestra y el tiempo
    siguen corriendo de una parte a la siguiente, de modo que aguas abajo la
    grabación se ve como una sola: las ventanas de 50 s y la línea base de los
    primeros 30 s se computan sobre la sesión completa.
    """
    filas, i_muestra, t_offset = [], 0, 0.0
    meta_acum = dict(n_cuadros_origen=0, dur_seg=0.0, fps_origen=None,
                     ancho_cuadro=0, alto_cuadro=0, n_partes=len(rutas))
    for ruta in rutas:
        f, m = _procesar_parte(ruta, detector, i_muestra, t_offset)
        if f is None:
            return None, m
        filas += f
        i_muestra += len(f)
        t_offset += m["dur_seg"]
        meta_acum["n_cuadros_origen"] += m["n_cuadros_origen"]
        meta_acum["dur_seg"] += m["dur_seg"]
        # De la primera parte: es la que fija la línea base.
        if meta_acum["fps_origen"] is None:
            meta_acum["fps_origen"] = m["fps_origen"]
            meta_acum["ancho_cuadro"] = m["ancho_cuadro"]
            meta_acum["alto_cuadro"] = m["alto_cuadro"]

    det = sum(f[2] for f in filas)
    meta_acum.update(n_muestras=len(filas), n_detectadas=det,
                     tasa_deteccion=det / len(filas) if filas else 0.0,
                     dur_seg=round(meta_acum["dur_seg"], 1))
    return filas, meta_acum


def _procesar_parte(ruta, detector, i0, t0):
    """Una parte. `i0` y `t0` continúan la numeración de las partes anteriores."""
    cap = cv2.VideoCapture(ruta)
    # Aplica la rotación declarada en los metadatos: varios videos son de teléfono
    # en vertical y sin esto el rostro llegaría de costado, con detección ~0.
    try:
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
    except Exception:
        pass
    if not cap.isOpened():
        return None, {"error": "no abre"}

    fps_src = cap.get(cv2.CAP_PROP_FPS) or 0.0
    if not (fps_src > 0):
        cap.release()
        return None, {"error": "fps de origen desconocido"}

    filas = []
    i_muestra, prox_t, i_cuadro = i0, 0.0, 0
    w = h = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = i_cuadro / fps_src
        if t + 1e-9 >= prox_t:
            h, w = frame.shape[:2]
            img = mp.Image(image_format=mp.ImageFormat.SRGB,
                           data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            r = detector.detect(img)
            lms = r.face_landmarks[0] if r.face_landmarks else None
            if lms:
                eR, eL = ear(lms, RIGHT_EYE, w, h), ear(lms, LEFT_EYE, w, h)
                xs = [p.x for p in lms]
                rel = max(xs) - min(xs)
                filas.append([i_muestra, round(t0 + t, 4), 1,
                              (eR + eL) / 2, eL, eR,
                              rel * w, rel, h])
            else:
                filas.append([i_muestra, round(t0 + t, 4), 0, "", "", "", "", "", h])
            i_muestra += 1
            prox_t += 1.0 / FPS_MUESTREO
        i_cuadro += 1
    cap.release()

    det = sum(f[2] for f in filas)
    return filas, {
        "n_muestras": len(filas), "n_detectadas": det,
        "tasa_deteccion": det / len(filas) if filas else 0.0,
        "fps_origen": round(fps_src, 3), "ancho_cuadro": w, "alto_cuadro": h,
        "dur_seg": i_cuadro / fps_src, "n_cuadros_origen": i_cuadro,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raiz", required=True, help="carpeta con los Fold*_part* extraídos")
    ap.add_argument("--salida", default=os.path.join(AQUI, "salida"))
    ap.add_argument("--rehacer", action="store_true", help="reprocesa aunque el CSV exista")
    args = ap.parse_args()

    if not os.path.exists(MODELO):
        sys.exit(f"ABORTA: falta {MODELO}. Reponerlo con analisis/preparar_entorno.py")

    videos, ignorados = listar_videos(args.raiz)
    if not videos:
        sys.exit(f"ABORTA: no se encontró ningún video bajo {args.raiz}")
    if ignorados:
        # Se avisa fuerte: un archivo de video que no se llama 0/5/10 significa
        # que la estructura no es la verificada, y el resto de los supuestos
        # también podrían no valer.
        print(f"[!] {len(ignorados)} archivos de video SIN etiqueta reconocible "
              f"(no son 0/5/10). Se ignoran. Primero: {ignorados[0]}")

    cuadros_dir = os.path.join(args.salida, "cuadros")
    os.makedirs(cuadros_dir, exist_ok=True)
    ruta_videos = os.path.join(args.salida, "videos.csv")
    nuevo = not os.path.exists(ruta_videos)

    print(f"{len(videos)} videos bajo {args.raiz}")
    sujetos = sorted({s for _, s, _, _ in videos})
    print(f"{len(sujetos)} sujetos: {' '.join(sujetos)}")

    fh = io.open(ruta_videos, "a", encoding="utf-8", newline="")
    wv = csv.writer(fh)
    if nuevo:
        wv.writerow(["fold", "sujeto", "nivel", "nivel_nombre", "archivo",
                     "n_muestras", "n_detectadas", "tasa_deteccion", "fps_origen",
                     "ancho_cuadro", "alto_cuadro", "dur_seg", "n_cuadros_origen",
                     "n_partes", "csv_cuadros"])

    opts = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODELO),
        output_facial_transformation_matrixes=True, num_faces=1)
    detector = vision.FaceLandmarker.create_from_options(opts)

    t0 = time.time()
    for k, (fold, sujeto, nivel, rutas, sufijo) in enumerate(videos, 1):
        nombre_csv = f"f{fold}_s{sujeto}_n{nivel}{sufijo}.csv"
        destino = os.path.join(cuadros_dir, nombre_csv)
        if os.path.exists(destino) and not args.rehacer:
            print(f"[{k}/{len(videos)}] ya estaba: {os.path.basename(destino)}")
            continue

        partes = f" ({len(rutas)} partes)" if len(rutas) > 1 else ""
        print(f"[{k}/{len(videos)}] fold {fold} · sujeto {sujeto} · "
              f"nivel {nivel} ({NIVELES[nivel]}){partes} … ", end="", flush=True)
        filas, meta = procesar(rutas, detector)
        if filas is None:
            print(f"ERROR: {meta.get('error')}")
            continue

        tmp = destino + ".parcial"
        with io.open(tmp, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(COLUMNAS)
            w.writerows(filas)
        os.replace(tmp, destino)   # atómico: nunca queda un CSV a medio escribir

        wv.writerow([fold, sujeto, nivel, NIVELES[nivel],
                     "|".join(os.path.basename(r) for r in rutas),
                     meta["n_muestras"], meta["n_detectadas"],
                     round(meta["tasa_deteccion"], 4), meta["fps_origen"],
                     meta["ancho_cuadro"], meta["alto_cuadro"],
                     meta["dur_seg"], meta["n_cuadros_origen"], meta["n_partes"],
                     nombre_csv])
        fh.flush()

        aviso = ""
        if meta["tasa_deteccion"] < 0.70:
            # No es un error del script: es el dato que M4 del pre-registro busca.
            aviso = "   <-- deteccion < 70 %, quedaría excluido del primario"
        print(f"{meta['n_muestras']} muestras · detección "
              f"{100*meta['tasa_deteccion']:.1f} % · "
              f"{meta['ancho_cuadro']}x{meta['alto_cuadro']} · "
              f"{meta['dur_seg']/60:.1f} min{aviso}")

    fh.close()
    print(f"\nlisto en {(time.time()-t0)/60:.1f} min")
    print(f"cuadros -> {cuadros_dir}")
    print(f"videos  -> {ruta_videos}")
    print("\nYa se pueden BORRAR los videos de este fold. NO se midió nada:")
    print("las mediciones las hace medir_utarldd.py sobre los cinco folds juntos.")


if __name__ == "__main__":
    main()
