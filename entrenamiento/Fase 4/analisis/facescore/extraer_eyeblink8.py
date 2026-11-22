"""Extracción de Eyeblink8 para C5 de `faceScore` y el criterio por cuadro de R2.

Criterios y procedimiento: `Preregistro_Eyeblink8.md` §2 y su adenda §8.

QUÉ HACE
  Recorre los 8 videos. El tiempo real de cada cuadro sale del `.txt` con la
  alineación verificada en la adenda §8.1: el cuadro k que lee OpenCV (desde 0)
  es el cuadro k del `.tag`, y su tiempo es la línea k−1 del `.txt`. Los cuadros
  sin tiempo no se procesan y se cuentan.

  Corre MediaPipe en modo video con DOS detectores por video:
    - nativo: todos los cuadros con tiempo. Da `eyeBlink` medio y `ear_avg` por
      cuadro (K2–K4) y alimenta `PuntajeCara` a cadencia nativa (sensibilidad).
    - 6 fps: sólo los cuadros de la grilla, con un detector propio, porque el
      producto no ve los cuadros intermedios y el modo video usa el cuadro
      anterior. Alimenta `PuntajeCara` a 6 fps (K1 primario).

LO QUE NO HACE, A PROPÓSITO
  - No lee la anotación (`.tag`). El cruce con los parpadeos lo hace sólo
    `medir_eyeblink8.py`.
  - No calcula ninguna métrica.
  - No se versiona nada de lo que escribe por cuadro (ver `.gitignore`).

SALIDAS (en salida/)
  eyeblink8_nativo_<v>.csv             un registro por cuadro con tiempo
  eyeblink8_6fps_<v>.csv               un registro por muestra de la grilla
  muestra_eyeblink8/<v>_6fps.json      la grilla de 6 fps entera con sus valores
                                       crudos y 5 cortes sorteados con semilla 42
                                       ANTES de extraer: fidelidad temporal contra
                                       el JS, cada corte con toda su historia
  muestra_eyeblink8/<v>_cuadros.json   cuadros candidatos a la muestra por cuadro
                                       (sorteo por hash con semilla 42); medir toma
                                       los 400 de sorteo más bajo
  eyeblink8_extraccion.json            agregados por video, versiones y SHA del
                                       modelo. Sin nada por cuadro

SE PUEDE CORTAR Y RETOMAR: un video ya registrado en eyeblink8_extraccion.json,
con sus archivos, se saltea.

ENSAYO: `python extraer_eyeblink8.py --ensayo` usa un detector falso que nunca
ve caras, para verificar la grilla y los tiempos sin correr MediaPipe. Escribe
donde diga FACESCORE_SALIDA, que tiene que apuntar fuera de salida/.
"""
import csv
import glob
import hashlib
import json
import math
import os
import platform
import random
import sys
import time
from datetime import datetime
from types import SimpleNamespace

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import facescore_ref as fs  # noqa: E402

RAIZ = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
MODELO = os.path.join(AQUI, "..", "biwi_yaw", "fl_v1.task")
SHA_MODELO = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"

SALIDA = os.environ.get("FACESCORE_SALIDA", os.path.join(AQUI, "salida"))
DIR_MUESTRA = os.path.join(SALIDA, "muestra_eyeblink8")
RESUMEN = os.path.join(SALIDA, "eyeblink8_extraccion.json")

VIDEOS = ("1", "2", "3", "4", "8", "9", "10", "11")

# Grilla de 6 fps sobre el tiempo real, con media trama de tolerancia
# (`Preregistro_FaceScore.md` §4.3 punto 2). Si hay un salto en el video no se
# recuperan los puntos perdidos: el producto tampoco muestrea lo que no existió.
PASO_6FPS = 1000.0 / 6
TOLERANCIA_MS = 1000.0 / 60

SEMILLA = 42
FRACCION_CANDIDATOS = 0.03   # ~2.100 candidatos para quedarse con 400 con rostro
CORTES_POR_VIDEO = 5         # 8 × 5 = 40 cortes de fidelidad temporal

