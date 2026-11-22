"""Ensayo de `medir_eyeblink8.py` sobre datos INVENTADOS, antes de la corrida única.

Arma un Eyeblink8 falso —8 videos chicos con `.avi`, `.txt` y `.tag`— con
parpadeos cortos, ambiguos y largos, un salto de tiempo, cuadros con ojo no
visible, cuadros sin rostro y cuadros con rostro pero sin matriz. Lo extrae con
el `procesar()` REAL de `extraer_eyeblink8.py`, reemplazando sólo el detector por
uno sintético que devuelve resultados con la forma de MediaPipe. Después corre
`medir_eyeblink8.py` entero. **No toca ningún dato de Eyeblink8.**

Lo que tiene que dar, por construcción: fidelidad 100 %; grupos iguales a los
inventados; K1 corto y ambiguo 0 %; K2 ≈ 1; K3 ≈ 0; K4 sensibilidad ≈ 1 y falsa
marca ≈ 0.

K1 largo NO tiene por qué dar 100 %. Los cierres inventados duran ~660 ms, apenas
más de 500. A 6 fps, que dispare depende de en qué momento caen las muestras
(un cierre visto primero a los 67 ms llega a 499 ms en la muestra de 566, y a la
siguiente el ojo ya se abre). Además, un cuadro sin rostro reinicia el cierre,
igual que en el producto. Primera corrida del ensayo, 15/09: 4/8 a 6 fps y 5/8 a
cadencia nativa. Se revisaron las muestras de los 8 parpadeos y todas se explican
así: no es un error de la medición.

Uso: python ensayo_medir_eyeblink8.py <carpeta de trabajo fuera del repo>
"""
import json
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
RAIZ = os.path.join(DESTINO, "eyeblink8")
SALIDA = os.path.join(DESTINO, "salida")
os.environ["EYEBLINK8_RAIZ"] = RAIZ
os.environ["FACESCORE_SALIDA"] = SALIDA

sys.path.insert(0, AQUI)
import extraer_eyeblink8 as ex  # noqa: E402  (lee las variables de entorno al importarse)

N_CUADROS = 2400          # 80 s a 30 fps
EXTRA_TXT = 49            # como el real: el .txt tiene 49 líneas más que lo que lee OpenCV
ANOTADOS_HASTA = N_CUADROS - 50
rnd = random.Random(7)

NOMBRES_BS = ["eyeBlinkLeft", "eyeBlinkRight", "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft",
              "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
              "jawOpen", "mouthSmileLeft"]


def inventar_parpadeos():
    estado, bid, k = {}, 0, 40
    plan = ["corto"] * 14 + ["ambiguo"] * 2 + ["largo"]
    rnd.shuffle(plan)
    for tipo in plan:
        k += rnd.randint(50, 90)
        if tipo == "corto":
            fases = ["parcial"] * 2 + ["cerrado"] * rnd.randint(2, 5) + ["parcial"] * 2   # ≤ 9 cuadros, < 300 ms
        elif tipo == "ambiguo":
            fases = ["parcial"] * 5 + ["cerrado"] * 5 + ["parcial"] * 6                   # 16 cuadros ≈ 533 ms
        else:
            fases = ["parcial"] * 2 + ["cerrado"] * 20 + ["parcial"] * 2                  # cierre ≈ 667 ms
        for i, f in enumerate(fases):
            estado[k + i] = dict(bid=bid, fase=f, tipo=tipo, nv=(tipo == "largo" and f == "cerrado" and i < 4))
        k += len(fases)
        bid += 1
    return estado


def escribir_video(carpeta, video, estado):
    os.makedirs(carpeta, exist_ok=True)
    nombre = f"sintetico_{video}_cam"
    # .txt: línea i = tiempo del cuadro k = i + 1. Un salto de 2 s fuera de todo parpadeo.
    salto = next(g for g in range(1200, 2000) if not any(x in estado for x in range(g - 2, g + 3)))
    t, lineas = 0.1, []
    for i in range(N_CUADROS + EXTRA_TXT):
        if i == salto:
            t += 2.0
        lineas.append(f"{i} {t:.6f}")
        t += 1 / 30 + rnd.uniform(-0.002, 0.002)
    with open(os.path.join(carpeta, nombre + ".txt"), "w") as f:
        f.write("\n".join(lineas) + "\n")
    # .tag con el formato de 19 campos.
    filas = ["#eye-blink annotation file version 1.1", "#author: ensayo", "#glasses: NO", "#challenging: NO",
             "#message start", "#message end", "#start"]
    for k in range(1, ANOTADOS_HASTA):
        e = estado.get(k)
        bid = e["bid"] if e else -1
        fc = "C" if e and e["fase"] == "cerrado" else "X"
        nv = "N" if e and e["nv"] else "X"
        filas.append(f"{k}:{bid}:X:{fc}:{nv}:{fc}:X:" + ":".join(["100"] * 12))
    with open(os.path.join(carpeta, nombre + ".tag"), "w") as f:
        f.write("\n".join(filas) + "\n")
    # .avi chico, sin contenido: el detector sintético no mira la imagen.
    w = cv2.VideoWriter(os.path.join(carpeta, nombre + ".avi"), cv2.VideoWriter_fourcc(*"MJPG"), 30, (32, 24))
    for _ in range(N_CUADROS):
        w.write(np.full((24, 32, 3), 128, np.uint8))
    w.release()
    cap, n = cv2.VideoCapture(os.path.join(carpeta, nombre + ".avi")), 0
    while cap.grab():
        n += 1
    cap.release()
    if n != N_CUADROS:
        raise SystemExit(f"🔴 el .avi sintético tiene {n} cuadros legibles, no {N_CUADROS}")
    return [float(x.split()[1]) * 1000 for x in lineas]


