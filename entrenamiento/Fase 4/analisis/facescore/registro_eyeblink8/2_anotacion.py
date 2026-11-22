import glob, os, statistics
raiz = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
tot = dict(cuadros=0, parp=0, ambos=0, alguno=0)
for d in sorted(os.listdir(raiz), key=int):
    tag = glob.glob(os.path.join(raiz, d, "*.tag"))[0]
    txt = glob.glob(os.path.join(raiz, d, "*.txt"))[0]
    enc, filas, dentro = {}, [], False
    for ln in open(tag, encoding="utf-8", errors="replace"):
        ln = ln.strip()
        if ln == "#start": dentro = True; continue
        if not dentro:
            if ln.startswith("#") and ":" in ln and not ln.startswith("#eye"):
                k, v = ln[1:].split(":", 1); enc[k.strip()] = v.strip()
            continue
        if ln and not ln.startswith("#"):
            filas.append(ln.split(":"))
    ncampos = sorted({len(f) for f in filas})
    ids = {}
    for f in filas:
        b = int(f[1])
        if b >= 0: ids.setdefault(b, []).append(f)
    ambos = sum(1 for fs in ids.values() if any(f[3] == "C" and f[5] == "C" for f in fs))
    alguno = sum(1 for fs in ids.values() if any(f[3] == "C" or f[5] == "C" for f in fs))
    nf = sum(1 for f in filas if f[2] != "X"); nv = sum(1 for f in filas if f[4] != "X" or f[6] != "X")
    valores = {i: sorted({f[i] for f in filas}) for i in range(2, 7)}
    durs = [len(fs) for fs in ids.values()]
    cuadros = [int(f[0]) for f in filas]
    consecutivo = cuadros == list(range(cuadros[0], cuadros[0] + len(cuadros)))
    ts = [float(l.split()[1]) for l in open(txt) if l.strip()]
    dts = [b - a for a, b in zip(ts, ts[1:])]
    print(f"[{d}] enc={enc} | campos={ncampos} | valores col2-6={valores}")
    print(f"     cuadros anotados {len(filas)} (desde {cuadros[0]} hasta {cuadros[-1]}, consecutivos={consecutivo}) | txt {len(ts)} tiempos, "
          f"{ts[0]:.3f}-{ts[-1]:.3f} s, dt mediana {statistics.median(dts)*1000:.1f} ms, fps real ~{(len(ts)-1)/(ts[-1]-ts[0]):.2f}, "
          f"dt max {max(dts)*1000:.0f} ms, dt<=0: {sum(1 for x in dts if x <= 0)}")
    print(f"     parpadeos {len(ids)} | con cierre total AMBOS ojos {ambos} | con cierre total en ALGUN ojo {alguno} | "
          f"duración en cuadros mín/mediana/máx {min(durs)}/{statistics.median(durs)}/{max(durs)} | cuadros NF {nf} | cuadros NV {nv}")
    tot["cuadros"] += len(filas); tot["parp"] += len(ids); tot["ambos"] += ambos; tot["alguno"] += alguno
print("TOTAL", tot)
