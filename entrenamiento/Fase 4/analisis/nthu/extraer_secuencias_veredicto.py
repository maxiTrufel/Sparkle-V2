"""Segundo pase: secuencias COMPLETAS de 40 videos, para el arnés del veredicto.

`Preregistro_FaceScore.md` §5.1.3 exige verificar el veredicto con un arnés en
Node sobre **400 secuencias sintéticas y 40 videos reales**. La muestra de
fidelidad de `faceScore` son tramos de **10 s**, y el veredicto necesita **50 s**
de ventana antes de emitir nada: con esos tramos el arnés no evalúa ni un
instante. Este pase guarda los cuadros crudos de **40 videos enteros**, a 6 fps,
para que el arnés y `veredicto_ref.py` se comparen sobre datos reales.

Los 40 videos son los mismos que sortea `extraer_nthu.py` con semilla 42 antes de
extraer: no se eligen acá.

No calcula ninguna métrica y no se versiona nada (EULA).

Uso: python extraer_secuencias_veredicto.py
"""
import json
import os
import random
import sys
import time

import cv2
import mediapipe as mp
import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
sys.path.insert(0, os.path.join(AQUI, "..", "facescore"))
import facescore_ref as fs  # noqa: E402
import extraer_nthu as ex  # noqa: E402  (reusa listar(), leer(), grillas y constantes)

SALIDA = ex.SALIDA
DESTINO = os.path.join(SALIDA, "secuencias_veredicto")


def main():
    videos = dict(ex.listar())
    elegidos = random.Random(ex.SEMILLA).sample(sorted(videos), ex.N_TRAMOS)   # mismos 40
    os.makedirs(DESTINO, exist_ok=True)
    detector = ex.nuevo_detector(False)
    inicio = time.time()
    try:
        for i, clave in enumerate(sorted(elegidos), 1):
            destino = os.path.join(DESTINO, clave.replace("/", "_") + ".json")
            if os.path.exists(destino):
                continue
            cap = cv2.VideoCapture(videos[clave])
            muestras, k, previo, kg = [], -1, -1.0, 0
            while cap.grab():
                k += 1
                t = cap.get(cv2.CAP_PROP_POS_MSEC)
                if not t > previo:
                    break
                previo = t
                if t < kg * ex.CADENCIAS["6fps"] - ex.TOLERANCIA_MS:
                    continue
                kg = int((t + ex.TOLERANCIA_MS) // ex.CADENCIAS["6fps"]) + 1
                ok, cuadro = cap.retrieve()
                if not ok:
                    continue
                h, w = cuadro.shape[:2]
                res = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                               data=cv2.cvtColor(cuadro, cv2.COLOR_BGR2RGB)))
                rostro, lm, m_col, bs, e = ex.leer(res, w, h)
                yaw = fs.angulos_cabeza(m_col, lm)[0] if m_col is not None else None
                muestras.append(dict(k=k, t=t, rostro=rostro, m_col=m_col, bs=bs,
                                     lm={str(j): list(v) for j, v in lm.items()} if lm else None,
                                     yaw=yaw, ear=None if not np.isfinite(e) else e))
            cap.release()
            with open(destino, "w", encoding="utf-8") as f:
                json.dump(dict(id=clave, muestras=muestras), f)
            tr = time.time() - inicio
            print(f"  {i}/{len(elegidos)} · {clave} · {len(muestras)} muestras · {tr/60:.1f} min", flush=True)
    finally:
        detector.close()
    print(f"\nguardado -> {DESTINO}")


if __name__ == "__main__":
    main()