class DetectorSintetico:
    """Resultados con la forma de MediaPipe, decididos por la anotación inventada.
    Determinista por (video, cuadro): los dos detectores ven lo mismo."""

    def __init__(self, video, estado, ts):
        self.video, self.estado = video, estado
        self.k_de_t = {int(round(ts[k - 1])): k for k in range(1, len(ts) + 1)}

    def close(self):
        pass

    def detect_for_video(self, imagen, t_ms):
        k = self.k_de_t[t_ms]
        r = random.Random(f"{self.video}-{k}")
        vacio = SimpleNamespace(face_landmarks=[], facial_transformation_matrixes=[], face_blendshapes=[])
        if r.random() < 0.03:
            return vacio
        fase = self.estado.get(k, {}).get("fase", "abierto")
        blink = dict(abierto=0.05, parcial=0.45, cerrado=0.85)[fase] + r.uniform(-0.04, 0.04)
        ear = dict(abierto=0.30, parcial=0.18, cerrado=0.05)[fase] * r.uniform(0.95, 1.05)
        yaw = r.choice([0.0, 0.0, 0.0, r.uniform(-40, 40)])
        pitch = r.choice([0.0, 0.0, r.uniform(-30, 30)])

        p = [SimpleNamespace(x=0.5, y=0.5, z=0.0) for _ in range(478)]
        p[234], p[454] = SimpleNamespace(x=0.40, y=0.5, z=0.0), SimpleNamespace(x=0.60, y=0.5, z=0.0)
        p[1] = SimpleNamespace(x=0.49 if yaw >= 0 else 0.51, y=0.5, z=0.0)
        p[10] = SimpleNamespace(x=0.5, y=0.3, z=0.0 if pitch < 0 else 0.02)
        p[152] = SimpleNamespace(x=0.5, y=0.7, z=0.02 if pitch < 0 else 0.0)
        # Ojos: horizontal de 0,06 × 32 px; vertical tal que EAR dé `ear`.
        d = ear * (0.06 * 32) / (2 * 24)
        for ids, x0 in ((ex.RIGHT_EYE, 0.36), (ex.LEFT_EYE, 0.58)):
            p[ids[0]] = SimpleNamespace(x=x0, y=0.45, z=0.0)
            p[ids[3]] = SimpleNamespace(x=x0 + 0.06, y=0.45, z=0.0)
            for arriba, abajo, dx in ((ids[1], ids[5], 0.02), (ids[2], ids[4], 0.04)):
                p[arriba] = SimpleNamespace(x=x0 + dx, y=0.45 - d, z=0.0)
                p[abajo] = SimpleNamespace(x=x0 + dx, y=0.45 + d, z=0.0)
        if r.random() < 0.01:   # rostro sin matriz ni blendshapes: el JS no lo registra
            return SimpleNamespace(face_landmarks=[p], facial_transformation_matrixes=[], face_blendshapes=[])

        a, b = math.radians(yaw), math.radians(pitch)
        ry = np.array([[math.cos(a), 0, math.sin(a), 0], [0, 1, 0, 0], [-math.sin(a), 0, math.cos(a), 0], [0, 0, 0, 1]])
        rx = np.array([[1, 0, 0, 0], [0, math.cos(b), -math.sin(b), 0], [0, math.sin(b), math.cos(b), 0], [0, 0, 0, 1]])
        cats = []
        for nombre in NOMBRES_BS:
            s = blink + r.uniform(-0.02, 0.02) if nombre.startswith("eyeBlink") else r.uniform(0, 0.3)
            cats.append(SimpleNamespace(category_name=nombre, score=min(max(s, 0.0), 1.0)))
        return SimpleNamespace(face_landmarks=[p], facial_transformation_matrixes=[ry @ rx], face_blendshapes=[cats])


def main():
    os.makedirs(ex.DIR_MUESTRA, exist_ok=True)
    resumen = dict(ensayo=True, modelo=dict(archivo="sintético"), versiones=dict(nota="ensayo"),
                   alineacion="igual al real", grilla=dict(paso_ms=ex.PASO_6FPS), semilla=ex.SEMILLA, videos={})
    esperados = dict(corto=0, ambiguo=0, largo=0)
    for v in ex.VIDEOS:
        estado = inventar_parpadeos()
        for bid in {e["bid"] for e in estado.values()}:
            esperados[next(e["tipo"] for e in estado.values() if e["bid"] == bid)] += 1
        ts = escribir_video(os.path.join(RAIZ, v), v, estado)
        ex.nuevo_detector = lambda ensayo, v=v, estado=estado, ts=ts: DetectorSintetico(v, estado, ts)
        resumen["videos"][v] = ex.procesar(v, False)
        print(f"video sintético {v}: {resumen['videos'][v]['procesados']} cuadros · "
              f"grilla {resumen['videos'][v]['grilla_6fps']['n']}", flush=True)
    with open(ex.RESUMEN, "w", encoding="utf-8") as f:
        json.dump(resumen, f, indent=2)
    print(f"grupos inventados: {esperados}")

    r = subprocess.run([sys.executable, os.path.join(AQUI, "medir_eyeblink8.py")],
                       env=dict(os.environ, EYEBLINK8_ENSAYO="1"))
    raise SystemExit(r.returncode)


if __name__ == "__main__":
    main()
