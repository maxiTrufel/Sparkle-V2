"""Curva operativa de R1 con la fraccion de la Enmienda 9 (0,30 -> 0,50).

Mismo modelo que `verificar_curva_R1_biwi.py` (error del yaw Laplace, b = 3,19 de BIWI; ventana de
300 cuadros; umbral de 20 grados). Se corre con FRAC = 0,30 para verificar que reproduce la Tabla 3.D
de la seccion 3.9.4, y con FRAC = 0,50, el valor nuevo.

Los segundos son sobre la ventana NOMINAL de 50 s. Si la cadencia real es ~5 cuadros por segundo, la
ventana de 300 cuadros dura ~60 s y los segundos escalan por 1,2.

RESULTADO (2026-09-27): con 0,30 reproduce la tabla 3.D exacta (20,4 / 16,8 / 15,3 / 15,1 / 15,1 s).
Con 0,50: 34,1 / 27,9 / 25,6 / 25,1 / 25,1 s. Falsos positivos simulados: 0,00000 con ambos valores.
"""
import numpy as np

UMBRAL, N, B = 20.0, 300, 3.19


def p_fire(rng, frac, f, yaw_desviado, yaw_atento=3.0, reps=6000):
    k = int(round(f * N))
    true = np.concatenate([np.full((reps, k), yaw_desviado),
                           np.full((reps, N - k), yaw_atento)], axis=1)
    med = true + rng.laplace(0, B, size=true.shape)
    return ((np.abs(med) > UMBRAL).mean(axis=1) > frac).mean()


def segundos_minimos(frac, d):
    rng = np.random.default_rng(42)
    lo, hi = 0.0, 1.0
    for _ in range(24):
        mid = (lo + hi) / 2
        if p_fire(rng, frac, mid, d) < 0.5:
            lo = mid
        else:
            hi = mid
    return hi * 50


def falsos_positivos(frac, sd):
    rng = np.random.default_rng(42)
    true = rng.normal(0, sd, size=(20000, N))
    med = true + rng.laplace(0, B, size=true.shape)
    return ((np.abs(med) > UMBRAL).mean(axis=1) > frac).mean()


if __name__ == '__main__':
    print('Segundos de desviacion necesarios sobre 50 s, P >= 0,50')
    print(f"{'giro':>6} | {'FRAC 0,30':>10} | {'FRAC 0,50':>10}")
    for d in (22, 25, 30, 40, 60):
        print(f"{d:>5}° | {segundos_minimos(0.30, d):>9.1f}s | {segundos_minimos(0.50, d):>9.1f}s")
    print('\nFalsos positivos con el alumno atendiendo')
    for sd in (3., 5., 8.):
        print(f"  desvio {sd:.0f}° -> FRAC 0,30: {falsos_positivos(0.30, sd):.5f}"
              f"   FRAC 0,50: {falsos_positivos(0.50, sd):.5f}")
