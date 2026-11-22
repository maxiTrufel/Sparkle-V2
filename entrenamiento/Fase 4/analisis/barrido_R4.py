"""Sin la calibracion de MPIIGaze no se puede fijar el umbral de R4 en grados. Pero SI se puede
ver, sobre DAiSEE, en que rango de calibracion la regla es utilizable: si dispara nunca o siempre,
ese valor de grados/unidad queda descartado antes de medir nada."""
import sys, glob, os, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reglas_geometricas as R

B=os.path.join(os.environ.get("SPARKLE_PROJECT_DIR", "./SparkleV2"), "features_v2", "")
clips={os.path.basename(p)[:-4]:p for sp in ("Train","Validation")
       for p in glob.glob(B+sp+"/*.npz") if os.path.basename(p)[:-4].isdigit()}
names=[str(x) for x in np.load(next(iter(clips.values())),allow_pickle=True)["feature_names"]]
seqs={c:np.load(p,allow_pickle=True)["sequence"].astype(float) for c,p in clips.items()}
subj={c:c[:6] for c in clips}; suf={c:int(c[6:]) for c in clips}

# linea base de mirada por SUJETO
base={}
for s in set(subj.values()):
    v=np.concatenate([R.mirada_lateral(seqs[c],names) for c in clips if subj[c]==s])
    v=v[np.isfinite(v)]; base[s]=float(np.median(v)) if len(v) else np.nan

# ventanas k=5 span<=7 (mismas de siempre)
by={}
for c in clips: by.setdefault(subj[c],[]).append((suf[c],c))
vent=[]
for s,l in by.items():
    l.sort(); i=0
    while i<len(l):
        w=[l[i]]; j=i+1
        while j<len(l) and len(w)<5 and l[j][0]-w[0][0]<=6: w.append(l[j]); j+=1
        if len(w)==5: vent.append((s,np.concatenate([seqs[c] for _,c in w],axis=0))); i=j
        else: i+=1
print(f"ventanas: {len(vent)}  sujetos: {len({s for s,_ in vent})}\n")

print("=== Barrido de calibracion: % de ventanas de DAiSEE que dispararian ===")
print("grados/unidad |  % ventanas R4   | lectura")
for g in (5,10,20,30,50,80,120,200):
    fire=[R.r4_mirada_fuera(sq,names,grados_por_unidad=g,base_lateral=base[s])[0] for s,sq in vent]
    pct=100*np.mean([f for f in fire if f is not None])
    # DAiSEE son alumnos MIRANDO LA PANTALLA: lo correcto es que NO dispare.
    # Un 0 % aca es especificidad, no inutilidad. Lo que DAiSEE no puede decir es la sensibilidad.
    if pct<0.5:   lec="especificidad OK (no dispara con alumno atento)"
    elif pct<5:   lec="dispara ocasionalmente - revisar en que sujetos"
    else:         lec="ALARMA: dispara de mas sobre alumnos atentos"
    print(f"  {g:6.0f}      |   {pct:7.3f} %      | {lec}")

print("\n=== Referencia: cuanto se aparta la mirada en unidades de blendshape ===")
d=[]
for s,sq in vent:
    lat=R.mirada_lateral(sq,names); lat=lat[np.isfinite(lat)]
    if len(lat): d.append(np.percentile(np.abs(lat-base[s]),90))
d=np.array(d)
print(f"  p90 del desvio por ventana: mediana={np.median(d):.4f}  p90={np.percentile(d,90):.4f}")
print(f"  -> para que 20 grados equivalgan a ese desvio hace falta g ~ {20/np.median(d):.0f} grados/unidad")
