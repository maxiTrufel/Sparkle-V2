"""Extracción de EngageNet validación para la capa geométrica desplegada (`faceScore`).

Criterios y procedimiento: `Preregistro_FaceScore.md` §4 y su adenda §4.3.

QUÉ HACE
  Recorre los 1.071 clips de validación, muestrea cuadros por TIEMPO REAL del
  video (no por el fps declarado, que en algunos clips está roto), corre
  MediaPipe y alimenta el port temporal de `faceScore` (`PuntajeCara`) con dos
  cadencias a la vez: 6 fps (primaria, pre-registrada) y 5 fps (sensibilidad,
  adenda §4.3). Escribe un registro por clip.

LO QUE NO HACE, A PROPÓSITO
  - No lee las etiquetas. El cruce con `Engaged`/`Not-Engaged` lo hace sólo
    `medir_facescore_engagenet.py`, en memoria.
  - No calcula ninguna métrica.
  - No se versiona nada de lo que escribe (ver `.gitignore`): el CSV por clip se
    cruza con las etiquetas por nombre, y el EULA prohíbe redistribuirlas.

SE PUEDE CORTAR Y RETOMAR: los clips ya escritos en el CSV se saltean.
"""
import csv
import glob
import hashlib
import json
import math
import os
import random
import re
import sys
import time
from collections import Counter

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import facescore_ref as fs  # noqa: E402

VIDEOS = os.environ.get(
    "ENGAGENET_VIDEOS", os.path.join("datasets", "EngageNet", "Validation"))
MODELO = os.path.join(AQUI, "..", "biwi_yaw", "fl_v1.task")
SHA_MODELO = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"

SALIDA = os.path.join(AQUI, "salida")
CSV_CLIPS = os.path.join(SALIDA, "facescore_engagenet_clips.csv")
DIR_MUESTRA = os.path.join(SALIDA, "muestra_engagenet")

# Grilla fija de tiempo. Se toma el primer cuadro cuyo tiempo alcanza cada punto
# de la grilla, con media trama de tolerancia a 30 fps: sin ella, un cuadro a
# 166,666 ms no alcanza 166,667 y la "grilla de 6 fps" termina muestreando a 5.
CADENCIAS = {"6fps": 1000.0 / 6, "5fps": 200.0}
TOLERANCIA_MS = 1000.0 / 60
N_MUESTRA = 40
SEMILLA = 42

