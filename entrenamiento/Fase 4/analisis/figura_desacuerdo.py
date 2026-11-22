"""Figura: desacuerdo de etiqueta vs. separacion temporal (DAiSEE, pool de desarrollo)."""
import os, pandas as pd, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
rng=np.random.default_rng(42)
L=os.path.join(os.environ.get("SPARKLE_PROJECT_DIR", "./SparkleV2"), "labels", "")
def load(fn):
    d=pd.read_csv(L+fn); d.columns=[c.strip() for c in d.columns]
    d["ClipID"]=d.ClipID.astype(str).str.strip().str.replace(".avi","",regex=False).str.replace(".mp4","",regex=False); return d
dev=pd.concat([load("TrainLabels.csv"),load("ValidationLabels.csv")],ignore_index=True)
dev["subj"]=dev.ClipID.str[:6]; dev["suf"]=dev.ClipID.str[6:].astype(int)
dev["b"]=(dev.Boredom>0).astype(int)
idx={s:dict(zip(g.suf,g.b)) for s,g in dev.groupby("subj")}

def dis(index,gap):
    d=t=0
    for m in index.values():
        for k,v in m.items():
            if k+gap in m: t+=1; d+=(v!=m[k+gap])
    return d/t, t

gaps=list(range(1,13)); obs=[dis(idx,g) for g in gaps]
y=[o[0] for o in obs]; n=[o[1] for o in obs]
# IC binomial aprox
err=[1.96*np.sqrt(v*(1-v)/nn) for v,nn in zip(y,n)]
nulls=[]
for _ in range(200):
    sh={}
    for s,m in idx.items():
        ks=list(m); vs=list(m.values()); rng.shuffle(vs); sh[s]=dict(zip(ks,vs))
    nulls.append(dis(sh,1)[0])
nl,nh=np.percentile(nulls,[2.5,97.5]); nm=np.mean(nulls)

fig,ax=plt.subplots(figsize=(8,4.6))
ax.axhspan(nl,nh,color="#d62728",alpha=.13)
ax.axhline(nm,color="#d62728",ls="--",lw=1.4,
           label=f"Control: etiquetas permutadas dentro de cada sujeto ({nm:.3f})")
ax.errorbar([g*10 for g in gaps],y,yerr=err,marker="o",color="#1f77b4",
            capsize=3,lw=1.8,label="Desacuerdo observado")
ax.set_xlabel("Separación temporal entre fragmentos del mismo sujeto (segundos)")
ax.set_ylabel("Fracción de pares en desacuerdo")
ax.set_title("Desacuerdo de la etiqueta entre fragmentos contiguos de un mismo sujeto\n"
             "(conjunto de desarrollo: 88 sujetos, 6.787 fragmentos)",fontsize=11)
ax.set_ylim(0.30,0.46); ax.grid(alpha=.25); ax.legend(fontsize=9,loc="lower right")
fig.tight_layout(); fig.savefig("desacuerdo_vs_separacion.png",dpi=200)
print("figura guardada. obs gap=1:",round(y[0],4)," null:",round(nm,4))
