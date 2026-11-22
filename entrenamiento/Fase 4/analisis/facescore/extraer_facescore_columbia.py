"""Extracción de Columbia Gaze para la suma cabeza + mirada de `faceScore`.

Criterios y procedimiento: `Preregistro_ColumbiaGaze.md` §2–§4, adenda §8 y las
precisiones del §7.

QUÉ HACE
  Recorre las 5.880 imágenes, corre MediaPipe en modo imagen a resolución
  original (si no detecta, reintenta UNA vez a la mitad y lo cuenta) y escribe un
  registro por imagen con los valores que usa `faceScore` y los ángulos
  nominales que trae el nombre del archivo.

LO QUE NO HACE, A PROPÓSITO
  - No calcula ninguna métrica. La medición la hace `medir_facescore_columbia.py`.
  - No se versiona nada por imagen (ver `.gitignore`).

SALIDAS (en salida/)
  facescore_columbia.csv               un registro por imagen
  muestra_columbia.jsonl               valores crudos de las candidatas a la muestra
                                       de fidelidad (600 sorteadas con semilla 42
                                       ANTES de extraer; medir usa las 400 primeras
                                       con rostro completo)
  facescore_columbia_extraccion.json   agregados, versiones y SHA del modelo

SE PUEDE CORTAR Y RETOMAR: las imágenes que ya están en el CSV se saltean.
"""
import csv
import hashlib
import json
import math
import os
import platform
import random
import re
import sys
import time
from collections import Counter
from datetime import datetime

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import facescore_ref as fs  # noqa: E402

RAIZ = os.environ.get("COLUMBIA_RAIZ", os.path.join("datasets", "ColumbiaGaze"))
MODELO = os.path.join(AQUI, "..", "biwi_yaw", "fl_v1.task")
SHA_MODELO = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"

SALIDA = os.environ.get("FACESCORE_SALIDA", os.path.join(AQUI, "salida"))
CSV = os.path.join(SALIDA, "facescore_columbia.csv")
MUESTRA = os.path.join(SALIDA, "muestra_columbia.jsonl")
RESUMEN = os.path.join(SALIDA, "facescore_columbia_extraccion.json")

N_ESPERADO = 5880            # §7
N_CANDIDATOS = 600           # §7.7
SEMILLA = 42
PATRON = re.compile(r"^(\d{4})_2m_(-?\d+)P_(-?\d+)V_(-?\d+)H\.jpg$", re.IGNORECASE)

CAMPOS = ["archivo", "sujeto", "P", "V", "H", "detectado", "mitad", "incompleto",
          "yaw_fs", "pitch_fs", "yaw_mat", "pitch_mat", "gaze_x", "gaze_y", "blink"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def euler_desde_R(R):
    """(yaw, pitch, roll) en grados. Misma convención que `extraer_facescore_biwi.py`."""
    sy = math.sqrt(R[0, 0] ** 2 + R[1, 0] ** 2)
    if sy > 1e-6:
        x = math.atan2(R[2, 1], R[2, 2])
        y = math.atan2(-R[2, 0], sy)
        z = math.atan2(R[1, 0], R[0, 0])
    else:
        x = math.atan2(-R[1, 2], R[1, 1]); y = math.atan2(-R[2, 0], sy); z = 0.0
    return math.degrees(y), math.degrees(x), math.degrees(z)


def listar():
    """[(ruta relativa, sujeto, P, V, H)] en orden. Detiene si algo no coincide con el §7."""
    imagenes, raros = [], []
    for d, _, archivos in os.walk(RAIZ):
        for a in archivos:
            if not a.lower().endswith(".jpg"):
                continue
            rel = os.path.relpath(os.path.join(d, a), RAIZ).replace(os.sep, "/")
            m = PATRON.match(a)
            if not m or rel.split("/")[0] != m.group(1):
                raros.append(rel)
                continue
            imagenes.append((rel, m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))))
    if raros or len(imagenes) != N_ESPERADO:
        raise SystemExit(f"🔴 El conjunto no es el registrado en §7: {len(imagenes)} imágenes, raros {raros[:5]}")
    return sorted(imagenes)


def cargar_imagen(ruta):
    bgr = cv2.imread(ruta, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f"🔴 No se pudo leer {ruta}")
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def nuevo_detector():
    return vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODELO),
        running_mode=vision.RunningMode.IMAGE,
        output_facial_transformation_matrixes=True, output_face_blendshapes=True, num_faces=1))


def detectar(detector, rgb):
    return detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))


