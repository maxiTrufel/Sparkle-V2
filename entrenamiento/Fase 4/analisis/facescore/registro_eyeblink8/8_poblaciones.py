# Tamaños de las poblaciones de K1-K4 con las reglas propuestas. Sólo anotación y tiempos.
# Regla de alineación: cuadro k del .tag = lectura k de OpenCV; su tiempo real = línea k-1 del .txt.
import glob, os, sys
sys.stdout.reconfigure(encoding="utf-8")
raiz = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
T = dict(k1_corto=0, k1_ambiguo=0, k1_largo=0, sin_tiempo_parp=0, k2=0, k2_nv=0, k3=0, k3_nv=0, sin_tiempo=0, nf=0)
for d in sorted(os.listdir(raiz), key=int):
    tag = glob.glob(os.path.join(raiz, d, "*.tag"))[0]
    txt = glob.glob(os.path.join(raiz, d, "*.txt"))[0]
    lineas = [float(l.split()[1]) * 1000 for l in open(txt) if l.strip()]
    tiempo = lambda k: lineas[k - 1] if 1 <= k <= len(lineas) else None
    filas, dentro = [], False
    for ln in open(tag, encoding="utf-8", errors="replace"):
        ln = ln.strip()
        if ln == "#start": dentro = True; continue
        if dentro and ln and not ln.startswith("#"): filas.append(ln.split(":"))
    por_id = {}
    for f in filas:
        if int(f[1]) >= 0: por_id.setdefault(int(f[1]), []).append(int(f[0]))
    corto = ambiguo = largo = sin_t = 0
    fc = {int(f[0]) for f in filas if f[3] == "C" and f[5] == "C"}
    for cs in por_id.values():
        cs.sort()
        if tiempo(cs[0]) is None or tiempo(cs[-1] + 1) is None: sin_t += 1; continue
        intervalo = tiempo(cs[-1] + 1) - tiempo(cs[0])
        ambos = [c for c in cs if c in fc]; tramo, i = 0.0, 0
        while i < len(ambos):
            j = i
            while j + 1 < len(ambos) and ambos[j + 1] == ambos[j] + 1: j += 1
            tramo = max(tramo, tiempo(ambos[j] + 1) - tiempo(ambos[i])); i = j + 1
        if intervalo < 500: corto += 1
        elif tramo < 500: ambiguo += 1
        else: largo += 1
    nv = lambda f: f[4] == "N" or f[6] == "N"
    k2 = sum(1 for f in filas if f[3] == "C" and f[5] == "C" and not nv(f))
    k2nv = sum(1 for f in filas if f[3] == "C" and f[5] == "C" and nv(f))
    k3 = sum(1 for f in filas if int(f[1]) < 0 and not nv(f))
    k3nv = sum(1 for f in filas if int(f[1]) < 0 and nv(f))
    st = sum(1 for f in filas if tiempo(int(f[0])) is None)
    nf = sum(1 for f in filas if f[2] != "X")
    print(f"[{d:>2}] K1 corto {corto} · ambiguo {ambiguo} · largo {largo} · sin tiempo {sin_t} | K2 {k2} (+{k2nv} NV fuera) | "
          f"K3 {k3} (+{k3nv} NV fuera) | cuadros sin tiempo {st} | NF {nf}")
    for k, v in dict(k1_corto=corto, k1_ambiguo=ambiguo, k1_largo=largo, sin_tiempo_parp=sin_t, k2=k2, k2_nv=k2nv, k3=k3, k3_nv=k3nv, sin_tiempo=st, nf=nf).items():
        T[k] += v
print("TOTAL", T)
