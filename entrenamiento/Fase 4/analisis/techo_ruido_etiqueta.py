import os, pandas as pd, numpy as np
rng = np.random.default_rng(42)
L = os.path.join(os.environ.get("SPARKLE_PROJECT_DIR", "./SparkleV2"), "labels", "")

def load(fn):
    d = pd.read_csv(L+fn); d.columns=[c.strip() for c in d.columns]
    d["ClipID"]=d.ClipID.astype(str).str.strip().str.replace(".avi","",regex=False).str.replace(".mp4","",regex=False)
    return d

# PROTOCOLO: solo pool de desarrollo. El Test NO se inspecciona.
dev = pd.concat([load("TrainLabels.csv"), load("ValidationLabels.csv")], ignore_index=True)
dev["subj"]=dev.ClipID.str[:6]
dev["suf"]=dev.ClipID.str[6:].astype(int)
dev["b"]=(dev.Boredom>0).astype(int)
print(f"POOL DE DESARROLLO: {len(dev)} clips, {dev.subj.nunique()} sujetos")
print(f"Boredom binarizado: pos={dev.b.mean():.4f}  trivial={max(dev.b.mean(),1-dev.b.mean()):.4f}")

idx = {s: dict(zip(g.suf,g.b)) for s,g in dev.groupby("subj")}

def disagreement(index, gaps=range(1,13)):
    out=[]
    for gap in gaps:
        dis=tot=0
        for m in index.values():
            for k,v in m.items():
                if k+gap in m: tot+=1; dis+= (v!=m[k+gap])
        if tot>50: out.append((gap,tot,dis/tot))
    return out

obs = disagreement(idx)
print("\n=== Desacuerdo observado vs. separacion (mismo sujeto) ===")
print("gap   ~seg    n_pares   desacuerdo")
for gap,n,d in obs: print(f"{gap:3d}  {gap*10:5d}s  {n:8d}   {d:.4f}")

# NULL: permutar etiquetas DENTRO de cada sujeto (respeta la tasa base de cada uno)
nulls=[]
for it in range(200):
    sh={}
    for s,m in idx.items():
        ks=list(m.keys()); vs=list(m.values()); rng.shuffle(vs)
        sh[s]=dict(zip(ks,vs))
    nulls.append([d for _,_,d in disagreement(sh, gaps=[1])][0])
nulls=np.array(nulls)
d1 = obs[0][2]
print(f"\n=== Test de estructura temporal (gap=1) ===")
print(f"observado           : {d1:.4f}")
print(f"null intra-sujeto   : {nulls.mean():.4f}  [{np.percentile(nulls,2.5):.4f} - {np.percentile(nulls,97.5):.4f}]")
print(f"reduccion vs null   : {nulls.mean()-d1:+.4f}  ({100*(nulls.mean()-d1)/nulls.mean():+.1f}%)")

# pendiente ponderada
g=np.array([o[0] for o in obs]); d=np.array([o[2] for o in obs]); w=np.array([o[1] for o in obs],float)
A=np.vstack([np.ones_like(g,dtype=float),g]).T; W=np.diag(w/w.sum())
b=np.linalg.solve(A.T@W@A, A.T@W@d)
print(f"\nIntercepto gap->0: {b[0]:.4f}   pendiente: {b[1]:+.5f} por clip (10 s)")

def ceiling(d0):
    disc=1-2*d0
    if disc<0: return np.nan, np.nan
    p=(1-np.sqrt(disc))/2
    return p, 1-p

for name,d0 in [("gap=1 observado",d1), ("intercepto gap->0",b[0])]:
    p,c = ceiling(d0)
    print(f"{name:22s} d={d0:.4f} -> ruido p={p:.4f}  TECHO={c:.4f}")

# bootstrap por sujeto del techo
subs=list(idx.keys()); boot=[]
for _ in range(2000):
    samp=rng.choice(len(subs), len(subs), replace=True)
    dis=tot=0
    for i in samp:
        m=idx[subs[i]]
        for k,v in m.items():
            if k+1 in m: tot+=1; dis+=(v!=m[k+1])
    if tot>0:
        p,c=ceiling(dis/tot)
        if not np.isnan(c): boot.append(c)
boot=np.array(boot)
print(f"\nTECHO con IC 95% (bootstrap por sujeto, {len(boot)} rep.): "
      f"{np.median(boot):.4f} [{np.percentile(boot,2.5):.4f} - {np.percentile(boot,97.5):.4f}]")
