"""¿Calibrar la banda de abstención POR ALUMNO arregla la cobertura?

Simulación sobre las predicciones OOF de Fase 3.6 (6.280 clips, 79 participantes con ventana).
No se toca el modelo: solo DÓNDE se pone la banda.

HONESTIDAD DEL PROTOCOLO
------------------------
La calibración usa las PRIMERAS ventanas de cada sujeto y se evalúa sobre las RESTANTES.
Es lo que haría el producto (calibrar en los primeros minutos) y evita la fuga de calibrar
y evaluar sobre lo mismo.
"""
import os
import numpy as np

Z = np.load(os.path.join(os.environ.get("SPARKLE_PROJECT_DIR", "./SparkleV2"), "fase3_6_camino70", "oof_ensemble.npz"),
            allow_pickle=True)
p, y, ids = Z["p_ens"], Z["y"], Z["ids"]
subj = np.array([i[:6] for i in ids]); suf = np.array([int(i[6:]) for i in ids])
print(f"clips OOF: {len(p)}  participantes: {len(set(subj))}")

# --- ventanas k=5, span<=7 (misma regla congelada de Fase 3) ---
V = []                                    # (sujeto, suf_inicial, p_ventana, y_ventana)
for s in sorted(set(subj)):
    m = subj == s
    orden = np.argsort(suf[m]); ss, pp, yy = suf[m][orden], p[m][orden], y[m][orden]
    i = 0
    while i < len(ss):
        j, k = i + 1, [i]
        while j < len(ss) and len(k) < 5 and ss[j] - ss[i] <= 6:
            k.append(j); j += 1
        if len(k) == 5:
            V.append((s, ss[i], pp[k].mean(), int(yy[k].mean() > 0.5))); i = j
        else: i += 1
V = sorted(V, key=lambda t: (t[0], t[1]))
sv = np.array([v[0] for v in V]); pv = np.array([v[2] for v in V]); yv = np.array([v[3] for v in V])
print(f"ventanas: {len(pv)}  sujetos con ventana: {len(set(sv))}\n")

MARGEN_GLOBAL = 0.0839
N_CAL = 3                                  # ventanas de calibración (~2,5 min de clase)

def metricas(mask_cub, yy, pp):
    if mask_cub.sum() == 0: return dict(cob=0.0, acc=np.nan, bal=np.nan, n=0)
    pred = (pp[mask_cub] > 0.5).astype(int); real = yy[mask_cub]
    acc = (pred == real).mean()
    bal = np.mean([ (pred[real==c]==c).mean() for c in (0,1) if (real==c).sum() ])
    return dict(cob=mask_cub.mean(), acc=acc, bal=bal, n=int(mask_cub.sum()))

glob_cub, ind_cub, ev_y, ev_p, ev_s, cob_por_suj = [], [], [], [], [], {}
for s in sorted(set(sv)):
    m = sv == s
    if m.sum() < N_CAL + 3: continue        # hace falta calibración + algo que evaluar
    ps, ys = pv[m], yv[m]
    cal, ev = ps[:N_CAL], np.arange(N_CAL, len(ps))
    margen_ind = np.percentile(np.abs(cal - 0.5), 40)     # mismo criterio, datos propios
    d = np.abs(ps[ev] - 0.5)
    glob_cub.append(d > MARGEN_GLOBAL); ind_cub.append(d > margen_ind)
    ev_y.append(ys[ev]); ev_p.append(ps[ev]); ev_s.append(np.repeat(s, len(ev)))
    cob_por_suj[s] = ((d > MARGEN_GLOBAL).mean(), (d > margen_ind).mean())

G = np.concatenate(glob_cub); I = np.concatenate(ind_cub)
Y = np.concatenate(ev_y); P = np.concatenate(ev_p); S = np.concatenate(ev_s)
print(f"ventanas de evaluación: {len(Y)}  sujetos: {len(set(S))}  "
      f"(calibración: {N_CAL} ventanas por sujeto)\n")