# Índices de landmarks, copiados de `frontend/src/offscreen/features.js`.
RIGHT_EYE = [33, 160, 158, 133, 153, 144]
LEFT_EYE = [362, 385, 387, 263, 373, 380]

CAMPOS_NATIVO = ["video", "k", "t_ms", "rostro", "omitido", "blink", "ear_avg", "causa"]
CAMPOS_6FPS = ["video", "k", "t_ms", "rostro", "omitido", "blink", "ear_avg", "causa", "valor"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def ear(landmarks, ids, w, h):
    """EAR sobre coordenadas de PÍXEL — port exacto de `features.js` (mismo que UTA-RLDD)."""
    p = [(landmarks[i].x * w, landmarks[i].y * h) for i in ids]
    horiz = math.dist(p[0], p[3])
    if horiz == 0:
        return float("nan")
    return (math.dist(p[1], p[5]) + math.dist(p[2], p[4])) / (2 * horiz)


def sorteo(video, k):
    """Número en [0, 1) fijo por cuadro. No depende de cuántos cuadros haya."""
    h = hashlib.sha256(f"{SEMILLA}:{video}:{k}".encode()).digest()
    return int.from_bytes(h[:8], "big") / 2 ** 64


def archivo(video, patron):
    hallados = glob.glob(os.path.join(RAIZ, video, patron))
    if len(hallados) != 1:
        raise SystemExit(f"🔴 video {video}: se esperaba un {patron} y hay {len(hallados)}")
    return hallados[0]


def tiempos(video):
    with open(archivo(video, "*.txt"), encoding="utf-8") as f:
        return [float(linea.split()[1]) * 1000.0 for linea in f if linea.strip()]


def cortes(ts):
    """5 instantes al azar entre 10 s y el último cuadro legible (§7: OpenCV lee
    49 cuadros menos que el `.txt`). Dependen sólo de los tiempos, no de MediaPipe."""
    rng = random.Random(SEMILLA)
    return sorted(rng.uniform(ts[0] + fs.WINDOW_MS, ts[-50]) for _ in range(CORTES_POR_VIDEO))


class DetectorFalso:
    """Nunca ve caras. Sólo para el ensayo de la grilla."""

    def detect_for_video(self, imagen, t_ms):
        return SimpleNamespace(face_landmarks=[], facial_transformation_matrixes=[], face_blendshapes=[])

    def close(self):
        pass


def nuevo_detector(ensayo):
    if ensayo:
        return DetectorFalso()
    return vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODELO),
        running_mode=vision.RunningMode.VIDEO,
        output_facial_transformation_matrixes=True, output_face_blendshapes=True, num_faces=1))


def leer(res, w, h):
    """(rostro, lm de faceScore, m_col, bs, ear_avg) de un resultado de MediaPipe."""
    if not res.face_landmarks:
        return False, None, None, None, float("nan")
    puntos = res.face_landmarks[0]
    lm = {i: (puntos[i].x, puntos[i].y, puntos[i].z) for i in fs.LANDMARKS_USADOS}
    m_col = bs = None
    if res.facial_transformation_matrixes and res.face_blendshapes:
        m_col = np.array(res.facial_transformation_matrixes[0]).T.flatten().tolist()
        bs = {c.category_name: c.score for c in res.face_blendshapes[0]}
    e = (ear(puntos, RIGHT_EYE, w, h) + ear(puntos, LEFT_EYE, w, h)) / 2
    return True, lm, m_col, bs, e


def crudo(k, t, rostro, lm, m_col, bs):
    return dict(k=k, t=t, rostro=rostro, m_col=m_col, bs=bs,
                lm={str(i): list(v) for i, v in lm.items()} if lm else None)


def fmt(x):
    return "" if x is None or (isinstance(x, float) and not math.isfinite(x)) else repr(x)


def escribir_csv(ruta, campos, filas):
    tmp = ruta + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=campos)
        w.writeheader()
        w.writerows(filas)
    os.replace(tmp, ruta)


def escribir_json(ruta, obj):
    tmp = ruta + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, ruta)


