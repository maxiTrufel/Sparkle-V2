"""Verificacion: la curva operativa de R1 es invariante al cambio de fuente del error.

`curva_operativa_R1.py` (2026-08-07) modela el error del yaw como Laplace(b=3,21), ajustado
sobre AFLW2000-3D. La validacion posterior contra BIWI (2026-08-13) arroja MAE = 3,19 en rango
completo; para una Laplace el parametro b coincide con la desviacion absoluta media, de modo
que b_BIWI = 3,19.

Este script recomputa la curva con ambos parametros y compara. Motivo: el proyecto no reporta
inferencias como mediciones, y "la diferencia deberia ser despreciable" era una inferencia.

RESULTADO (2026-08-22): identica en las cinco magnitudes de giro, diferencia 0,00 s. Los falsos
positivos se mantienen en 0,00000. Dos datasets independientes producen la misma escala de error
y la curva no se mueve.
"""
import numpy as np
UMBRAL, FRAC, N = 20.0, 0.30, 300

def p_fire(rng, b, f, yaw_desviado, yaw_atento=3.0, reps=20000):
    k = int(round(f*N))
    true = np.concatenate([np.full((reps, k), yaw_desviado),
                           np.full((reps, N-k), yaw_atento)], axis=1)
    med = true + rng.laplace(0, b, size=true.shape)
    return ((np.abs(med) > UMBRAL).mean(axis=1) > FRAC).mean()

def frac_minima(b, d):
    rng = np.random.default_rng(42)
    lo, hi = 0.0, 1.0
    for _ in range(24):
        mid = (lo+hi)/2
        if p_fire(rng, b, mid, d, reps=6000) < 0.5: lo = mid
        else: hi = mid
    return hi*50

print("Fraccion minima detectable (s de 50), P>=0.50")
print(f"{'giro':>6} | {'b=3,21 AFLW':>12} | {'b=3,19 BIWI':>12} | {'delta':>7}")
for d in (22,25,30,40,60):
    a, c = frac_minima(3.21, d), frac_minima(3.19, d)
    print(f"{d:>5}° | {a:>11.1f}s | {c:>11.1f}s | {c-a:>+6.2f}s")

print("\nFalsos positivos con alumno atendiendo")
for sd in (3.,5.,8.):
    fila = []
    for b in (3.21, 3.19):
        rng = np.random.default_rng(42)
        true = rng.normal(0, sd, size=(20000, N))
        med = true + rng.laplace(0, b, size=true.shape)
        fila.append(((np.abs(med) > UMBRAL).mean(axis=1) > FRAC).mean())
    print(f"  desvio {sd:.0f}° -> b=3,21: {fila[0]:.5f}   b=3,19: {fila[1]:.5f}")
