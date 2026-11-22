import os, pandas as pd, numpy as np
rng=np.random.default_rng(7)
L=os.path.join(os.environ.get("SPARKLE_PROJECT_DIR", "./SparkleV2"), "labels", "")
def load(fn):
    d=pd.read_csv(L+fn); d.columns=[c.strip() for c in d.columns]
    d["ClipID"]=d.ClipID.astype(str).str.strip().str.replace(".avi","",regex=False)
    return d
dev=pd.concat([load("TrainLabels.csv"),load("ValidationLabels.csv")],ignore_index=True)
dev["subj"]=dev.ClipID.str[:6]; dev["b"]=(dev.Boredom>0).astype(int)

g=dev.groupby("subj").b.agg(["mean","count"])
g=g[g["count"]>=5]
print(f"sujetos con >=5 clips: {len(g)}")
print("\ntasa de aburrimiento POR SUJETO:")
print(f"  media global : {dev.b.mean():.3f}")
print(f"  desvio entre sujetos : {g['mean'].std():.3f}")
print(f"  min / p25 / mediana / p75 / max : "
      f"{g['mean'].min():.2f} / {g['mean'].quantile(.25):.2f} / {g['mean'].median():.2f} / "
      f"{g['mean'].quantile(.75):.2f} / {g['mean'].max():.2f}")
extremos = ((g['mean']<0.05)|(g['mean']>0.95)).sum()
print(f"  sujetos con etiqueta CONSTANTE (<5% o >95%): {extremos} de {len(g)} ({100*extremos/len(g):.0f}%)")

# descomposicion de varianza binomial: total = entre-sujeto + intra-sujeto
p=dev.b.mean(); var_tot=p*(1-p)
w=g["count"]/g["count"].sum()
var_entre=np.sum(w*(g["mean"]-p)**2)
var_intra=np.sum(w*g["mean"]*(1-g["mean"]))
print(f"\nDESCOMPOSICION DE VARIANZA de la etiqueta binaria")
print(f"  varianza total          : {var_tot:.4f}")
print(f"  entre sujetos           : {var_entre:.4f}  ({100*var_entre/var_tot:.1f}%)")
print(f"  dentro de cada sujeto   : {var_intra:.4f}  ({100*var_intra/var_tot:.1f}%)")

# cuanto rinde un clasificador que SOLO conoce al sujeto (oraculo de identidad)
acc_oraculo=np.sum(w*np.maximum(g["mean"],1-g["mean"]))
print(f"\nOraculo que solo sabe QUIEN es el sujeto (predice su clase mayoritaria): acc={acc_oraculo:.4f}")
print(f"Trivial global: {max(p,1-p):.4f}")
print(f"-> la identidad del sujeto sola aporta {100*(acc_oraculo-max(p,1-p)):+.1f} pts")
