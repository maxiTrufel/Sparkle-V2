import cv2, glob, os, sys
sys.stdout.reconfigure(encoding="utf-8")
raiz = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
for d in sorted(os.listdir(raiz), key=int):
    avi = glob.glob(os.path.join(raiz, d, "*.avi"))[0]
    txt = glob.glob(os.path.join(raiz, d, "*.txt"))[0]
    real = [float(l.split()[1]) * 1000 for l in open(txt) if l.strip()]
    c = cv2.VideoCapture(avi); pos = []
    while c.grab():                      # sin retrieve: no se decodifica ninguna imagen a memoria
        pos.append(c.get(cv2.CAP_PROP_POS_MSEC))
    c.release()
    n = min(len(pos), len(real))
    rel = [(real[i] - real[0]) - (pos[i] - pos[0]) for i in range(n)]
    dpos = sorted({round(b - a, 2) for a, b in zip(pos, pos[1:])})
    print(f"[{d:>2}] grabs {len(pos)} vs txt {len(real)} | POS_MSEC {pos[0]:.1f}→{pos[-1]:.1f} ms, pasos distintos {dpos[:4]}{'…' if len(dpos)>4 else ''} | "
          f"real {real[0]:.0f}→{real[-1]:.0f} ms | desfase acumulado real−POS al final {rel[-1]:.0f} ms, máx |desfase| {max(abs(x) for x in rel):.0f} ms")