print("="*70)
for nom, mask in (("MARGEN GLOBAL (lo desplegado)", G), ("MARGEN POR SUJETO", I)):
    r = metricas(mask, Y, P)
    print(f"{nom:32s} cobertura {r['cob']:.4f} | acc {r['acc']:.4f} | "
          f"balacc {r['bal']:.4f} | n {r['n']}")
print("="*70)

print("\n=== LO QUE MÁS IMPORTA: dispersión de la cobertura ENTRE alumnos ===")
cg = np.array([v[0] for v in cob_por_suj.values()]); ci = np.array([v[1] for v in cob_por_suj.values()])
for nom, c in (("global", cg), ("por sujeto", ci)):
    print(f"  {nom:11s} mediana {np.median(c):.3f} | desvío {c.std():.3f} | "
          f"min {c.min():.3f} | max {c.max():.3f} | "
          f"alumnos con cobertura <0,30: {(c<0.30).sum()}/{len(c)}")

print("\n=== Bootstrap pareado por sujeto (2.000 rep., semilla 42) ===")
rng = np.random.default_rng(42); sujs = np.array(sorted(set(S)))
dif_cob, dif_acc = [], []
for _ in range(2000):
    sel = rng.choice(sujs, len(sujs), replace=True)
    idx = np.concatenate([np.flatnonzero(S == q) for q in sel])
    dif_cob.append(I[idx].mean() - G[idx].mean())
    a_g, a_i = metricas(G[idx], Y[idx], P[idx])["acc"], metricas(I[idx], Y[idx], P[idx])["acc"]
    dif_acc.append(a_i - a_g)
for nom, d in (("Δ cobertura", dif_cob), ("Δ accuracy ", dif_acc)):
    d = np.array(d); lo, hi = np.percentile(d, [2.5, 97.5])
    cruza = "SÍ cruza 0" if lo <= 0 <= hi else "NO cruza 0"
    print(f"  {nom}: {np.median(d):+.4f}  IC 95% [{lo:+.4f} - {hi:+.4f}]  {cruza}")


# ---------------------------------------------------------------------------
# DIAGNÓSTICO POSTERIOR (no estaba declarado antes de la primera corrida).
# La corrida con N_CAL=3 no homogeneizó la cobertura. La pregunta es si eso se
# debe al método o a que 3 ventanas son muy pocas para estimar un percentil.
# Se reporta la CURVA COMPLETA, no el mejor punto.
# ---------------------------------------------------------------------------
print("\n" + "="*70)
print("DIAGNÓSTICO: ¿cuántas ventanas de calibración hacen falta?")
print("(post-hoc — se reporta la curva entera)")
print("="*70)
print(" n_cal  ventanas/suj  sujetos  cobertura  desvío-entre-sujetos  acc")
for ncal in (2, 3, 4, 6, 8):
    gc, ic, ey, ep, es, cps = [], [], [], [], [], []
    for s in sorted(set(sv)):
        m = sv == s
        if m.sum() < ncal + 3: continue
        ps, ys = pv[m], yv[m]
        ev = np.arange(ncal, len(ps))
        mi = np.percentile(np.abs(ps[:ncal] - 0.5), 40)
        d = np.abs(ps[ev] - 0.5)
        ic.append(d > mi); ey.append(ys[ev]); ep.append(ps[ev]); cps.append((d > mi).mean())
    if not ic: continue
    I2 = np.concatenate(ic); Y2 = np.concatenate(ey); P2 = np.concatenate(ep)
    cps = np.array(cps)
    r = metricas(I2, Y2, P2)
    print(f"  {ncal:3d}    {np.mean([ (sv==s).sum() for s in set(sv)]):6.1f}      "
          f"{len(cps):5d}     {r['cob']:.4f}         {cps.std():.4f}        {r['acc']:.4f}")

print("\nReferencia con margen global sobre las mismas ventanas:")
print(f"  cobertura {G.mean():.4f}  desvío-entre-sujetos {cg.std():.4f}  acc {metricas(G,Y,P)['acc']:.4f}")
print(f"\nVentanas por sujeto en DAiSEE: mediana "
      f"{int(np.median([ (sv==s).sum() for s in set(sv)]))}  "
      f"-> hay poco margen para calibrar Y evaluar sobre el mismo sujeto.")
