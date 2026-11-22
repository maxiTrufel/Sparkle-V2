"""Curva operativa de R1 a nivel VENTANA, derivada del error de yaw medido en AFLW2000.

El acuerdo por cuadro (0,9336) no es lo que le pasa al producto: R1 decide sobre una VENTANA
usando la fraccion de cuadros desviados. Este script propaga el error de medicion al nivel de
decision real."""
import numpy as np
rng = np.random.default_rng(42)

# --- Modelo del error, ajustado a lo medido en AFLW2000 (|yaw_gt| <= 45) ---
# MAE = 3.21 ; p90|err| = 7.35 . Para Laplace(b): MAE = b ; p90 = -b*ln(0.1) = 2.3026*b
b = 3.21
print("=== Ajuste de la distribucion del error ===")
print(f"  Laplace(b={b:.2f}):  MAE={b:.2f}  p90={2.3026*b:.2f}   <- observado: MAE=3.21  p90=7.35")
s = 3.21/np.sqrt(2/np.pi)
print(f"  Normal(sigma={s:.2f}): MAE=3.21  p90={1.6449*s:.2f}   <- p90 observado 7.35: NO ajusta")
print("  -> el error es de cola pesada; se usa Laplace(b=3.21)\n")

UMBRAL, FRAC, N = 20.0, 0.30, 300          # 50 s a 6 fps
def p_fire(f, yaw_desviado, yaw_atento=3.0, reps=20000):
    """P(la ventana dispara) si una fraccion f de los cuadros tiene la cabeza a `yaw_desviado`."""
    k = int(round(f*N))
    true = np.concatenate([np.full((reps, k), yaw_desviado),
                           np.full((reps, N-k), yaw_atento)], axis=1)
    med = true + rng.laplace(0, b, size=true.shape)
    return (np.abs(med) > UMBRAL).mean(axis=1).mean(), \
           ((np.abs(med) > UMBRAL).mean(axis=1) > FRAC).mean()

print("=== Curva operativa: P(R1 dispara) vs. fraccion real de la ventana mirando fuera ===")
print("fraccion  seg/50s |", "  ".join(f"{d:>5.0f}°" for d in (22,25,30,40,60)))
for f in (0.0,0.10,0.20,0.25,0.30,0.35,0.40,0.50,0.70,1.00):
    fila=[]
    for d in (22,25,30,40,60):
        _, pf = p_fire(f, d)
        fila.append(f"{pf:6.3f}")
    print(f"  {f:4.2f}    {f*50:5.1f}s |", "  ".join(fila))

print("\n=== Falsos positivos: alumno ATENDIENDO (yaw real ~ N(0, 5°)) ===")
for sd in (3.,5.,8.):
    true = rng.normal(0, sd, size=(20000, N))
    med  = true + rng.laplace(0, b, size=true.shape)
    fp = ((np.abs(med) > UMBRAL).mean(axis=1) > FRAC).mean()
    print(f"  desvio natural de la cabeza {sd:.0f}° -> P(falso positivo) = {fp:.5f}")

print("\n=== Fraccion minima detectable (P>=0.50) por magnitud de giro ===")
for d in (22,25,30,40,60):
    lo,hi=0.0,1.0
    for _ in range(24):
        mid=(lo+hi)/2
        if p_fire(mid,d,reps=6000)[1] < 0.5: lo=mid
        else: hi=mid
    print(f"  giro de {d:>2.0f}° -> hace falta {hi*100:5.1f} % de la ventana ({hi*50:4.1f} s de 50)")
