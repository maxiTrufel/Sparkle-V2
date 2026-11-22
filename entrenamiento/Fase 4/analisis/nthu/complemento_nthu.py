"""Complemento de la corrida única de NTHU-DDD: lo pre-registrado que `medir_nthu.py` omitió.

Todo lo que calcula este script está **definido en el pre-registro desde el 15/09**
(`Preregistro_FaceScore.md` §5.1.5 y §5.1.7), sin grados de libertad. La versión de
`medir_nthu.py` que hizo la corrida única (`a88e3b9`) **no lo implementó, por omisión
del autor**. Se calcula el 19/09, **después de ver los primarios**, y así se declara.
No cambia ningún veredicto emitido.

  1. Diagnóstico obligatorio de N2 (§5.1.5): mediana de la línea base en los videos
     cuyos primeros 30 s tienen algún cuadro `drowsiness = 1`, contra los que no.
  2. N2 secundario (§5.1.5, habilitado por §5.2): línea base del video sin somnolencia
     (`nonsleepyCombination`) del mismo sujeto y escenario.
  3. Concentración por sujeto de cada sensibilidad (§5.1.7).
  4. Por escenario: detección, N1, N2 y F1 (§5.1.7), descriptivo.
  5. N3 y N4 extremo a extremo (§5.1.5).
  6. Ventanas disjuntas de N1 y N2, sin veredicto (§5.1.5).
  7. Evaluabilidad: sujetos por clase de cada métrica (§5.1.7, piso de 6).

Salida: `salida/nthu_complemento.json`, sólo agregados y **no versionado** (EULA).
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import medir_nthu as M  # noqa: E402  (mismas funciones y constantes que la corrida única)

R, V = M.R, M.V
SALIDA = os.path.join(M.SALIDA, "nthu_complemento.json")
out = dict(nota="Pre-registrado en §5.1.5 y §5.1.7; omitido por medir_nthu.py (a88e3b9); "
                "calculado el 19/09 después de ver los primarios. No cambia ningún veredicto.")


def linea_base(ear):
    f = ear[np.isfinite(ear)]
    return float(np.median(f[:M.N_CALIB])) if len(f) >= M.N_CALIB else None


def concentracion(marcas, sujetos):
    """Qué fracción de los positivos detectados aporta el sujeto que más aporta, y la
    sensibilidad sin ese sujeto (§5.1.7)."""
    d = pd.DataFrame(dict(s=sujetos, m=marcas))
    if d.m.sum() == 0:
        return dict(sujeto_que_mas_aporta=None, fraccion=None, sensibilidad_sin_el=None)
    top = d.groupby("s").m.sum().idxmax()
    resto = d[d.s != top]
    return dict(sujeto_que_mas_aporta=str(top), fraccion=float(d[d.s == top].m.sum() / d.m.sum()),
                sensibilidad_sin_el=float(resto.m.mean()) if len(resto) else None,
                sujetos_con_positivos=int(d.s.nunique()))


def ventanas_reglas(d6, tipo, base_de=None, paso=M.PASO):
    """Como `medir_reglas` de la corrida única, con línea base y paso elegibles."""
    pm, ps, nm, ns, e2e = [], [], [], [], []
    for video, g in d6.groupby("video", sort=True):
        g = g.sort_values("k")
        sujeto = g.sujeto.iloc[0]
        yaw, ear = g.yaw_fs.to_numpy(), g.ear_avg.to_numpy()
        head, eye = g["head"].to_numpy(), g["eye"].to_numpy()
        base = base_de(video, g) if base_de else linea_base(ear)
        for i in range(M.VENTANA - 1, len(g), paso):
            sl = slice(i - M.VENTANA + 1, i + 1)
            clase = M.clase_ventana(head[sl], eye[sl], tipo)
            if clase == "mixta":
                continue
            seq = np.column_stack([yaw[sl], ear[sl]])
            dsp, _ = (R.r1_mirada_fuera(seq, ["yaw", "ear_avg"]) if tipo == "R1"
                      else R.r2_ojos_cerrados(seq, ["yaw", "ear_avg"], baseline_ear=base))
            sin_rostro = float(np.mean(~np.isfinite(yaw[sl][-M.VENTANA_ROSTRO:])))
            if sin_rostro > M.MAX_SIN_ROSTRO:
                if clase == "positiva":
                    e2e.append((0, sujeto))
                continue
            if clase == "positiva":
                pm.append(int(bool(dsp))); ps.append(sujeto); e2e.append((int(bool(dsp)), sujeto))
            else:
                nm.append(int(bool(dsp))); ns.append(sujeto)
    return pm, ps, nm, ns, e2e


def resumen_ba(pm, ps, nm, ns):
    m = M.ba_ic(pm, ps, nm, ns)
    return dict(sensibilidad=m["sensibilidad"]["p"], especificidad=m["especificidad"]["p"], ba=m["ba"],
                ba_ic=m["ba_ic"], n_pos=len(pm), n_neg=len(nm),
                sujetos_pos=len(set(ps)), sujetos_neg=len(set(ns)),
                evaluable=len(set(ps)) >= 6 and len(set(ns)) >= 6,
                veredicto_si_fuera_primario=M.veredicto_n(m))


def main():
    df = M.cargar()
    d6 = df[df.cadencia == "6fps"].copy()

    # 1. Diagnóstico obligatorio de N2
    M.titulo("1 — Diagnóstico de la línea base de R2 (obligatorio, §5.1.5)")
    filas = []
    for video, g in d6.groupby("video"):
        g = g.sort_values("k")
        primeros = g[g.t_ms < g.t_ms.iloc[0] + 30_000]
        filas.append(dict(video=video, base=linea_base(g.ear_avg.to_numpy()),
                          somnoliento_al_inicio=bool((primeros.drowsiness == "1").any())))
    t = pd.DataFrame(filas).dropna(subset=["base"])
    diag = {str(k): dict(videos=int(len(g)), mediana_base=float(g.base.median()))
            for k, g in t.groupby("somnoliento_al_inicio")}
    out["diagnostico_linea_base"] = diag
    print(f"videos que arrancan con drowsiness = 1 en los primeros 30 s: {diag.get('True')}")
    print(f"videos que no:                                               {diag.get('False')}")

    # 2. N2 secundario con la línea base del video sin somnolencia
    M.titulo("2 — N2 secundario: línea base del nonsleepyCombination del mismo sujeto y escenario")
    bases_limpias = {}
    for video, g in d6.groupby("video"):
        s, e, sit = video.split("/")
        if sit == "nonsleepyCombination":
            bases_limpias[(s, e)] = linea_base(g.sort_values("k").ear_avg.to_numpy())

    def base_limpia(video, g):
        s, e, _ = video.split("/")
        return bases_limpias.get((s, e))

    pm, ps, nm, ns, e2e = ventanas_reglas(d6, "R2", base_de=base_limpia)
    out["N2_secundario_base_limpia"] = dict(condicionado=resumen_ba(pm, ps, nm, ns),
                                           extremo_a_extremo=resumen_ba([a for a, _ in e2e], [b for _, b in e2e], nm, ns))
    print(json.dumps(out["N2_secundario_base_limpia"], indent=1, ensure_ascii=False))

    # 3. Concentración por sujeto de las sensibilidades primarias
    M.titulo("3 — Concentración por sujeto (§5.1.7)")
    conc = {}
    for nombre, tipo in (("N1", "R1"), ("N2", "R2")):
        pm, ps, nm, ns, e2e = ventanas_reglas(d6, tipo)
        conc[f"{nombre}_condicionado"] = concentracion(pm, ps)
        conc[f"{nombre}_extremo_a_extremo"] = concentracion([a for a, _ in e2e], [b for _, b in e2e])
        out.setdefault("evaluabilidad", {})[nombre] = resumen_ba(pm, ps, nm, ns)
    out["concentracion"] = conc
    for k, v in conc.items():
        print(f"{k:<26} {v}")

    # 4. Por escenario
    M.titulo("4 — Por escenario (§5.1.7, descriptivo)")
    esc = {}
    for e, g in d6.groupby("escenario"):
        fila = dict(deteccion=float(np.isfinite(g.yaw_fs).mean()))
        for nombre, tipo in (("N1", "R1"), ("N2", "R2")):
            pm, ps, nm, ns, _ = ventanas_reglas(g, tipo)
            fila[nombre] = resumen_ba(pm, ps, nm, ns) if pm and nm else "sin ventanas de alguna clase"
        esc[e] = fila
        n1, n2 = fila["N1"], fila["N2"]
        fmt = lambda m: (m if isinstance(m, str) else
                         f"sens {m['sensibilidad']:.3f} · esp {m['especificidad']:.3f} · BA {m['ba']:.3f}")
        print(f"{e:<16} detección {fila['deteccion']:.3f} | N1 {fmt(n1)} | N2 {fmt(n2)}")
    out["por_escenario"] = esc

    # 5. N3 y N4 extremo a extremo (los positivos sin detección cuentan como no detectados)
    M.titulo("5 — N3 y N4 extremo a extremo (§5.1.5)")
    for nombre, col, lab, val in (("N3", "yaw_fs", "head", "2"), ("N4", "ear_avg", "eye", "1")):
        pm, ps = [], []
        for video, g in d6.groupby("video"):
            base = linea_base(g.sort_values("k").ear_avg.to_numpy())
            x = g[col].to_numpy()
            pos = g[lab].to_numpy() == val
            marca = (np.abs(x) > M.YAW_R1) if nombre == "N3" else (x < R.EAR_FRAC_CIERRE * (base or np.nan))
            marca = np.where(np.isfinite(x), marca, False)
            pm += list(marca[pos].astype(int)); ps += [g.sujeto.iloc[0]] * int(pos.sum())
        s = M.ic_prop(pm, len(pm), ps)
        out[f"{nombre}_extremo_a_extremo_sensibilidad"] = s
        M.mostrar(f"{nombre} sensibilidad extremo a extremo", s)

    # 6. Ventanas disjuntas, sin veredicto
    M.titulo("6 — Ventanas disjuntas de N1 y N2 (sin veredicto, §5.1.5)")
    for nombre, tipo in (("N1", "R1"), ("N2", "R2")):
        pm, ps, nm, ns, _ = ventanas_reglas(d6, tipo, paso=M.VENTANA)
        out[f"{nombre}_disjuntas"] = resumen_ba(pm, ps, nm, ns)
        m = out[f"{nombre}_disjuntas"]
        print(f"{nombre}: sens {m['sensibilidad']} · esp {m['especificidad']} · BA {m['ba']:.3f} · "
              f"n {m['n_pos']}+/{m['n_neg']}-")

    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False, default=str)
    print(f"\nguardado -> {SALIDA}")


if __name__ == "__main__":
    main()
