"""Extracción de NTHU-DDD (Training set) para R1, R2, `faceScore` y el veredicto.

Criterios y procedimiento: `Preregistro_FaceScore.md` §5.1, §5.2 (metadatos) y
adenda §5.3. **No calcula ninguna métrica**: eso es `medir_nthu.py`, una sola vez.

QUÉ HACE
  Recorre los 355 videos del Training set (356 menos el excluido en §5.2),
  muestrea por el TIEMPO de cada cuadro con grilla de **6 fps** (primaria) y
  **5 fps** (sensibilidad, §4.3 punto 3), corre MediaPipe sobre los cuadros que
  toca alguna de las dos grillas —un solo detector, como en EngageNet— y escribe
  un registro por muestra con:
    - la etiqueta de las cuatro anotaciones **del índice del cuadro decodificado**
      (§5.1.3: la etiqueta es la del índice, no la que tocaría por tiempo);
    - `yaw`, `pitch` y `ear_avg` como los lee el producto (mismos landmarks y
      fórmula que UTA-RLDD y `features.js`);
    - la mirada, el parpadeo y la decisión por cuadro de `faceScore`;
    - el valor temporal de `PuntajeCara` en esa muestra.

LO QUE NO HACE, A PROPÓSITO
  - No calcula R1, R2, F1, V1, V2 ni ninguna métrica.
  - No versiona nada: el EULA de NTHU-DDD prohíbe redistribuir la base y sus
    etiquetas (`.gitignore` cubre `analisis/nthu/salida/`).

SALIDAS (en salida/)
  nthu_muestras.csv          una fila por muestra y cadencia
  muestra_nthu/<video>.json  cuadros crudos de los 40 tramos de 10 s sorteados
                             con semilla 42 ANTES de extraer (fidelidad, §5.1.3)
  nthu_extraccion.json       agregados por video, versiones y SHA del modelo

SE PUEDE CORTAR Y RETOMAR: los videos ya escritos en el CSV se saltean.
ENSAYO: `--ensayo` usa un detector falso que nunca ve caras, para verificar la
grilla y la alineación de etiquetas sin correr MediaPipe. Exige FACESCORE_SALIDA.
"""
import csv
import glob
import hashlib
import json
import math
import os
import platform
import random
import re
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
FACESCORE = os.path.join(AQUI, "..", "facescore")
sys.path.insert(0, FACESCORE)
sys.path.insert(0, os.path.dirname(AQUI))
import facescore_ref as fs  # noqa: E402

RAIZ = os.environ.get("NTHU_RAIZ", os.path.join("datasets", "NTHU-DDD", "Training Dataset"))
MODELO = os.path.join(AQUI, "..", "biwi_yaw", "fl_v1.task")
SHA_MODELO = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"

SALIDA = os.environ.get("FACESCORE_SALIDA", os.path.join(AQUI, "salida"))
CSV_SALIDA = os.path.join(SALIDA, "nthu_muestras.csv")
DIR_MUESTRA = os.path.join(SALIDA, "muestra_nthu")
RESUMEN = os.path.join(SALIDA, "nthu_extraccion.json")

# §5.2: único video excluido, por tiempos no crecientes y errores de códec.
EXCLUIDOS = {"001/glasses/slowBlinkWithNodding": "tiempo_no_confiable (§5.2)"}

SITUACIONES = ("yawning", "slowBlinkWithNodding", "sleepyCombination", "nonsleepyCombination")
ESCENARIOS = ("noglasses", "glasses", "night_noglasses", "nightglasses", "sunglasses")
TIPOS = ("head", "eye", "mouth", "drowsiness")

CADENCIAS = {"6fps": 1000.0 / 6, "5fps": 200.0}      # §4.3 punto 3
TOLERANCIA_MS = 1000.0 / 60                          # media trama a 30 fps
SEMILLA = 42
N_TRAMOS = 40                                        # §5.1.3: 40 tramos de 10 s
TRAMO_MS = 10_000.0

# Mismos índices que `features.js` (y que `extraer_utarldd.py`).
RIGHT_EYE = [33, 160, 158, 133, 153, 144]
LEFT_EYE = [362, 385, 387, 263, 373, 380]

