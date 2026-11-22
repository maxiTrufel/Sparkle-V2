"""Paso V3 de NTHU-DDD, parte 2: metadatos de cada video. NO mira ningún cuadro.

`Preregistro_FaceScore.md` §5.1.2 permite: duración, fps declarado, cantidad de
cuadros y **tiempo de cada cuadro**. Para eso hay que decodificar el contenedor,
así que se usa `grab()`, que avanza sin entregar la imagen: **ningún cuadro llega
a memoria como imagen, no se corre MediaPipe y no se calcula nada del rostro.**

Cruza la cantidad de cuadros con la longitud de la anotación (parte 1) y aplica
las reglas ya fijadas en §5.1.2: diferencia 0 o 1 alinea desde el primer cuadro;
más de 1, el video queda «anotación no alineable»; tiempos que no crecen, «tiempo
no confiable».

Uso: python 2_metadatos_video.py [carpeta] [inventario.json] [salida.json]
"""
import json
import os
import sys
import time

import cv2

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = sys.argv[1] if len(sys.argv) > 1 else os.path.join("datasets", "NTHU-DDD", "Training Dataset")
INVENTARIO = sys.argv[2] if len(sys.argv) > 2 else os.path.join(AQUI, "..", "salida", "nthu_v3_inventario.json")
SALIDA = sys.argv[3] if len(sys.argv) > 3 else os.path.join(AQUI, "..", "salida", "nthu_v3_video.json")

NOCTURNOS = ("night_noglasses", "nightglasses")   # el README dice 15 fps para estos


def main():
    with open(os.path.abspath(INVENTARIO), encoding="utf-8") as f:
        inv = json.load(f)
    videos = inv["por_video"]
    print(f"videos a revisar: {len(videos)}", flush=True)

    salida, inicio = {}, time.time()
    for i, (k, fila) in enumerate(sorted(videos.items()), 1):
        sujeto, escenario, situacion = k.split("/")
        ruta = os.path.join(RAIZ, sujeto, escenario, f"{situacion}.avi")
        cap = cv2.VideoCapture(ruta)
        fps = cap.get(cv2.CAP_PROP_FPS)
        declarados = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fourcc = int(cap.get(cv2.CAP_PROP_FOURCC)).to_bytes(4, "little").decode(errors="replace")

        n, previo, crecientes, saltos, t0, t = 0, -1.0, True, 0, None, 0.0
        while cap.grab():                      # sin retrieve: ninguna imagen se decodifica a memoria
            t = cap.get(cv2.CAP_PROP_POS_MSEC)
            if t0 is None:
                t0 = t
            if not t > previo:
                crecientes = False
            elif previo >= 0 and t - previo > 200:
                saltos += 1
            previo = t
            n += 1
        cap.release()

        # Se compara CADA tipo de anotación con los cuadros leídos. R1 usa `head`,
        # R2 usa `eye`; `mouth` no la usa ninguna métrica de este pre-registro.
        anot = fila.get("anotacion_n", {})
        difs = {t: v - n for t, v in anot.items()}
        usadas = [t for t in ("head", "eye") if t in difs]
        estado = "ok"
        if not crecientes:
            estado = "tiempo_no_confiable"
        elif not usadas or any(abs(difs[t]) > 1 for t in usadas):
            estado = "anotacion_no_alineable"
        largo = anot.get("head")
        dif = difs.get("head")

        salida[k] = dict(
            sujeto=sujeto, escenario=escenario, situacion=situacion,
            fps_declarado=round(fps, 3), fps_esperado=15 if escenario in NOCTURNOS else 30,
            cuadros_contenedor=declarados, cuadros_leidos=n, resolucion=[w, h], fourcc=fourcc,
            duracion_s=round((t - t0) / 1000, 3) if t0 is not None else None,
            tiempos_crecientes=crecientes, saltos_mayores_200ms=saltos,
            anotacion_n=largo, anotacion_n_por_tipo=anot, diferencia_por_tipo=difs,
            diferencia_anotacion_menos_cuadros=dif, estado=estado)

        if i % 25 == 0 or i == len(videos):
            tr = time.time() - inicio
            print(f"  {i}/{len(videos)} · {tr / 60:.1f} min · faltan ~{tr / i * (len(videos) - i) / 60:.0f} min",
                  flush=True)

    os.makedirs(os.path.dirname(os.path.abspath(SALIDA)), exist_ok=True)
    with open(os.path.abspath(SALIDA), "w", encoding="utf-8") as f:
        json.dump(dict(paso="V3 parte 2 — metadatos de video (§5.1.2)", raiz=RAIZ, por_video=salida), f,
                  indent=1, ensure_ascii=False)

    estados = {}
    for v in salida.values():
        estados[v["estado"]] = estados.get(v["estado"], 0) + 1
    fps_raros = [k for k, v in salida.items() if abs(v["fps_declarado"] - v["fps_esperado"]) > 0.5]
    print(f"\nestados: {estados}")
    print(f"videos con fps distinto del esperado por escenario: {len(fps_raros)} {fps_raros[:5]}")
    print(f"guardado -> {os.path.abspath(SALIDA)}")
    print("No se miró ningún cuadro. Sigue el §5.2 del pre-registro, con commit, antes de extraer.")


if __name__ == "__main__":
    main()
