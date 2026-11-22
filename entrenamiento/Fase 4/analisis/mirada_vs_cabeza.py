"""En DAiSEE la cabeza casi no se mueve (yaw desviado 0,9 %). Pregunta: ¿los alumnos miran
fuera de la pantalla con los OJOS en vez de con la cabeza? Los blendshapes de mirada ya se
extraen y hoy no se usan en ninguna regla."""
import glob, os, numpy as np, pandas as pd
B=os.path.join(os.environ.get("SPARKLE_PROJECT_DIR", "./SparkleV2"), "features_v2", "")
fs=[p for sp in ("Train","Validation") for p in glob.glob(B+sp+"/*.npz")
    if os.path.basename(p)[:-4].isdigit()]
names=[str(x) for x in np.load(fs[0],allow_pickle=True)["feature_names"]]
rng=np.random.default_rng(0); fs=list(rng.choice(fs, min(1500,len(fs)), replace=False))
S=np.concatenate([np.load(p,allow_pickle=True)["sequence"] for p in fs],axis=0)
print(f"cuadros muestreados: {S.shape[0]}  ({len(fs)} clips)\n")
col=lambda n: S[:,names.index(n)]

# --- mirada lateral combinada: out(izq)+out(der) menos in(izq)+in(der) ---
# CORREGIDA: mirada conjugada. La version anterior media vergencia y se cancelaba.
lat = (col("eyeLookOutLeft")+col("eyeLookInRight")) - (col("eyeLookInLeft")+col("eyeLookOutRight"))
ver = (col("eyeLookDownLeft")+col("eyeLookDownRight")) - (col("eyeLookUpLeft")+col("eyeLookUpRight"))
yaw = col("yaw"); pitch = col("pitch")

print("=== Cuanto se aparta cada canal de su valor de reposo ===")
for nom, v, u in [("yaw (cabeza)",yaw,"°"),("pitch (cabeza)",pitch,"°"),
                  ("mirada lateral",lat,""),("mirada vertical",ver,"")]:
    v=v[np.isfinite(v)]; med=np.median(v); d=np.abs(v-med)
    print(f"  {nom:16s} mediana={med:+7.3f}{u}  p90|desv|={np.percentile(d,90):6.3f}  "
          f"p99={np.percentile(d,99):6.3f}  max={d.max():7.3f}")

print("\n=== Fraccion de cuadros 'apartados' segun cada canal ===")
print("  (para la mirada se usa el p95 del propio canal como corte, por ser adimensional)")
c_lat=np.nanpercentile(np.abs(lat-np.nanmedian(lat)),95)
c_ver=np.nanpercentile(np.abs(ver-np.nanmedian(ver)),95)
defs=[("cabeza |yaw|>15°",  np.abs(yaw)>15),
      ("cabeza |yaw|>20°",  np.abs(yaw)>20),
      ("mirada lateral fuerte (>p95)", np.abs(lat-np.nanmedian(lat))>c_lat),
      ("mirada vertical fuerte (>p95)", np.abs(ver-np.nanmedian(ver))>c_ver)]
for n,m in defs:
    m=m[np.isfinite(m)]; print(f"  {n:32s} {100*np.nanmean(m):6.3f} %")

print("\n=== ¿La mirada se mueve cuando la cabeza NO se mueve? ===")
quieta = np.abs(yaw) <= 10
sub = np.abs(lat-np.nanmedian(lat))[quieta]
print(f"  cuadros con cabeza casi quieta (|yaw|<=10°): {100*np.nanmean(quieta):.1f} % del total")
print(f"  de esos, con mirada lateral fuerte: {100*np.nanmean(sub>c_lat):.2f} %")
print(f"  -> {'HAY' if np.nanmean(sub>c_lat)>0.02 else 'NO hay'} desvio de mirada independiente de la cabeza")

print("\n=== Correlacion entre mirada y cabeza ===")
ok=np.isfinite(lat)&np.isfinite(yaw)
print(f"  r(mirada lateral, yaw)   = {np.corrcoef(lat[ok],yaw[ok])[0,1]:+.4f}")
ok=np.isfinite(ver)&np.isfinite(pitch)
print(f"  r(mirada vertical, pitch)= {np.corrcoef(ver[ok],pitch[ok])[0,1]:+.4f}")
print("  (|r| bajo => la mirada aporta informacion que la pose de cabeza NO tiene)")