CAMPOS = ["video", "sujeto", "escenario", "situacion", "cadencia", "k", "t_ms",
          "head", "eye", "mouth", "drowsiness", "rostro", "omitido",
          "yaw_fs", "pitch_fs", "gaze_x", "gaze_y", "blink", "ear_avg", "causa", "valor"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def ear(landmarks, ids, w, h):
    """EAR sobre coordenadas de PÍXEL — port exacto de `features.js`."""
    p = [(landmarks[i].x * w, landmarks[i].y * h) for i in ids]
    horiz = math.dist(p[0], p[3])
    if horiz == 0:
        return float("nan")
    return (math.dist(p[1], p[5]) + math.dist(p[2], p[4])) / (2 * horiz)


def listar():
    """[(clave, ruta)] de los videos a extraer, en orden y sin los excluidos."""
    videos = []
    for d, _, archivos in os.walk(RAIZ):
        for a in archivos:
            if not a.lower().endswith(".avi"):
                continue
            partes = os.path.join(d, a).replace("\\", "/").split("/")
            situacion, escenario, sujeto = os.path.splitext(a)[0], partes[-2], partes[-3]
            if situacion not in SITUACIONES or escenario not in ESCENARIOS or not re.fullmatch(r"\d{3}", sujeto):
                raise SystemExit(f"🔴 archivo inesperado: {os.path.join(d, a)}")
            clave = f"{sujeto}/{escenario}/{situacion}"
            if clave not in EXCLUIDOS:
                videos.append((clave, os.path.join(d, a)))
    if len(videos) + len(EXCLUIDOS) != 356:
        raise SystemExit(f"🔴 hay {len(videos)} videos y §5.2 registró 356 menos {len(EXCLUIDOS)}")
    return sorted(videos)


def anotaciones(clave, ruta):
    sujeto, _, situacion = clave.split("/")
    carpeta = os.path.dirname(ruta)
    out = {}
    for tipo in TIPOS:
        p = os.path.join(carpeta, f"{sujeto}_{situacion}_{tipo}.txt")
        out[tipo] = open(p, encoding="utf-8", errors="replace").read().strip() if os.path.exists(p) else ""
    return out


class DetectorFalso:
    def detect(self, imagen):
        return SimpleNamespace(face_landmarks=[], facial_transformation_matrixes=[], face_blendshapes=[])

    def close(self):
        pass


def nuevo_detector(ensayo):
    if ensayo:
        return DetectorFalso()
    return vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODELO),
        output_facial_transformation_matrixes=True, output_face_blendshapes=True, num_faces=1))


def leer(res, w, h):
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


def fmt(x):
    return "" if x is None or (isinstance(x, float) and not math.isfinite(x)) else repr(x)


def procesar(clave, ruta, detector, tramos):
    sujeto, escenario, situacion = clave.split("/")
    anot = anotaciones(clave, ruta)
    cap = cv2.VideoCapture(ruta)
    estado = {c: dict(k=0, p=fs.PuntajeCara(), n=0, rostro=0, omitidos=0) for c in CADENCIAS}
    filas, crudos = [], []
    k, previo, tiempo_ok = -1, -1.0, True
    while cap.grab():
        k += 1
        t = cap.get(cv2.CAP_PROP_POS_MSEC)
        if not t > previo:
            tiempo_ok = False
            break
        previo = t
        tocan = [c for c, e in estado.items() if t >= e["k"] * CADENCIAS[c] - TOLERANCIA_MS]
        if not tocan:
            continue
        ok, cuadro = cap.retrieve()
        if not ok:
            continue
        h, w = cuadro.shape[:2]
        res = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                       data=cv2.cvtColor(cuadro, cv2.COLOR_BGR2RGB)))
        rostro, lm, m_col, bs, e = leer(res, w, h)
        yaw = pitch = gx = gy = blink = None
        if m_col is not None:
            yaw, pitch = fs.angulos_cabeza(m_col, lm)
            gx, gy = fs.mirada(bs)
            blink = fs.parpadeo(bs)
        etiqueta = {tipo: (texto[k] if k < len(texto) else "") for tipo, texto in anot.items()}

        for c in tocan:
            est = estado[c]
            est["k"] = math.floor((t + TOLERANCIA_MS) / CADENCIAS[c]) + 1
            est["n"] += 1
            est["rostro"] += int(rostro)
            causa = est["p"].registrar(t, rostro, m_col, lm, bs)
            if causa == "omitido":
                est["omitidos"] += 1
            filas.append(dict(video=clave, sujeto=sujeto, escenario=escenario, situacion=situacion,
                              cadencia=c, k=k, t_ms=repr(t), **etiqueta,
                              rostro=int(rostro), omitido=int(causa == "omitido"),
                              yaw_fs=fmt(yaw), pitch_fs=fmt(pitch), gaze_x=fmt(gx), gaze_y=fmt(gy),
                              blink=fmt(blink), ear_avg=fmt(e), causa=causa or "",
                              valor=fmt(est["p"].valor(t))))
        if "6fps" in tocan and any(ini <= t < ini + TRAMO_MS for ini in tramos):
            crudos.append(dict(k=k, t=t, rostro=rostro, m_col=m_col, bs=bs,
                               lm={str(i): list(v) for i, v in lm.items()} if lm else None))
    cap.release()
    resumen = dict(cuadros=k + 1, tiempo_ok=tiempo_ok, etiquetas={t: len(v) for t, v in anot.items()},
                   muestras={c: estado[c]["n"] for c in CADENCIAS},
                   rostro={c: estado[c]["rostro"] for c in CADENCIAS},
                   omitidos={c: estado[c]["omitidos"] for c in CADENCIAS},
                   sin_etiqueta=sum(1 for f in filas if f["head"] == ""))
    return filas, crudos, resumen


