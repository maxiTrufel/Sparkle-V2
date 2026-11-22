"""F2 y F3 de NTHU-DDD, pre-registrados en `Preregistro_FaceScore.md` §5.1.6 y omitidos.

La versión de `medir_nthu.py` de la corrida única (`a88e3b9`) imprimió las causas de
«fuera» sumadas, no **por clase de cuadro** como pide F2, y no calculó F3. Se
calculan el 19/09, **después de ver los primarios**, por omisión del autor. Están
definidos desde el 15/09 y **no cambian ningún veredicto**.

  F2 · descriptivo: fracción de cuadros «fuera» por clase —`head = 2`, `head = 1`,
       `eye = 1`, reposo (`head = 0` y `eye = 0`)— con la causa atribuida en el
       orden de §4.3 punto 7 (sin rostro, ojos, lateral, vertical).
  F3 · exploratorio declarado, sin veredicto: F1 con **cabeza sola** (sin mirada ni
       cierre ocular). Se recalcula desde las columnas del CSV con la misma regla que
       `PuntajeCara` con blendshapes vacíos: sin rostro cuenta como fuera; sin matriz
       no se registra; dentro si |yaw| ≤ 25 y −20 ≤ pitch ≤ 25; valor = % dentro en
       los últimos 10 s, con un mínimo de 30 muestras.

Salida: `salida/nthu_f2_f3.json`, sólo agregados, **no versionado** (EULA).
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import medir_nthu as M  # noqa: E402

fs = M.fs
out = dict(nota="F2 y F3 pre-registrados en §5.1.6; omitidos por medir_nthu.py (a88e3b9); "
                "calculados el 19/09 después de ver los primarios. No cambian ningún veredicto.")


def main():
    d = M.cargar()
    d = d[d.cadencia == "6fps"].copy()

    # ---- F2 ----------------------------------------------------------------
    M.titulo("F2 — fracción de cuadros «fuera» por clase de cuadro, con su causa")
    clases = {
        "looking_aside (head=2)": d["head"] == "2",
        "nodding (head=1)": d["head"] == "1",
        "sleepy_eyes (eye=1)": d["eye"] == "1",
        "reposo (head=0 y eye=0)": (d["head"] == "0") & (d["eye"] == "0"),
    }
    f2 = {}
    for nombre, sel in clases.items():
        g = d[sel & (d.causa != "omitido")]
        fuera = g.causa != ""
        causas = g[fuera].causa.value_counts(normalize=True).round(4).to_dict()
        f2[nombre] = dict(muestras=int(len(g)), fuera=float(fuera.mean()),
                          causa_de_las_fuera=causas, sujetos=int(g.sujeto.nunique()))
        print(f"{nombre:<26} n={len(g):>6} · fuera {fuera.mean():.3f} · causas {causas}")
    out["F2"] = f2

    # ---- F3 ----------------------------------------------------------------
    M.titulo("F3 — F1 con CABEZA SOLA (exploratorio declarado, sin veredicto)")
    cortes = {"50": 50.0, "44_4": 400 / 9, "55_6": 500 / 9}
    datos = {c: dict(pm=[], ps=[], nm=[], ns=[]) for c in cortes}
    for video, g in d.groupby("video", sort=True):
        g = g.sort_values("k")
        sujeto = g.sujeto.iloc[0]
        t = g.t_ms.to_numpy(); ro = g.rostro.to_numpy() == 1
        yaw, pitch = g.yaw_fs.to_numpy(), g.pitch_fs.to_numpy()
        registrado = ~ro | np.isfinite(yaw)                     # sin matriz: no se registra
        dentro = ro & (np.abs(yaw) <= fs.SIDE_LIMIT) & (pitch >= fs.DOWN_LIMIT) & (pitch <= fs.UP_LIMIT)
        head, eye = g["head"].to_numpy(), g["eye"].to_numpy()
        for ini in range(0, len(g) - M.TRAMO + 1, M.TRAMO):
            fin = ini + M.TRAMO - 1
            ventana = registrado & (t > t[fin] - fs.WINDOW_MS) & (t <= t[fin])
            if ventana.sum() < fs.MIN_FRAMES:
                continue
            valor = 100.0 * dentro[ventana].sum() / ventana.sum()
            clase = M.clase_ventana(head[ini:fin + 1], eye[ini:fin + 1], "R1")
            if clase == "mixta":
                continue
            for c, corte in cortes.items():
                dd = datos[c]
                if clase == "positiva":
                    dd["pm"].append(int(valor <= corte)); dd["ps"].append(sujeto)
                else:
                    dd["nm"].append(int(valor <= corte)); dd["ns"].append(sujeto)
    out["F3"] = {}
    for c, dd in datos.items():
        m = M.ba_ic(dd["pm"], dd["ps"], dd["nm"], dd["ns"])
        out["F3"][c] = dict(sensibilidad=m["sensibilidad"]["p"], especificidad=m["especificidad"]["p"],
                            ba=m["ba"], ba_ic=m["ba_ic"], n_pos=len(dd["pm"]), n_neg=len(dd["nm"]))
        print(f"corte ≤ {c.replace('_', ','):<5} sens {m['sensibilidad']['p']:.3f} · "
              f"esp {m['especificidad']['p']:.3f} · BA {m['ba']:.3f} "
              f"[{m['ba_ic'][0]:.3f}, {m['ba_ic'][1]:.3f}] · n {len(dd['pm'])}+/{len(dd['nm'])}-")

    with open(os.path.join(M.SALIDA, "nthu_f2_f3.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print("\nguardado -> salida/nthu_f2_f3.json")


if __name__ == "__main__":
    main()
