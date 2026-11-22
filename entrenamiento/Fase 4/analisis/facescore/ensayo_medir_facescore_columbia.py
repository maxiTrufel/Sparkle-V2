"""Ensayo de `medir_facescore_columbia.py` sobre datos INVENTADOS, antes de la corrida única.

Arma un Columbia Gaze falso con los 5.880 nombres reales (56 sujetos × 105
celdas) en imágenes de 8×8 píxeles. Corre el `main()` REAL de
`extraer_facescore_columbia.py`, reemplazando sólo la carga de imagen y el
detector por uno sintético con valores conocidos:

  yaw ≈ P (± 2°) · gazeX · 40 ≈ 0,8 · (H − P) (± 1°) · 2 % con ojos cerrados ·
  1 % que sólo detecta a la mitad · 0,5 % sin rostro · 0,5 % sin matriz

Después corre `medir_facescore_columbia.py` entero. **No toca ninguna imagen real.**

Lo que tiene que dar, por construcción: fidelidad 100 %; signos +1 y coherentes;
G1 ≈ 1 (|0,2·P + 0,8·H| ≤ 18° < 25°); G2 ≈ 1; G4 con pendiente ≈ 0,8 y el IC
excluyendo 1; G5 ≈ 0.

Uso: python ensayo_medir_facescore_columbia.py <carpeta de trabajo fuera del repo>
"""
import math
import os
import random
import subprocess
import sys
from types import SimpleNamespace

import cv2
import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
AQUI = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(AQUI, "..", "..", ".."))

DESTINO = os.path.abspath(sys.argv[1])
if DESTINO.lower().startswith(REPO.lower()):
    raise SystemExit("🔴 El ensayo no escribe dentro del repositorio.")
RAIZ = os.path.join(DESTINO, "Columbia Gaze Data Set")
SALIDA = os.path.join(DESTINO, "salida")
os.environ["COLUMBIA_RAIZ"] = RAIZ
os.environ["FACESCORE_SALIDA"] = SALIDA

sys.path.insert(0, AQUI)
import extraer_facescore_columbia as ex  # noqa: E402  (lee las variables de entorno al importarse)

actual = {"rel": None, "llamadas": 0}


def armar_conjunto():
    gris = np.full((8, 8, 3), 128, np.uint8)
    for s in range(1, 57):
        carpeta = os.path.join(RAIZ, f"{s:04d}")
        os.makedirs(carpeta, exist_ok=True)
        for P in (-30, -15, 0, 15, 30):
            for V in (-10, 0, 10):
                for H in (-15, -10, -5, 0, 5, 10, 15):
                    cv2.imwrite(os.path.join(carpeta, f"{s:04d}_2m_{P}P_{V}V_{H}H.jpg"), gris)
        open(os.path.join(carpeta, "Thumbs.db"), "w").close()     # basura como en el real


def cargar_sintetica(ruta):
    actual["rel"] = os.path.relpath(ruta, RAIZ).replace(os.sep, "/")
    actual["llamadas"] = 0
    return np.full((8, 8, 3), 128, np.uint8)


class DetectorSintetico:
    def close(self):
        pass

    def detect(self, imagen):
        actual["llamadas"] += 1
        rel = actual["rel"]
        r = random.Random(rel)
        m = ex.PATRON.match(rel.split("/")[-1])
        P, V, H = int(m.group(2)), int(m.group(3)), int(m.group(4))
        vacio = SimpleNamespace(face_landmarks=[], facial_transformation_matrixes=[], face_blendshapes=[])
        suerte = r.random()
        if suerte < 0.005:
            return vacio                                          # nunca detecta
        if suerte < 0.015 and actual["llamadas"] == 1:
            return vacio                                          # detecta sólo a la mitad
        yaw = P + r.gauss(0, 2)
        pitch = r.gauss(0, 3)
        mirada = (0.8 * (H - P) + r.gauss(0, 1)) / ex.fs.GAZE_DEGREES
        mirada_v = (0.5 * V + r.gauss(0, 1)) / ex.fs.GAZE_DEGREES
        blink = 0.8 if r.random() < 0.02 else 0.1

        p = [SimpleNamespace(x=0.5, y=0.5, z=0.0) for _ in range(478)]
        p[234], p[454] = SimpleNamespace(x=0.40, y=0.5, z=0.0), SimpleNamespace(x=0.60, y=0.5, z=0.0)
        p[1] = SimpleNamespace(x=0.49 if yaw >= 0 else 0.51, y=0.5, z=0.0)      # + = nariz a la izquierda
        p[10] = SimpleNamespace(x=0.5, y=0.3, z=0.0 if pitch < 0 else 0.02)
        p[152] = SimpleNamespace(x=0.5, y=0.7, z=0.02 if pitch < 0 else 0.0)
        if r.random() < 0.005:
            return SimpleNamespace(face_landmarks=[p], facial_transformation_matrixes=[], face_blendshapes=[])

        a, b = math.radians(yaw), math.radians(pitch)
        ry = np.array([[math.cos(a), 0, math.sin(a), 0], [0, 1, 0, 0], [-math.sin(a), 0, math.cos(a), 0], [0, 0, 0, 1]])
        rx = np.array([[1, 0, 0, 0], [0, math.cos(b), -math.sin(b), 0], [0, math.sin(b), math.cos(b), 0], [0, 0, 0, 1]])
        M = ry @ rx
        M[:3, 3] = [0.5, -1.0, -60.0]          # traslación en la última columna, como MediaPipe
        g, gv = mirada, mirada_v
        cats = dict(eyeLookInLeft=max(g, 0), eyeLookOutRight=max(g, 0), eyeLookOutLeft=max(-g, 0),
                    eyeLookInRight=max(-g, 0), eyeLookUpLeft=max(gv, 0), eyeLookUpRight=max(gv, 0),
                    eyeLookDownLeft=max(-gv, 0), eyeLookDownRight=max(-gv, 0),
                    eyeBlinkLeft=blink, eyeBlinkRight=blink, jawOpen=r.random() * 0.1)
        return SimpleNamespace(face_landmarks=[p], facial_transformation_matrixes=[M],
                               face_blendshapes=[[SimpleNamespace(category_name=k, score=float(v))
                                                  for k, v in cats.items()]])


def main():
    armar_conjunto()
    ex.cargar_imagen = cargar_sintetica
    ex.nuevo_detector = DetectorSintetico
    ex.main()
    r = subprocess.run([sys.executable, os.path.join(AQUI, "medir_facescore_columbia.py")],
                       env=dict(os.environ, COLUMBIA_ENSAYO="1"))
    raise SystemExit(r.returncode)


if __name__ == "__main__":
    main()
