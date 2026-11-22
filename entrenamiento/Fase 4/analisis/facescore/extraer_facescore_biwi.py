"""Extracción de BIWI para validar la capa geométrica desplegada (`faceScore`).

QUÉ HACE
  Lee los 15.678 pares imagen-pose directamente de los zips del caché de
  Hugging Face (sin descomprimir: son 5,6 GB y no hace falta copiarlos a otro
  disco), corre MediaPipe con matrices, blendshapes y landmarks, y escribe
  un registro por cuadro con lo que `faceScore` necesita y con el ground truth.

LO QUE NO HACE, A PROPÓSITO
  No calcula ninguna métrica. La medición la hace `medir_facescore_biwi.py`,
  una sola vez, contra los criterios de `Preregistro_FaceScore.md`, congelado
  antes de correr esto. Separar extracción de medición es lo que impide mirar
  resultados parciales mientras se extrae.

SALIDAS
  salida/facescore_biwi.csv          un registro por par imagen-pose
  salida/muestra_equivalencia.json   400 cuadros detectados con sus valores
                                     crudos, para verificar el port contra el JS
"""
import glob
import hashlib
import io
import json
import math
import os
import random
import sys
import zipfile

import cv2
import mediapipe as mp
import numpy as np
import pandas as pd
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import facescore_ref as fs  # noqa: E402

MODELO = os.path.join(AQUI, "..", "biwi_yaw", "fl_v1.task")
SHA_MODELO = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
ZIPS = sorted(glob.glob(os.path.join(
    os.path.expanduser("~"), ".cache", "huggingface", "hub",
    "datasets--ZihanWang1029--BIWI", "snapshots", "*", "BIWI", "BK-*.zip")))

SALIDA = os.path.join(AQUI, "salida")
CSV = os.path.join(SALIDA, "facescore_biwi.csv")
MUESTRA = os.path.join(SALIDA, "muestra_equivalencia.json")
N_MUESTRA = 400
SEMILLA = 42

# Ancla independiente del signo (Preregistro §3.2, S2): ojos y boca.
OJO_A, OJO_B, LABIO_A, LABIO_B = 33, 263, 13, 14


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def euler_desde_R(R):
    """(yaw, pitch, roll) en grados. Misma convención que `validar_yaw_biwi.py`."""
    sy = math.sqrt(R[0, 0] ** 2 + R[1, 0] ** 2)
    if sy > 1e-6:
        x = math.atan2(R[2, 1], R[2, 2])
        y = math.atan2(-R[2, 0], sy)
        z = math.atan2(R[1, 0], R[0, 0])
    else:
        x = math.atan2(-R[1, 2], R[1, 1]); y = math.atan2(-R[2, 0], sy); z = 0.0
    return math.degrees(y), math.degrees(x), math.degrees(z)


def leer_pose(texto):
    """3 filas de rotación + 1 de traslación (mm, espacio del Kinect)."""
    v = np.loadtxt(io.StringIO(texto))
    return v[:3, :3], v[3]