def procesar(video, ensayo):
    ts = tiempos(video)
    if any(not b > a for a, b in zip(ts, ts[1:])):
        raise SystemExit(f"🔴 video {video}: tiempos del .txt no estrictamente crecientes")
    mis_cortes = cortes(ts)

    cap = cv2.VideoCapture(archivo(video, "*.avi"))
    det_nat, det_6 = nuevo_detector(ensayo), nuevo_detector(ensayo)
    p_nat, p_6 = fs.PuntajeCara(), fs.PuntajeCara()
    filas_nat, filas_6, grilla, candidatos = [], [], [], []
    k, k_grilla, sin_tiempo, t_mp_previo = -1, 0, 0, -1
    try:
        while True:
            ok, cuadro = cap.read()
            if not ok:
                break
            k += 1
            if not 1 <= k <= len(ts):
                sin_tiempo += 1
                continue
            t = ts[k - 1]
            t_mp = int(round(t))
            if t_mp <= t_mp_previo:      # §7: no pasa en ninguno de los 8, pero MediaPipe lo exige
                raise SystemExit(f"🔴 video {video}, cuadro {k}: tiempo entero en ms no creciente")
            t_mp_previo = t_mp
            h, w = cuadro.shape[:2]
            imagen = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(cuadro, cv2.COLOR_BGR2RGB))

            rostro, lm, m_col, bs, e = leer(det_nat.detect_for_video(imagen, t_mp), w, h)
            causa = p_nat.registrar(t, rostro, m_col, lm, bs)
            filas_nat.append(dict(video=video, k=k, t_ms=repr(t), rostro=int(rostro),
                                  omitido=int(causa == "omitido"),
                                  blink=fmt(fs.parpadeo(bs)) if bs is not None else "",
                                  ear_avg=fmt(e), causa=causa or ""))
            s = sorteo(video, k)
            if m_col is not None and bs is not None and s < FRACCION_CANDIDATOS:
                candidatos.append(dict(video=video, sorteo=s, **crudo(k, t, rostro, lm, m_col, bs)))

            if t >= k_grilla * PASO_6FPS - TOLERANCIA_MS:
                k_grilla = math.floor((t + TOLERANCIA_MS) / PASO_6FPS) + 1
                r6, lm6, m6, bs6, e6 = leer(det_6.detect_for_video(imagen, t_mp), w, h)
                causa6 = p_6.registrar(t, r6, m6, lm6, bs6)
                valor6 = p_6.valor(t)   # recortar la ventana antes no altera recortes posteriores
                # `ear_avg` a 6 fps: la línea base de R2 son los primeros 180 valores
                # finitos A LA CADENCIA DEL PRODUCTO (30 s con rostro, Enmienda_5).
                filas_6.append(dict(video=video, k=k, t_ms=repr(t), rostro=int(r6),
                                    omitido=int(causa6 == "omitido"),
                                    blink=fmt(fs.parpadeo(bs6)) if bs6 is not None else "",
                                    ear_avg=fmt(e6), causa=causa6 or "", valor=fmt(valor6)))
                grilla.append(crudo(k, t, r6, lm6, m6, bs6))
    finally:
        cap.release()
        det_nat.close()
        det_6.close()

    escribir_csv(os.path.join(SALIDA, f"eyeblink8_nativo_{video}.csv"), CAMPOS_NATIVO, filas_nat)
    escribir_csv(os.path.join(SALIDA, f"eyeblink8_6fps_{video}.csv"), CAMPOS_6FPS, filas_6)
    escribir_json(os.path.join(DIR_MUESTRA, f"{video}_6fps.json"),
                  dict(video=video, cortes=mis_cortes, cuadros=grilla))
    escribir_json(os.path.join(DIR_MUESTRA, f"{video}_cuadros.json"), candidatos)

    if not filas_nat:
        raise SystemExit(f"🔴 video {video}: ningún cuadro con tiempo")
    dur_s = (float(filas_nat[-1]["t_ms"]) - float(filas_nat[0]["t_ms"])) / 1000
    return dict(
        cuadros_leidos=k + 1, sin_tiempo=sin_tiempo, procesados=len(filas_nat), duracion_s=round(dur_s, 3),
        nativo=dict(rostro=sum(f["rostro"] for f in filas_nat), omitidos=sum(f["omitido"] for f in filas_nat)),
        grilla_6fps=dict(n=len(filas_6), fps_efectivo=round(len(filas_6) / dur_s, 3) if dur_s else None,
                         rostro=sum(f["rostro"] for f in filas_6), omitidos=sum(f["omitido"] for f in filas_6)),
        candidatos_por_cuadro=len(candidatos), cortes_ms=mis_cortes)