CAUSAS = ("sin_rostro", "ojos", "lateral", "vertical")
CAMPOS = ["chunk", "sujeto", "tiempo_ok", "cuadros_video", "duracion_s"] + [
    f"{c}_{campo}" for c in CADENCIAS
    for campo in ("n", "rostro", "omitidos", "valor", "valor_cabeza") + CAUSAS]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def procesar(ruta, detector, guardar_crudo):
    cap = cv2.VideoCapture(ruta)
    est = {c: dict(k=0, p=fs.PuntajeCara(), ph=fs.PuntajeCara(), n=0, rostro=0,
                   omitidos=0, causas=Counter(), ultimo=None) for c in CADENCIAS}
    crudo, previo, tiempo_ok, cuadros = [], -1.0, True, 0

    while cap.grab():
        cuadros += 1
        t = cap.get(cv2.CAP_PROP_POS_MSEC)
        if not t > previo:
            tiempo_ok = False            # adenda §4.3: tiempo no creciente -> clip excluido
            break
        previo = t
        tocan = [c for c, e in est.items() if t >= e["k"] * CADENCIAS[c] - TOLERANCIA_MS]
        if not tocan:
            continue
        ok, cuadro = cap.retrieve()
        if not ok:
            continue
        res = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                       data=cv2.cvtColor(cuadro, cv2.COLOR_BGR2RGB)))
        rostro, lm, m_col, bs = bool(res.face_landmarks), None, None, None
        if rostro:
            puntos = res.face_landmarks[0]
            lm = {i: (puntos[i].x, puntos[i].y, puntos[i].z) for i in fs.LANDMARKS_USADOS}
            if res.facial_transformation_matrixes and res.face_blendshapes:
                m_col = np.array(res.facial_transformation_matrixes[0]).T.flatten().tolist()
                bs = {c.category_name: c.score for c in res.face_blendshapes[0]}

        for c in tocan:
            e = est[c]
            # Siguiente punto de la grilla posterior a este cuadro. Si hubo un
            # salto en el video, no se recuperan los puntos perdidos: el
            # producto tampoco muestrea cuadros que no existieron.
            e["k"] = math.floor((t + TOLERANCIA_MS) / CADENCIAS[c]) + 1
            e["n"] += 1
            e["rostro"] += int(rostro)
            causa = e["p"].registrar(t, rostro, m_col, lm, bs)
            e["ph"].registrar(t, rostro, m_col, lm, {} if bs is not None else None)
            if causa == "omitido":
                e["omitidos"] += 1
            elif causa:
                e["causas"][causa] += 1
            e["ultimo"] = t
        if guardar_crudo and "6fps" in tocan:
            crudo.append(dict(t=t, rostro=rostro, m_col=m_col, bs=bs,
                              lm={str(i): list(v) for i, v in lm.items()} if lm else None))
    cap.release()

    chunk = os.path.basename(ruta)
    m = re.match(r"^(subject_\d+)", chunk)
    fila = dict(chunk=chunk, sujeto=m.group(1) if m else "", tiempo_ok=int(tiempo_ok),
                cuadros_video=cuadros, duracion_s=round(previo / 1000, 3))
    for c, e in est.items():
        valor = e["p"].valor(e["ultimo"]) if (tiempo_ok and e["ultimo"] is not None) else None
        valor_c = e["ph"].valor(e["ultimo"]) if (tiempo_ok and e["ultimo"] is not None) else None
        fila.update({f"{c}_n": e["n"], f"{c}_rostro": e["rostro"], f"{c}_omitidos": e["omitidos"],
                     f"{c}_valor": "" if valor is None else repr(valor),
                     f"{c}_valor_cabeza": "" if valor_c is None else repr(valor_c)})
        fila.update({f"{c}_{k}": e["causas"][k] for k in CAUSAS})
    return fila, (crudo if tiempo_ok else None)


def main():
    if sha256(MODELO) != SHA_MODELO:
        raise SystemExit(f"{MODELO} no es el modelo fijado (SHA-256 distinto).")
    clips = sorted(glob.glob(os.path.join(VIDEOS, "*.mp4")))
    if not clips:
        raise SystemExit(f"No hay clips en {VIDEOS}")
    os.makedirs(DIR_MUESTRA, exist_ok=True)
    muestra = set(random.Random(SEMILLA).sample([os.path.basename(p) for p in clips], N_MUESTRA))

    hechos = set()
    if os.path.exists(CSV_CLIPS):
        with open(CSV_CLIPS, encoding="utf-8", newline="") as f:
            hechos = {r["chunk"] for r in csv.DictReader(f)}
    nuevo = not hechos
    pendientes = [p for p in clips if os.path.basename(p) not in hechos]
    print(f"clips: {len(clips)} · ya hechos: {len(hechos)} · pendientes: {len(pendientes)}", flush=True)

    detector = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODELO),
        output_facial_transformation_matrixes=True, output_face_blendshapes=True, num_faces=1))

    inicio = time.time()
    with open(CSV_CLIPS, "a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CAMPOS)
        if nuevo:
            w.writeheader()
        for i, ruta in enumerate(pendientes, 1):
            chunk = os.path.basename(ruta)
            fila, crudo = procesar(ruta, detector, chunk in muestra)
            if crudo is not None and chunk in muestra:
                with open(os.path.join(DIR_MUESTRA, chunk + ".json"), "w", encoding="utf-8") as fm:
                    json.dump(dict(chunk=chunk, cuadros=crudo), fm)
            w.writerow(fila)
            f.flush()
            if i % 25 == 0 or i == len(pendientes):
                transcurrido = time.time() - inicio
                resta = transcurrido / i * (len(pendientes) - i)
                print(f"  {i}/{len(pendientes)} · {transcurrido/60:.1f} min · faltan ~{resta/60:.0f} min",
                      flush=True)

    print(f"\nguardado -> {CSV_CLIPS}")
    print(f"muestra  -> {DIR_MUESTRA} ({len(os.listdir(DIR_MUESTRA))} clips)")
    print("No se leyó ninguna etiqueta ni se calculó ninguna métrica. Sigue medir_facescore_engagenet.py.")


if __name__ == "__main__":
    main()