def main():
    if not ZIPS:
        raise SystemExit("No están los zips de BIWI en el caché de Hugging Face.")
    if sha256(MODELO) != SHA_MODELO:
        raise SystemExit(f"{MODELO} no es el modelo fijado (SHA-256 distinto).")
    os.makedirs(SALIDA, exist_ok=True)

    opciones = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODELO),
        output_facial_transformation_matrixes=True,
        output_face_blendshapes=True,
        num_faces=1)
    detector = vision.FaceLandmarker.create_from_options(opciones)

    filas, crudos = [], []
    layout_verificado = False
    total = 0
    for ruta_zip in ZIPS:
        with zipfile.ZipFile(ruta_zip) as zf:
            imagenes = sorted(n for n in zf.namelist() if n.endswith("_rgb.png"))
            print(f"{os.path.basename(ruta_zip)}: {len(imagenes)} imágenes", flush=True)
            for nombre in imagenes:
                nombre_pose = nombre.replace("_rgb.png", "_pose.txt")
                secuencia, archivo = nombre.split("/")[0], nombre.split("/")[-1]
                cuadro = archivo.replace("_rgb.png", "")
                R, t = leer_pose(zf.read(nombre_pose).decode())
                yaw_gt, pitch_gt, roll_gt = euler_desde_R(R)

                bgr = cv2.imdecode(np.frombuffer(zf.read(nombre), np.uint8), cv2.IMREAD_COLOR)
                res = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                               data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
                fila = dict(secuencia=secuencia, cuadro=cuadro, detectado=0,
                            incompleto=0, yaw_gt=yaw_gt, pitch_gt=pitch_gt,
                            roll_gt=roll_gt, tz_mm=float(t[2]))

                if res.face_landmarks:
                    if not (res.facial_transformation_matrixes and res.face_blendshapes):
                        # El JS no registra un cuadro así (`if (!m || !bs) return;`).
                        # Se marca y se cuenta: no debería pasar con las dos salidas pedidas.
                        fila.update(detectado=1, incompleto=1)
                    else:
                        M = np.array(res.facial_transformation_matrixes[0])
                        if not layout_verificado:
                            # La traslación tiene que estar en la última columna: si
                            # estuviera en la última fila, M.T no sería column-major.
                            if np.abs(M[:3, 3]).max() <= np.abs(M[3, :3]).max():
                                raise SystemExit("La matriz no viene con la traslación en "
                                                 "la última columna. Revisar el layout.")
                            layout_verificado = True
                        m_col = M.T.flatten().tolist()
                        puntos = res.face_landmarks[0]
                        lm = {i: (puntos[i].x, puntos[i].y, puntos[i].z)
                              for i in fs.LANDMARKS_USADOS + (OJO_A, OJO_B, LABIO_A, LABIO_B)}
                        bs = {c.category_name: c.score for c in res.face_blendshapes[0]}

                        yaw_fs, pitch_fs = fs.angulos_cabeza(m_col, lm)
                        yaw_mat, pitch_mat, _ = euler_desde_R(M[:3, :3])
                        gx, gy = fs.mirada(bs)
                        y_ojos = (lm[OJO_A][1] + lm[OJO_B][1]) / 2
                        y_boca = (lm[LABIO_A][1] + lm[LABIO_B][1]) / 2
                        cociente = ((lm[fs.NARIZ][1] - y_ojos) / (y_boca - y_ojos)
                                    if y_boca != y_ojos else float("nan"))

                        fila.update(detectado=1, yaw_mat=yaw_mat, pitch_mat=pitch_mat,
                                    yaw_fs=yaw_fs, pitch_fs=pitch_fs, gaze_x=gx,
                                    gaze_y=gy, blink=fs.parpadeo(bs),
                                    nariz_cociente=cociente)
                        crudos.append(dict(
                            secuencia=secuencia, cuadro=cuadro, m_col=m_col,
                            lm={str(i): list(lm[i]) for i in fs.LANDMARKS_USADOS}, bs=bs))
                filas.append(fila)
                total += 1
                if total % 1000 == 0:
                    print(f"  {total} procesadas", flush=True)

    df = pd.DataFrame(filas)
    df.to_csv(CSV, index=False)
    random.Random(SEMILLA).shuffle(crudos)
    with open(MUESTRA, "w", encoding="utf-8") as f:
        json.dump(crudos[:N_MUESTRA], f)

    print(f"\npares procesados : {len(df)}")
    print(f"secuencias       : {df.secuencia.nunique()}")
    print(f"con rostro       : {int(df.detectado.sum())}  "
          f"(incompletos: {int(df.incompleto.sum())})")
    print(f"guardado -> {CSV}")
    print(f"muestra  -> {MUESTRA} ({min(N_MUESTRA, len(crudos))} cuadros)")
    print("\nNo se calculó ninguna métrica. Lo que sigue es medir_facescore_biwi.py.")


if __name__ == "__main__":
    main()
