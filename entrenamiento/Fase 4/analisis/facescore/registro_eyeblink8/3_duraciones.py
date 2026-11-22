import glob, os, statistics, sys
sys.stdout.reconfigure(encoding="utf-8")
raiz = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
T = dict(parp=0, int500=0, fc500=0, fc_ambos_cuadros=0, nv_y_c=0, sin_anotar=0, salto_en_parp=0, int_ms=[], fc_ms=[])
for d in sorted(os.listdir(raiz), key=int):
    tag = glob.glob(os.path.join(raiz, d, "*.tag"))[0]
    txt = glob.glob(os.path.join(raiz, d, "*.txt"))[0]
    ts = {int(a): float(b) * 1000 for a, b in (l.split() for l in open(txt) if l.strip())}
    filas, dentro = [], False
    for ln in open(tag, encoding="utf-8", errors="replace"):
        ln = ln.strip()
        if ln == "#start": dentro = True; continue
        if dentro and ln and not ln.startswith("#"): filas.append(ln.split(":"))
    anotados = {int(f[0]) for f in filas}
    sin_anotar = len(ts) - len(anotados)
    por_id = {}
    for f in filas:
        if int(f[1]) >= 0: por_id.setdefault(int(f[1]), []).append(f)
    int500 = fc500 = salto = 0; ims, fms = [], []
    for fs in por_id.values():
        cs = sorted(int(f[0]) for f in fs)
        # duración del intervalo: del primer cuadro al siguiente del último (cubre el último cuadro)
        fin = ts.get(cs[-1] + 1, ts[cs[-1]] + 33.3)
        dur = fin - ts[cs[0]]; ims.append(dur); int500 += dur >= 500
        if any(ts.get(c + 1, ts[c]) - ts[c] > 100 for c in cs[:-1]): salto += 1
        # tramo consecutivo más largo con AMBOS ojos C, en tiempo real (hasta el cuadro siguiente)
        ambos = sorted(int(f[0]) for f in fs if f[3] == "C" and f[5] == "C")
        mejor, i = 0.0, 0
        while i < len(ambos):
            j = i
            while j + 1 < len(ambos) and ambos[j + 1] == ambos[j] + 1: j += 1
            mejor = max(mejor, ts.get(ambos[j] + 1, ts[ambos[j]] + 33.3) - ts[ambos[i]]); i = j + 1
        fms.append(mejor); fc500 += mejor >= 500
    fc_c = sum(1 for f in filas if f[3] == "C" and f[5] == "C")
    nvc = sum(1 for f in filas if (f[3] == "C" or f[5] == "C") and (f[4] == "N" or f[6] == "N"))
    print(f"[{d:>2}] parp {len(por_id):>2} | intervalo ms mediana {statistics.median(ims):.0f} máx {max(ims):.0f} | intervalo≥500ms {int500} | "
          f"tramo ambos-C ms mediana {statistics.median(fms):.0f} máx {max(fms):.0f} | ambos-C≥500ms {fc500} | parp con salto>100ms adentro {salto} | "
          f"cuadros ambos-C {fc_c} | C∧NV {nvc} | cuadros sin anotar {sin_anotar}")
    T["parp"] += len(por_id); T["int500"] += int500; T["fc500"] += fc500; T["fc_ambos_cuadros"] += fc_c
    T["nv_y_c"] += nvc; T["sin_anotar"] += sin_anotar; T["salto_en_parp"] += salto; T["int_ms"] += ims; T["fc_ms"] += fms
q = lambda xs, p: sorted(xs)[int(p * (len(xs) - 1))]
print(f"TOTAL parpadeos {T['parp']} | intervalo≥500ms {T['int500']} | ambos-C≥500ms {T['fc500']} | con salto adentro {T['salto_en_parp']} | "
      f"cuadros ambos-C {T['fc_ambos_cuadros']} | C∧NV {T['nv_y_c']} | cuadros sin anotar {T['sin_anotar']}")
print(f"intervalo ms p50/p90/p99/máx {q(T['int_ms'],.5):.0f}/{q(T['int_ms'],.9):.0f}/{q(T['int_ms'],.99):.0f}/{max(T['int_ms']):.0f} | "
      f"tramo ambos-C ms p50/p90/p99/máx {q(T['fc_ms'],.5):.0f}/{q(T['fc_ms'],.9):.0f}/{q(T['fc_ms'],.99):.0f}/{max(T['fc_ms']):.0f}")
