# Primeros cuadros leídos por OpenCV: ¿el primero está duplicado o es basura del decodificador?
import cv2, glob, os, sys
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
raiz = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
for d in sorted(os.listdir(raiz), key=int):
    avi = glob.glob(os.path.join(raiz, d, "*.avi"))[0]
    c = cv2.VideoCapture(avi); gs = []
    for _ in range(6):
        ok, fr = c.read()
        if not ok: break
        gs.append(cv2.resize(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY), (80, 60)).astype(np.int16))
    c.release()
    difs = [round(float(np.abs(gs[k] - gs[k - 1]).mean()), 2) for k in range(1, len(gs))]
    iguales = [bool(np.array_equal(gs[k], gs[k - 1])) for k in range(1, len(gs))]
    print(f"[{d:>2}] dif 0->1..4->5 {difs} | idénticos {iguales} | brillo medio {[round(float(g.mean()),1) for g in gs]}")
