"""Control negativo: aplicar las reglas geometricas congeladas a DAiSEE.
Prediccion declarada ANTES de correr: R1 no dispara casi nunca (yaw_desviado=0,9% de cuadros,
rachas de 0,07 s). Si disparara seguido, la implementacion estaria mal."""
import sys, glob, os, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reglas_geometricas as R

BASE = os.path.join(os.environ.get("SPARKLE_PROJECT_DIR", "./SparkleV2"), "features_v2", "")
clips = {}
for split in ("Train", "Validation"):          # pool de desarrollo. El Test NO se toca.
    for p in glob.glob(BASE + split + "/*.npz"):
        cid = os.path.basename(p)[:-4]
        if cid.isdigit(): clips[cid] = p
print(f"clips en el pool de desarrollo: {len(clips)}")

f0 = np.load(next(iter(clips.values())), allow_pickle=True)
names = [str(x) for x in f0["feature_names"]]

seqs, subj, suf = {}, {}, {}
for cid, p in clips.items():
    seqs[cid] = np.load(p, allow_pickle=True)["sequence"].astype(float)
    subj[cid] = cid[:6]; suf[cid] = int(cid[6:])

# linea base de EAR por SUJETO (no por clip): es como opera el producto
ie = names.index("ear_avg")
base = {}
for s in set(subj.values()):
    v = np.concatenate([seqs[c][:, ie] for c in clips if subj[c] == s])
    v = v[np.isfinite(v)]
    base[s] = float(np.median(v)) if len(v) else np.nan
print(f"sujetos: {len(base)}")

# ---------- nivel CLIP ----------
rows = []
for cid in clips:
    r = R.evaluar(seqs[cid], names, baseline_ear=base[subj[cid]])
    r["clip"] = cid; r["subj"] = subj[cid]; rows.append(r)
df = pd.DataFrame(rows)
print("\n=== NIVEL CLIP (10 s) ===")
print(f"R1 mirada fuera  : {df.R1_mirada_fuera.mean()*100:.3f} %  ({df.R1_mirada_fuera.sum()} de {len(df)})")
print(f"R2 ojos cerrados : {df.R2_ojos_cerrados.mean()*100:.3f} %  ({df.R2_ojos_cerrados.sum()})")
print(f"alguna           : {df.alguna.mean()*100:.3f} %")
print(f"\nfrac_desviado : media={df.frac_desviado.mean():.4f}  p99={df.frac_desviado.quantile(.99):.4f}  max={df.frac_desviado.max():.4f}")
print(f"racha_seg     : media={df.racha_seg.mean():.4f}  p99={df.racha_seg.quantile(.99):.4f}  max={df.racha_seg.max():.4f}")
print(f"perclos       : media={df.perclos.mean():.4f}  p99={df.perclos.quantile(.99):.4f}  max={df.perclos.max():.4f}")

# ---------- grilla de sensibilidad de R1, declarada de antemano ----------
print("\n=== R1: grilla de sensibilidad (declarada a priori) ===")
print("yaw(deg)   %clips que disparan   frac_desviado media")
for yg in (15.0, 20.0, 25.0, 30.0):
    fire = []; fr = []
    for cid in clips:
        d, i = R.r1_mirada_fuera(seqs[cid], names, yaw_grados=yg)
        fire.append(d); fr.append(i["frac_desviado"])
    print(f"  {yg:5.0f}      {100*np.mean(fire):8.3f} %          {np.nanmean(fr):.4f}")

# ---------- nivel VENTANA (k=5, span<=7) ----------
by = {}
for cid in clips: by.setdefault(subj[cid], []).append((suf[cid], cid))
vent = []
for s, lst in by.items():
    lst.sort()
    i = 0
    while i < len(lst):
        w = [lst[i]]
        j = i + 1
        while j < len(lst) and len(w) < 5 and lst[j][0] - w[0][0] <= 6:
            w.append(lst[j]); j += 1
        if len(w) == 5:
            seq = np.concatenate([seqs[c] for _, c in w], axis=0)
            r = R.evaluar(seq, names, baseline_ear=base[s]); r["subj"] = s
            vent.append(r); i = j
        else: i += 1
V = pd.DataFrame(vent)
print(f"\n=== NIVEL VENTANA (50 s, k=5, span<=7) — {len(V)} ventanas, {V.subj.nunique()} sujetos ===")
print(f"R1 mirada fuera  : {V.R1_mirada_fuera.mean()*100:.3f} %  ({V.R1_mirada_fuera.sum()})")
print(f"R2 ojos cerrados : {V.R2_ojos_cerrados.mean()*100:.3f} %  ({V.R2_ojos_cerrados.sum()})")
print(f"alguna           : {V.alguna.mean()*100:.3f} %  ({V.alguna.sum()})")
df.to_csv("control_negativo_clips.csv", index=False); V.to_csv("control_negativo_ventanas.csv", index=False)
