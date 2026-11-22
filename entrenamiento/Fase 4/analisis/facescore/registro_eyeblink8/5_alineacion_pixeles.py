# Alineación índice de lectura de OpenCV <-> índice del .txt/.tag, sin mirar rostros:
# en un salto de tiempo del .txt la escena cambia de golpe, así que la diferencia media
# absoluta entre cuadros consecutivos (gris, 80x60) debería tener un pico en ese índice.
import cv2, glob, os, sys
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
raiz = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
for d in ["1", "2", "3", "8"]:
    avi = glob.glob(os.path.join(raiz, d, "*.avi"))[0]
    txt = glob.glob(os.path.join(raiz, d, "*.txt"))[0]
    real = [float(l.split()[1]) * 1000 for l in open(txt) if l.strip()]
    saltos = [i + 1 for i in range(len(real) - 1) if real[i + 1] - real[i] > 300]
    c = cv2.VideoCapture(avi); prev, dif, i, inicio = None, [], 0, []
    while True:
        if i < 3: inicio.append((c.get(cv2.CAP_PROP_POS_FRAMES), c.get(cv2.CAP_PROP_POS_MSEC)))
        ok, fr = c.read()
        if not ok: break
        g = cv2.resize(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY), (80, 60)).astype(np.int16)
        dif.append(0.0 if prev is None else float(np.abs(g - prev).mean())); prev = g; i += 1
    c.release()
    dif = np.array(dif); orden = np.argsort(dif)[::-1][:8]
    print(f"[{d}] leídos {len(dif)} | antes de leer (POS_FRAMES, POS_MSEC) {inicio} | saltos >300 ms en txt en índices {saltos} "
          f"(dt {[round(real[s]-real[s-1]) for s in saltos]} ms)")
    print(f"     top-8 picos de diferencia: {[(int(k), round(float(dif[k]),1)) for k in orden]} | mediana dif {np.median(dif):.2f}")
    for s in saltos:
        ventana = {k: round(float(dif[k]), 1) for k in range(max(1, s - 3), min(len(dif), s + 4))}
        print(f"     alrededor del salto {s}: {ventana}")
