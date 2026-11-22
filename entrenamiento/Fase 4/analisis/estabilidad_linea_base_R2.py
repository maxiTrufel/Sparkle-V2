"""R2 usa una linea base propia del sujeto (mediana de ear_avg). El producto la estima con los
primeros ~3 min de sesion. ¿Alcanza? Se mide sobre DAiSEE (pool de desarrollo)."""
import glob, os, numpy as np, pandas as pd
BASE=os.path.join(os.environ.get("SPARKLE_PROJECT_DIR", "./SparkleV2"), "features_v2", "")
clips={}
for sp in ("Train","Validation"):
    for p in glob.glob(BASE+sp+"/*.npz"):
        c=os.path.basename(p)[:-4]
        if c.isdigit(): clips[c]=p
names=[str(x) for x in np.load(next(iter(clips.values())),allow_pickle=True)["feature_names"]]
ie=names.index("ear_avg")

por_suj={}
for c,p in clips.items():
    por_suj.setdefault(c[:6],[]).append((int(c[6:]), np.load(p,allow_pickle=True)["sequence"][:,ie]))
for s in por_suj: por_suj[s].sort(key=lambda t:t[0])
sujetos={s:v for s,v in por_suj.items() if len(v)>=20}
print(f"sujetos con >=20 clips consecutivos: {len(sujetos)}  (de {len(por_suj)})")

def med(a):
    a=a[np.isfinite(a)]; return np.median(a) if len(a) else np.nan

print("\n=== Error relativo de la linea base segun cuanto se observa ===")
print(" clips  segundos |  err.rel mediano   p90     % sujetos con err>10%")
filas=[]
for n in (1,2,3,6,12,18,30):
    errs=[]
    for s,v in sujetos.items():
        if len(v)<max(n+5,20): continue
        b_n   = med(np.concatenate([x for _,x in v[:n]]))
        b_ref = med(np.concatenate([x for _,x in v]))
        if np.isfinite(b_n) and np.isfinite(b_ref) and b_ref>0:
            errs.append(abs(b_n-b_ref)/b_ref)
    e=np.array(errs)
    filas.append((n,np.median(e),np.percentile(e,90),(e>0.10).mean()))
    print(f"  {n:3d}   {n*10:5d}s  |     {np.median(e):.4f}      {np.percentile(e,90):.4f}      {100*(e>0.10).mean():5.1f} %")

print("\n=== Impacto en la DECISION de R2 (PERCLOS > 0,15) ===")
print("Se recalcula PERCLOS con linea base de n clips vs. la de referencia, sobre ventanas de 50 s.")
print(" clips  segundos | ventanas | desacuerdo de la decision")
for n in (1,3,6,12,18):
    dis=tot=0
    for s,v in sujetos.items():
        if len(v)<max(n+10,20): continue
        b_n=med(np.concatenate([x for _,x in v[:n]])); b_ref=med(np.concatenate([x for _,x in v]))
        if not (np.isfinite(b_n) and np.isfinite(b_ref) and b_n>0 and b_ref>0): continue
        for i in range(0,len(v)-4,5):
            seq=np.concatenate([x for _,x in v[i:i+5]]); ok=np.isfinite(seq)
            if ok.sum()==0: continue
            p_n  =(seq[ok]<0.30*b_n  ).mean()>0.15
            p_ref=(seq[ok]<0.30*b_ref).mean()>0.15
            tot+=1; dis+= (p_n!=p_ref)
    print(f"  {n:3d}   {n*10:5d}s  | {tot:8d} | {dis/max(1,tot):.5f}  ({dis})")

print("\n=== Variabilidad de la linea base ENTRE sujetos (justifica normalizar) ===")
bs=np.array([med(np.concatenate([x for _,x in v])) for v in sujetos.values()])
bs=bs[np.isfinite(bs)]
print(f"  ear_avg mediano por sujeto: min={bs.min():.3f}  p25={np.percentile(bs,25):.3f} "
      f"mediana={np.median(bs):.3f}  p75={np.percentile(bs,75):.3f}  max={bs.max():.3f}")
print(f"  razon max/min = {bs.max()/bs.min():.2f}x  ->  un umbral FIJO de EAR seria "
      f"{'inviable' if bs.max()/bs.min()>1.5 else 'discutible'}")
