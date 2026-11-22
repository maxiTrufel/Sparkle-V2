"""Control negativo de R2 sobre DAiSEE, recomputado con la calibracion de 30 s.

MOTIVO. La Enmienda 5 reduce el periodo de calibracion de la linea base de R2 de ~3 min a
30 s. La especificidad publicada de R2 --6 ventanas de 975, 0,615 %-- se midio con la linea
base de REFERENCIA (mediana de todos los clips del sujeto). Al cambiar como se obtiene esa
linea base corresponde recomputar el control antes de reportar ambas cifras juntas.

Se espera que no cambie: `estabilidad_linea_base_R2.py` midio 1 desacuerdo en 1.208 ventanas.
Pero eso es una inferencia, y el proyecto no reporta inferencias como mediciones.

QUE HACE. Reproduce el nivel VENTANA de `control_negativo_daisee.py` con dos lineas base:
  - referencia : mediana de ear_avg sobre TODOS los clips del sujeto (la publicada)
  - 30 s       : mediana sobre los TRES primeros clips del sujeto en orden temporal
y compara ventana por ventana.

El Test oficial NO se toca: solo Train + Validation (pool de desarrollo).
"""
import sys, glob, os
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reglas_geometricas as R

AQUI = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("DAISEE_FEATURES") or os.path.join(os.environ.get("SPARKLE_PROJECT_DIR", "./SparkleV2"), "features_v2")

N_CLIPS_CALIB = 3          # 3 clips de 10 s = 30 s (Enmienda 5)

clips = {}
for split in ("Train", "Validation"):
    for p in glob.glob(os.path.join(BASE, split, "*.npz")):
        cid = os.path.basename(p)[:-4]
        if cid.isdigit():
            clips[cid] = p
print(f"clips en el pool de desarrollo: {len(clips)}")

names = [str(x) for x in np.load(next(iter(clips.values())), allow_pickle=True)["feature_names"]]
ie = names.index("ear_avg")

seqs, subj, suf = {}, {}, {}
for cid, p in clips.items():
    seqs[cid] = np.load(p, allow_pickle=True)["sequence"].astype(float)
    subj[cid] = cid[:6]
    suf[cid] = int(cid[6:])

por_suj = {}
for cid in clips:
    por_suj.setdefault(subj[cid], []).append((suf[cid], cid))
for s in por_suj:
    por_suj[s].sort()
print(f"sujetos: {len(por_suj)}")


def mediana(a):
    a = a[np.isfinite(a)]
    return float(np.median(a)) if len(a) else np.nan


base_ref, base_30 = {}, {}
for s, lst in por_suj.items():
    base_ref[s] = mediana(np.concatenate([seqs[c][:, ie] for _, c in lst]))
    base_30[s] = mediana(np.concatenate([seqs[c][:, ie] for _, c in lst[:N_CLIPS_CALIB]]))

# ---------- nivel VENTANA (k=5, span<=7) — identico a control_negativo_daisee.py ----------
filas = []
for s, lst in por_suj.items():
    if not (np.isfinite(base_ref[s]) and np.isfinite(base_30[s])):
        continue
    i = 0
    while i < len(lst):
        w = [lst[i]]
        j = i + 1
        while j < len(lst) and len(w) < 5 and lst[j][0] - w[0][0] <= 6:
            w.append(lst[j]); j += 1
        if len(w) == 5:
            seq = np.concatenate([seqs[c] for _, c in w], axis=0)
            r_ref = R.evaluar(seq, names, baseline_ear=base_ref[s])
            r_30 = R.evaluar(seq, names, baseline_ear=base_30[s])
            filas.append(dict(
                subj=s,
                R1=r_ref["R1_mirada_fuera"],
                R2_ref=r_ref["R2_ojos_cerrados"], R2_30=r_30["R2_ojos_cerrados"],
                perclos_ref=r_ref["perclos"], perclos_30=r_30["perclos"],
                alguna_ref=r_ref["alguna"], alguna_30=r_30["alguna"]))
            i = j
        else:
            i += 1

V = pd.DataFrame(filas)
n = len(V)
print(f"\n=== NIVEL VENTANA (50 s, k=5, span<=7) — {n} ventanas, {V.subj.nunique()} sujetos ===\n")

print(f"{'':<22} {'referencia':>12} {'30 s':>12}")
print(f"{'R2 ojos cerrados':<22} {V.R2_ref.sum():>7} ({V.R2_ref.mean()*100:.3f} %)"
      f" {V.R2_30.sum():>7} ({V.R2_30.mean()*100:.3f} %)")
print(f"{'alguna regla':<22} {V.alguna_ref.sum():>7} ({V.alguna_ref.mean()*100:.3f} %)"
      f" {V.alguna_30.sum():>7} ({V.alguna_30.mean()*100:.3f} %)")
print(f"{'R1 mirada fuera':<22} {V.R1.sum():>7} ({V.R1.mean()*100:.3f} %)   (no depende de la linea base)")

dis = int((V.R2_ref != V.R2_30).sum())
print(f"\n--- Desacuerdo de la decision de R2 ---")
print(f"  ventanas en que cambia el veredicto : {dis} de {n}  ({dis/max(1,n):.5f})")
if dis:
    d = V[V.R2_ref != V.R2_30]
    print(f"  sujetos afectados                   : {sorted(d.subj.unique())}")
    print(f"  direccion  ref=0 -> 30s=1 (nuevo FP): {int(((~d.R2_ref) & d.R2_30).sum())}")
    print(f"  direccion  ref=1 -> 30s=0 (se pierde): {int((d.R2_ref & (~d.R2_30)).sum())}")

print(f"\n--- Linea base por sujeto ---")
br = np.array([base_ref[s] for s in por_suj if np.isfinite(base_ref[s])])
b3 = np.array([base_30[s] for s in por_suj if np.isfinite(base_30[s])])
err = np.abs(b3 - br) / br
print(f"  error relativo de la linea base de 30 s: mediana={np.median(err):.4f}  "
      f"p90={np.percentile(err,90):.4f}  >10%={100*(err>0.10).mean():.1f} %")

V.to_csv(os.path.join(AQUI, "control_negativo_R2_calib30.csv"), index=False)
print(f"\nescrito: control_negativo_R2_calib30.csv")