def main():
    ensayo = "--ensayo" in sys.argv
    if ensayo and os.path.abspath(SALIDA) == os.path.abspath(os.path.join(AQUI, "salida")):
        raise SystemExit("🔴 El ensayo no escribe en salida/: definí FACESCORE_SALIDA.")
    if not ensayo and sha256(MODELO) != SHA_MODELO:
        raise SystemExit("🔴 el modelo no es el fijado (SHA-256 distinto).")
    videos = listar()
    os.makedirs(DIR_MUESTRA, exist_ok=True)

    # §5.1.3: los 40 tramos se sortean POR NOMBRE DE VIDEO, antes de extraer.
    rng = random.Random(SEMILLA)
    elegidos = rng.sample([c for c, _ in videos], N_TRAMOS)
    tramos = {c: [rng.uniform(0, 30_000)] for c in elegidos}   # un tramo de 10 s por video elegido

    hechos = set()
    if os.path.exists(CSV_SALIDA):
        with open(CSV_SALIDA, encoding="utf-8", newline="") as f:
            hechos = {r["video"] for r in csv.DictReader(f)}
    pendientes = [(c, r) for c, r in videos if c not in hechos]
    print(f"videos: {len(videos)} · ya hechos: {len(hechos)} · pendientes: {len(pendientes)}", flush=True)

    detector = nuevo_detector(ensayo)
    resumen = dict(preregistro="Preregistro_FaceScore.md §5.1, §5.2 y adenda §5.3", ensayo=ensayo,
                   modelo=dict(archivo="fl_v1.task", sha256=SHA_MODELO, modo="IMAGE", num_faces=1),
                   versiones=dict(python=platform.python_version(), mediapipe=mp.__version__,
                                  opencv=cv2.__version__, numpy=np.__version__),
                   cadencias=CADENCIAS, tolerancia_ms=TOLERANCIA_MS, semilla=SEMILLA,
                   excluidos=EXCLUIDOS, tramos_fidelidad={k: v for k, v in tramos.items()}, videos={})
    if os.path.exists(RESUMEN):
        with open(RESUMEN, encoding="utf-8") as f:
            resumen["videos"] = json.load(f).get("videos", {})

    inicio = time.time()
    try:
        with open(CSV_SALIDA, "a", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=CAMPOS)
            if not hechos:
                w.writeheader()
            for i, (clave, ruta) in enumerate(pendientes, 1):
                filas, crudos, res_v = procesar(clave, ruta, detector, tramos.get(clave, []))
                w.writerows(filas)
                f.flush()
                if crudos:
                    with open(os.path.join(DIR_MUESTRA, clave.replace("/", "_") + ".json"), "w",
                              encoding="utf-8") as fm:
                        json.dump(dict(video=clave, tramos=tramos[clave], cuadros=crudos), fm)
                resumen["videos"][clave] = res_v
                with open(RESUMEN, "w", encoding="utf-8") as fr:
                    json.dump(dict(resumen, fecha=datetime.now().isoformat(timespec="seconds")), fr,
                              indent=1, ensure_ascii=False)
                if i % 10 == 0 or i == len(pendientes):
                    tr = time.time() - inicio
                    print(f"  {i}/{len(pendientes)} · {tr/60:.1f} min · faltan ~{tr/i*(len(pendientes)-i)/60:.0f} min",
                          flush=True)
    finally:
        detector.close()

    malos = [k for k, v in resumen["videos"].items() if not v["tiempo_ok"] or v["sin_etiqueta"]]
    print(f"\nvideos con tiempo no confiable o muestras sin etiqueta: {len(malos)} {malos[:5]}")
    print(f"muestras 6 fps: {sum(v['muestras']['6fps'] for v in resumen['videos'].values())}")
    print(f"guardado -> {CSV_SALIDA}")
    print("No se calculó ninguna métrica. Sigue medir_nthu.py.")


if __name__ == "__main__":
    main()