def main():
    ensayo = "--ensayo" in sys.argv
    if ensayo and os.path.abspath(SALIDA) == os.path.abspath(os.path.join(AQUI, "salida")):
        raise SystemExit("🔴 El ensayo no escribe en salida/: definí FACESCORE_SALIDA.")
    if not ensayo and sha256(MODELO) != SHA_MODELO:
        raise SystemExit(f"🔴 {MODELO} no es el modelo fijado (SHA-256 distinto).")
    for v in VIDEOS:
        archivo(v, "*.avi"), archivo(v, "*.txt")
    os.makedirs(DIR_MUESTRA, exist_ok=True)

    resumen = dict(videos={})
    if os.path.exists(RESUMEN):
        with open(RESUMEN, encoding="utf-8") as f:
            resumen = json.load(f)
        if resumen.get("ensayo") != ensayo:
            raise SystemExit("🔴 El resumen existente es de otro modo (ensayo/real). No se mezclan.")
    resumen.update(
        ensayo=ensayo, preregistro="Preregistro_Eyeblink8.md §2 y adenda §8",
        modelo=dict(archivo="fl_v1.task", sha256=SHA_MODELO, modo="VIDEO", num_faces=1),
        versiones=dict(python=platform.python_version(), mediapipe=mp.__version__,
                       opencv=cv2.__version__, numpy=np.__version__),
        alineacion="cuadro k leído por OpenCV = cuadro k del .tag; tiempo = línea k−1 del .txt",
        grilla=dict(paso_ms=PASO_6FPS, tolerancia_ms=TOLERANCIA_MS),
        semilla=SEMILLA, fraccion_candidatos=FRACCION_CANDIDATOS, cortes_por_video=CORTES_POR_VIDEO)

    def hecho(v):
        return v in resumen["videos"] and all(os.path.exists(p) for p in (
            os.path.join(SALIDA, f"eyeblink8_nativo_{v}.csv"), os.path.join(SALIDA, f"eyeblink8_6fps_{v}.csv"),
            os.path.join(DIR_MUESTRA, f"{v}_6fps.json"), os.path.join(DIR_MUESTRA, f"{v}_cuadros.json")))

    pendientes = [v for v in VIDEOS if not hecho(v)]
    print(f"{'ENSAYO (detector falso) · ' if ensayo else ''}videos pendientes: {pendientes}", flush=True)
    inicio = time.time()
    for v in pendientes:
        t0 = time.time()
        r = procesar(v, ensayo)
        r["segundos"] = round(time.time() - t0, 1)
        resumen["videos"][v] = r
        resumen["actualizado"] = datetime.now().isoformat(timespec="seconds")
        with open(RESUMEN, "w", encoding="utf-8") as f:
            json.dump(resumen, f, indent=2, ensure_ascii=False)
        print(f"  video {v:>2}: {r['procesados']} cuadros · sin tiempo {r['sin_tiempo']} · "
              f"grilla {r['grilla_6fps']['n']} ({r['grilla_6fps']['fps_efectivo']} fps) · "
              f"{r['segundos']} s · acumulado {(time.time() - inicio) / 60:.1f} min", flush=True)

    print(f"\nresumen -> {RESUMEN}")
    print("No se leyó la anotación ni se calculó ninguna métrica. Sigue medir_eyeblink8.py.")


if __name__ == "__main__":
    main()
