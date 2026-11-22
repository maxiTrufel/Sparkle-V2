# ¿El .tag numera como el .txt o como la lectura de OpenCV? Sólo coordenadas anotadas.
import glob, os, sys
sys.stdout.reconfigure(encoding="utf-8")
raiz = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
for d in ["1", "2", "3", "8"]:
    tag = glob.glob(os.path.join(raiz, d, "*.tag"))[0]
    txt = glob.glob(os.path.join(raiz, d, "*.txt"))[0]
    real = [float(l.split()[1]) * 1000 for l in open(txt) if l.strip()]
    saltos = [i + 1 for i in range(len(real) - 1) if real[i + 1] - real[i] > 300]
    co, dentro = {}, False
    for ln in open(tag, encoding="utf-8", errors="replace"):
        ln = ln.strip()
        if ln == "#start": dentro = True; continue
        if dentro and ln and not ln.startswith("#"):
            f = ln.split(":")
            co[int(f[0])] = [int(x) for x in f[7:19]]      # cara (4) + comisuras de ojos (8)
    def mov(a, b):
        return None if a not in co or b not in co else sum(abs(x - y) for x, y in zip(co[a], co[b]))
    for s in saltos:
        print(f"[{d}] salto txt en {s}: movimiento de coordenadas del .tag entre pares consecutivos "
              f"{ {f'{k-1}->{k}': mov(k-1, k) for k in range(s-2, s+4)} }")
