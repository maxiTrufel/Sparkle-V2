"""Medición pre-registrada de la capa geométrica desplegada (`faceScore`) sobre EngageNet validación.

Criterios: `Preregistro_FaceScore.md` §4 y adenda §4.3. Se corre UNA vez.

Orden obligatorio:
  1. Fidelidad temporal: el port (`PuntajeCara`) da exactamente el mismo valor
     que `faceScore.js` original sobre los 40 clips reales de la muestra, en las
     dos variantes, y el CSV reproduce ese valor. Si no, se detiene sin medir.
  2. Etiquetas, en memoria. Nada por clip se escribe a disco.
  3. E1–E4 a 6 fps, con sus criterios. Lo mismo a 5 fps, sin veredicto.
  4. Exploratorio, marcado: E1 y E2 con la cabeza sola (sin mirada ni ojos).

Salida: sólo agregados (`facescore_engagenet_resultado.json`).
"""
import csv
import glob
import hashlib
import json
import os
import subprocess
import sys

import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import facescore_ref as fs  # noqa: E402

FACESCORE_JS = os.environ.get("FACESCORE_JS", os.path.abspath(os.path.join(
    AQUI, "..", "..", "..", "extension_medida", "frontend", "src", "offscreen", "faceScore.js")))
SHA_JS = "cab6fa04fb5375873304f739225d61cc95075ab83db6e102d628694143cfc5e2"
ETIQUETAS = os.environ.get("ENGAGENET_ETIQUETAS") or os.path.expanduser(
    os.path.join("~", "Downloads", "validation_engagement_labels.xlsx"))

# Configurable sólo para el ensayo con datos sintéticos, antes de la corrida única.
SALIDA = os.environ.get("FACESCORE_SALIDA", os.path.join(AQUI, "salida"))
CSV_CLIPS = os.path.join(SALIDA, "facescore_engagenet_clips.csv")
DIR_MUESTRA = os.path.join(SALIDA, "muestra_engagenet")
RESULTADO = os.path.join(SALIDA, "facescore_engagenet_resultado.json")

ATENTOS = {"Engaged", "Highly-Engaged"}
NO_COMPROMETIDO, APENAS = "Not-Engaged", "Barely-engaged"
ETIQUETAS_VALIDAS = ATENTOS | {NO_COMPROMETIDO, APENAS}

# Cortes del veredicto con peso 0,9 (Preregistro §4.1): marcado con el ensemble
# neutral (50), marcado sea cual sea el ensemble (400/9 = 44,4) y marcado si el
# ensemble da 0 (500/9 = 55,6).
CORTES = {"le_50": 50.0, "le_44_4": 400.0 / 9, "le_55_6": 500.0 / 9}
CAUSAS = ("sin_rostro", "ojos", "lateral", "vertical")
REPLICAS, SEMILLA = 2000, 42
rng = np.random.default_rng(SEMILLA)
res = {"preregistro": "Preregistro_FaceScore.md §4 y §4.3", "faceScore_sha256": SHA_JS}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def titulo(t):
    print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


def guardar():
    with open(RESULTADO, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2, ensure_ascii=False)


def a_float(x):
    return None if x in ("", None) else float(x)


# ---------------------------------------------------------------------------
def fidelidad(df):
    titulo("FIDELIDAD TEMPORAL — PuntajeCara contra faceScore.js original")
    if sha256(FACESCORE_JS) != SHA_JS:
        raise SystemExit("🔴 faceScore.js no es el congelado.")
    archivos = sorted(glob.glob(os.path.join(DIR_MUESTRA, "*.json")))
    clips = [json.load(open(a, encoding="utf-8")) for a in archivos]
    ruta_tmp = os.path.join(SALIDA, "_clips_equivalencia.json")
    with open(ruta_tmp, "w", encoding="utf-8") as f:
        json.dump(clips, f)
    try:
        out = subprocess.run(["node", os.path.join(AQUI, "equivalencia_clips.mjs"), FACESCORE_JS, ruta_tmp],
                             capture_output=True, text=True, check=True)
    finally:
        os.remove(ruta_tmp)
    js = json.loads(out.stdout)

    def valor_py(clip, cabeza):
        p, ultimo = fs.PuntajeCara(), None
        for c in clip["cuadros"]:
            lm = {int(k): v for k, v in c["lm"].items()} if c["lm"] else None
            bs = ({} if cabeza else c["bs"]) if c["m_col"] is not None else None
            p.registrar(c["t"], c["rostro"], c["m_col"], lm, bs)
            ultimo = c["t"]
        return p.valor(ultimo) if ultimo is not None else None

    idx = df.set_index("chunk")
    iguales = dict(completo=0, cabeza=0, csv=0)
    for i, clip in enumerate(clips):
        pc, ph = valor_py(clip, False), valor_py(clip, True)
        iguales["completo"] += int(pc == js["completo"][i])
        iguales["cabeza"] += int(ph == js["cabeza"][i])
        fila = idx.loc[clip["chunk"]]
        iguales["csv"] += int(a_float(fila["6fps_valor"]) == pc and a_float(fila["6fps_valor_cabeza"]) == ph)
    n = len(clips)
    tasas = {k: v / n for k, v in iguales.items()} if n else {}
    print(f"clips en la muestra : {n}")
    print(f"valores JS          : {sorted({round(v, 1) for v in js['completo'] if v is not None})[:12]} …")
    for k, v in tasas.items():
        print(f"coincidencia {k:<8}: {v:.4f}")
    res["fidelidad_temporal"] = dict(n=n, **tasas)
    if n < 30 or any(v != 1.0 for v in tasas.values()):
        guardar()
        raise SystemExit("🔴 La fidelidad temporal no es 100 % (o la muestra es chica). No se mide nada.")
    print("✅ 100 % en las tres.")