def procesar(ruta, detector):
    """(fila parcial, crudo o None). La fila no trae los campos del nombre."""
    rgb = cargar_imagen(ruta)
    res, mitad = detectar(detector, rgb), 0
    if not res.face_landmarks:
        chica = cv2.resize(rgb, (rgb.shape[1] // 2, rgb.shape[0] // 2), interpolation=cv2.INTER_AREA)
        res, mitad = detectar(detector, chica), 1
    fila = dict(detectado=0, mitad=mitad, incompleto=0)
    if not res.face_landmarks:
        return fila, None
    if not (res.facial_transformation_matrixes and res.face_blendshapes):
        # El JS no registra un cuadro así (`if (!m || !bs) return;`): se cuenta aparte.
        fila.update(detectado=1, incompleto=1)
        return fila, None
    M = np.array(res.facial_transformation_matrixes[0])
    if np.abs(M[:3, 3]).max() <= np.abs(M[3, :3]).max():
        raise SystemExit("🔴 La matriz no trae la traslación en la última columna. Revisar el layout.")
    m_col = M.T.flatten().tolist()
    puntos = res.face_landmarks[0]
    lm = {i: (puntos[i].x, puntos[i].y, puntos[i].z) for i in fs.LANDMARKS_USADOS}
    bs = {c.category_name: c.score for c in res.face_blendshapes[0]}
    yaw_fs, pitch_fs = fs.angulos_cabeza(m_col, lm)
    yaw_mat, pitch_mat, _ = euler_desde_R(M[:3, :3])
    gx, gy = fs.mirada(bs)
    fila.update(detectado=1, yaw_fs=repr(yaw_fs), pitch_fs=repr(pitch_fs), yaw_mat=repr(yaw_mat),
                pitch_mat=repr(pitch_mat), gaze_x=repr(gx), gaze_y=repr(gy), blink=repr(fs.parpadeo(bs)))
    crudo = dict(m_col=m_col, lm={str(i): list(v) for i, v in lm.items()}, bs=bs)
    return fila, crudo


def main():
    if sha256(MODELO) != SHA_MODELO:
        raise SystemExit(f"🔴 {MODELO} no es el modelo fijado (SHA-256 distinto).")
    os.makedirs(SALIDA, exist_ok=True)
    imagenes = listar()
    orden_sorteo = {rel: i for i, rel in enumerate(
        random.Random(SEMILLA).sample([x[0] for x in imagenes], N_CANDIDATOS))}

    hechos = set()
    if os.path.exists(CSV):
        with open(CSV, encoding="utf-8", newline="") as f:
            hechos = {r["archivo"] for r in csv.DictReader(f)}
    nuevo = not hechos
    pendientes = [x for x in imagenes if x[0] not in hechos]
    print(f"imágenes: {len(imagenes)} · ya hechas: {len(hechos)} · pendientes: {len(pendientes)}", flush=True)

    detector = nuevo_detector()
    inicio = time.time()
    try:
        with open(CSV, "a", encoding="utf-8", newline="") as f, open(MUESTRA, "a", encoding="utf-8") as fm:
            w = csv.DictWriter(f, fieldnames=CAMPOS, restval="")
            if nuevo:
                w.writeheader()
            for i, (rel, sujeto, P, V, H) in enumerate(pendientes, 1):
                fila, crudo = procesar(os.path.join(RAIZ, rel), detector)
                fila.update(archivo=rel, sujeto=sujeto, P=P, V=V, H=H)
                if crudo is not None and rel in orden_sorteo:
                    fm.write(json.dumps(dict(archivo=rel, orden=orden_sorteo[rel], **crudo)) + "\n")
                    fm.flush()
                w.writerow(fila)
                f.flush()
                if i % 200 == 0 or i == len(pendientes):
                    t = time.time() - inicio
                    print(f"  {i}/{len(pendientes)} · {t / 60:.1f} min · faltan ~{t / i * (len(pendientes) - i) / 60:.0f} min",
                          flush=True)
    finally:
        detector.close()

    with open(CSV, encoding="utf-8", newline="") as f:
        filas = list(csv.DictReader(f))
    por_pose = {}
    for P in sorted({int(r["P"]) for r in filas}):
        sub = [r for r in filas if int(r["P"]) == P]
        por_pose[str(P)] = dict(n=len(sub), detectadas=sum(r["detectado"] == "1" for r in sub),
                                a_la_mitad=sum(r["mitad"] == "1" and r["detectado"] == "1" for r in sub))
    resumen = dict(
        preregistro="Preregistro_ColumbiaGaze.md §4, adenda §8 y §7",
        modelo=dict(archivo="fl_v1.task", sha256=SHA_MODELO, modo="IMAGE", num_faces=1),
        versiones=dict(python=platform.python_version(), mediapipe=mp.__version__,
                       opencv=cv2.__version__, numpy=np.__version__),
        imagenes=len(filas), detectadas=sum(r["detectado"] == "1" for r in filas),
        detectadas_a_la_mitad=sum(r["mitad"] == "1" and r["detectado"] == "1" for r in filas),
        incompletas=sum(r["incompleto"] == "1" for r in filas), por_pose=por_pose,
        candidatas_muestra=N_CANDIDATOS, semilla=SEMILLA,
        fecha=datetime.now().isoformat(timespec="seconds"))
    with open(RESUMEN, "w", encoding="utf-8") as f:
        json.dump(resumen, f, indent=2, ensure_ascii=False)
    print(f"\ndetectadas {resumen['detectadas']}/{resumen['imagenes']} "
          f"(a la mitad {resumen['detectadas_a_la_mitad']}, incompletas {resumen['incompletas']})")
    print("No se calculó ninguna métrica. Sigue medir_facescore_columbia.py.")


if __name__ == "__main__":
    main()