# ---------------------------------------------------------------------------
def tasa_ic(d, marcado):
    """Proporción agregada con IC 95 % por bootstrap clusterizado por sujeto."""
    g = d.assign(_m=marcado.astype(float)).groupby("sujeto")["_m"].agg(["sum", "count"])
    num, den = g["sum"].to_numpy(), g["count"].to_numpy()
    if den.sum() == 0:
        return dict(n=0, sujetos=0, p=None, ic=[None, None])
    i = rng.integers(0, len(num), (REPLICAS, len(num)))
    db = den[i].sum(1)
    boot = np.where(db > 0, num[i].sum(1) / np.maximum(db, 1), np.nan)
    return dict(n=int(den.sum()), sujetos=int(len(num)), marcados=int(num.sum()), p=float(num.sum() / den.sum()),
                ic=[float(np.nanpercentile(boot, 2.5)), float(np.nanpercentile(boot, 97.5))])


def diferencia_ic(d, marcado, grupo_a, grupo_b):
    """tasa(grupo_a) − tasa(grupo_b), remuestreando SUJETOS de la unión."""
    x = d.assign(_m=marcado.astype(float))
    sujetos = x.sujeto.unique()
    tabla = {s: x[x.sujeto == s] for s in sujetos}

    def tasas(sel):
        a = pd.concat([tabla[s] for s in sel])
        ga, gb = a[a.label.isin(grupo_a)], a[a.label.isin(grupo_b)]
        if len(ga) == 0 or len(gb) == 0:
            return np.nan
        return ga._m.mean() - gb._m.mean()

    punto = tasas(sujetos)
    boot = [tasas(rng.choice(sujetos, len(sujetos))) for _ in range(REPLICAS)]
    return dict(diferencia=float(punto), ic=[float(np.nanpercentile(boot, 2.5)), float(np.nanpercentile(boot, 97.5))],
                replicas_validas=int(np.sum(~np.isnan(boot))))


def veredicto_e1(p):
    return "✅ ÉXITO" if p <= 0.05 else ("🟡 zona intermedia" if p <= 0.10 else "🔴 NEGATIVO")


def mostrar(nombre, m, v=""):
    if m["p"] is None:
        print(f"{nombre:<44} sin datos"); return
    print(f"{nombre:<44} {m['p']:.4f}  IC [{m['ic'][0]:.4f}, {m['ic'][1]:.4f}]  "
          f"{m['marcados']}/{m['n']} clips · {m['sujetos']} sujetos  {v}")


def bloque(d, cad, columna_valor, con_veredicto):
    out = {}
    val = d[columna_valor]
    atentos, no_comp, apenas = d[d.label.isin(ATENTOS)], d[d.label == NO_COMPROMETIDO], d[d.label == APENAS]

    for nombre_corte, corte in CORTES.items():
        m = tasa_ic(atentos, atentos[columna_valor] <= corte)
        out[f"E1_{nombre_corte}"] = m
        es_primario = nombre_corte == "le_50"
        etiqueta = f"E1 atentos marcados (valor ≤ {corte:.1f})" + (" — PRIMARIO" if es_primario and con_veredicto else "")
        mostrar(etiqueta, m, veredicto_e1(m["p"]) if (es_primario and con_veredicto and m["p"] is not None) else "")

    marcado = val <= CORTES["le_50"]
    out["tasa_no_comprometidos"] = tasa_ic(no_comp, no_comp[columna_valor] <= CORTES["le_50"])
    mostrar("    Not-Engaged marcados (≤ 50)", out["tasa_no_comprometidos"])
    e2 = diferencia_ic(d, marcado, {NO_COMPROMETIDO}, ATENTOS)
    out["E2"] = e2
    cumple = e2["diferencia"] > 0 and e2["ic"][0] > 0
    print(f"{'E2 Not-Engaged − atentos':<44} {e2['diferencia']:+.4f}  IC [{e2['ic'][0]:+.4f}, {e2['ic'][1]:+.4f}]  "
          + (("✅ CUMPLE" if cumple else "❌ no cumple") if con_veredicto else ""))
    out["E3_barely"] = tasa_ic(apenas, apenas[columna_valor] <= CORTES["le_50"])
    mostrar("E3  Barely-engaged marcados (≤ 50)", out["E3_barely"])

    if columna_valor.endswith("_valor"):
        am = atentos[atentos[columna_valor] <= CORTES["le_50"]]
        if len(am):
            dominante = am[[f"{cad}_{c}" for c in CAUSAS]].to_numpy().argmax(1)
            conteo = {CAUSAS[k]: int((dominante == k).sum()) for k in range(len(CAUSAS))}
            out["E3_causa_dominante_atentos_marcados"] = conteo
            print(f"E3  causa dominante en atentos marcados      {conteo}")
        por_sujeto = (atentos.assign(_m=atentos[columna_valor] <= CORTES["le_50"])
                      .groupby("sujeto")._m.agg(["sum", "count"]).sort_values("sum", ascending=False))
        total = int(por_sujeto["sum"].sum())
        out["E4_por_sujeto"] = {s: dict(marcados=int(r["sum"]), clips=int(r["count"])) for s, r in por_sujeto.iterrows()}
        out["E4_fraccion_en_el_sujeto_con_mas"] = (float(por_sujeto["sum"].iloc[0] / total) if total else None)
        print(f"E4  marcados en el sujeto con más: "
              f"{int(por_sujeto['sum'].iloc[0]) if total else 0} de {total}"
              + (f" ({out['E4_fraccion_en_el_sujeto_con_mas']:.0%})" if total else ""))
    return out


# ---------------------------------------------------------------------------
def main():
    df = pd.read_csv(CSV_CLIPS, dtype=str, keep_default_na=False)
    fidelidad(df)

    titulo("CONJUNTO Y EXCLUSIONES")
    et = pd.read_excel(ETIQUETAS)[["chunk", "label"]]
    assert set(et.label) <= ETIQUETAS_VALIDAS, f"etiquetas inesperadas: {set(et.label) - ETIQUETAS_VALIDAS}"
    d = df.merge(et, on="chunk", how="left")
    sin_etiqueta = int(d.label.isna().sum())
    d = d[d.label.notna()].copy()
    for c in df.columns:
        if c.endswith(("_valor", "_valor_cabeza")):
            d[c] = pd.to_numeric(d[c], errors="coerce")
        elif c.endswith(("_n", "_rostro", "_omitidos") + CAUSAS) or c in ("tiempo_ok", "cuadros_video"):
            d[c] = pd.to_numeric(d[c])
    tiempo_malo = int((d.tiempo_ok == 0).sum())
    print(f"clips: {len(df)} · sin etiqueta: {sin_etiqueta} · tiempo no confiable: {tiempo_malo}")
    res["conjunto"] = dict(clips=int(len(df)), sin_etiqueta=sin_etiqueta, tiempo_no_confiable=tiempo_malo,
                           por_etiqueta={k: int(v) for k, v in d.label.value_counts().items()},
                           sujetos=int(d.sujeto.nunique()))
    d = d[d.tiempo_ok == 1]

    for cad, con_veredicto, rotulo in (("6fps", True, "PRIMARIO, 6 fps"), ("5fps", False, "SENSIBILIDAD, 5 fps — sin veredicto")):
        titulo(f"§4.2 — {rotulo}")
        nulos = d[d[f"{cad}_valor"].isna()]
        print(f"clips sin valor (< 30 cuadros): {len(nulos)} · por etiqueta {nulos.label.value_counts().to_dict()}")
        dv = d[d[f"{cad}_valor"].notna()]
        res[cad] = dict(sin_valor=int(len(nulos)), sin_valor_por_etiqueta={k: int(v) for k, v in nulos.label.value_counts().items()},
                        cuadros_por_clip_mediana=float(dv[f"{cad}_n"].median()),
                        deteccion_media=float((dv[f"{cad}_rostro"] / dv[f"{cad}_n"]).mean()),
                        omitidos=int(dv[f"{cad}_omitidos"].sum()))
        print(f"cuadros por clip (mediana): {res[cad]['cuadros_por_clip_mediana']:.0f} · "
              f"detección media: {res[cad]['deteccion_media']:.2%} · omitidos: {res[cad]['omitidos']}")
        res[cad].update(bloque(dv, cad, f"{cad}_valor", con_veredicto))

    titulo("🔬 EXPLORATORIO — NO PRE-REGISTRADO: cabeza sola, 6 fps (sin mirada ni cierre ocular)")
    dv = d[d["6fps_valor_cabeza"].notna()]
    res["exploratorio_cabeza_sola_6fps"] = bloque(dv, "6fps", "6fps_valor_cabeza", False)

    guardar()
    print(f"\nresultado -> {RESULTADO}")
    print("Contador de evaluaciones sobre particiones de prueba: sigue en 0 (EngageNet Test intacto).")


if __name__ == "__main__":
    main()
