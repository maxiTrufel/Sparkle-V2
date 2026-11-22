"""Medición pre-registrada de C5 de `faceScore` y del criterio por cuadro de R2 sobre Eyeblink8.

Criterios: `Preregistro_Eyeblink8.md` §3, adendas §8 y §9. Se corre UNA vez.

Orden obligatorio:
  1. Fidelidad. Si algo no da 100 %, se detiene sin medir.
     a. Decisión por cuadro: 400 cuadros; `faceScore.js` original = port, con
        mirada y cabeza sola; y el `eyeBlink` del CSV = el de los valores crudos.
     b. Parte temporal: 40 cortes con toda su historia a 6 fps; JS = port = CSV.
     c. R2: SHA de `reglas.js` y `reglas.equivalenciaPython.test.js` en verde.
  2. Anotación, en memoria. Grupos de parpadeo de la adenda §8.2.
  3. K1 (primario, 6 fps, grupo corto) con su criterio; K2, K3, K4 con los
     suyos; K1 por grupo, sobre los 408 y a cadencia nativa, sin veredicto;
     K5 y K6 descriptivos.

Salida: sólo agregados (`eyeblink8_resultado.json`). Toda cifra lleva «4 sujetos»:
el IC se clusteriza por video (8) y es optimista (§3).

ENSAYO: con EYEBLINK8_ENSAYO=1, EYEBLINK8_RAIZ y FACESCORE_SALIDA apuntando a
datos inventados (`ensayo_medir_eyeblink8.py`). No controla los tamaños de grupo
del conjunto real ni la marca de corrida única.
"""
import glob
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime

import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
sys.path.insert(0, os.path.dirname(AQUI))
import facescore_ref as fs  # noqa: E402
import reglas_geometricas as R  # noqa: E402

ENSAYO = os.environ.get("EYEBLINK8_ENSAYO") == "1"
RAIZ = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
SALIDA = os.environ.get("FACESCORE_SALIDA", os.path.join(AQUI, "salida"))
DIR_MUESTRA = os.path.join(SALIDA, "muestra_eyeblink8")
EXTRACCION = os.path.join(SALIDA, "eyeblink8_extraccion.json")
RESULTADO = os.path.join(SALIDA, "eyeblink8_resultado.json")

PRODUCTO = os.environ.get("SPARKLE_FRONTEND", os.path.abspath(os.path.join(
    AQUI, "..", "..", "..", "extension_medida", "frontend")))
FACESCORE_JS = os.path.join(PRODUCTO, "src", "offscreen", "faceScore.js")
REGLAS_JS = os.path.join(PRODUCTO, "src", "offscreen", "reglas.js")
SHA_JS = "cab6fa04fb5375873304f739225d61cc95075ab83db6e102d628694143cfc5e2"
SHA_REGLAS = "22fb3246cc242d45751c938c94934ce01f661861c2929000c48e12304b45d49c"

VIDEOS = ("1", "2", "3", "4", "8", "9", "10", "11")
N_CALIB = 180                 # §2 y adenda §9.1: primeros 180 ear_avg finitos de la grilla de 6 fps
N_MUESTRA = 400
CORTES_ESPERADOS = 40
LIMITE_MS = fs.CLOSURE_MS     # 500 ms
UMBRAL_BLINK = fs.EYE_CLOSED_THRESHOLD
GRUPOS_ESPERADOS = dict(corto=385, ambiguo=14, largo=9)   # adenda §8.2
REPLICAS, SEMILLA = 2000, 42
rng = np.random.default_rng(SEMILLA)
res = dict(preregistro="Preregistro_Eyeblink8.md §3, adendas §8 y §9", ensayo=ENSAYO,
           faceScore_sha256=SHA_JS, reglas_sha256=SHA_REGLAS,
           advertencia="4 sujetos. IC por bootstrap clusterizado por video (8): optimista. No generaliza.")


# ---------------------------------------------------------------------------
# utilidades
# ---------------------------------------------------------------------------
def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def titulo(t):
    print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


def guardar():
    res["fecha"] = datetime.now().isoformat(timespec="seconds")
    with open(RESULTADO, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2, ensure_ascii=False)


def detener(msg):
    res["detenido"] = msg
    guardar()
    raise SystemExit(msg)


def archivo(video, patron):
    hallados = glob.glob(os.path.join(RAIZ, video, patron))
    if len(hallados) != 1:
        raise SystemExit(f"🔴 video {video}: se esperaba un {patron} y hay {len(hallados)}")
    return hallados[0]


def tiempos(video):
    with open(archivo(video, "*.txt"), encoding="utf-8") as f:
        return [float(linea.split()[1]) * 1000.0 for linea in f if linea.strip()]


def a_num(col):
    # float() de Python lee exactamente lo que escribió repr(): la fidelidad compara igualdad.
    return np.array([float(x) if x != "" else np.nan for x in col], dtype=float)


def cargar(nombre):
    partes = []
    for v in VIDEOS:
        partes.append(pd.read_csv(os.path.join(SALIDA, f"eyeblink8_{nombre}_{v}.csv"),
                                  dtype=str, keep_default_na=False))
    df = pd.concat(partes, ignore_index=True)
    df["k"] = df.k.astype(int)
    df["rostro"] = df.rostro.astype(int)
    df["omitido"] = df.omitido.astype(int)
    for col in ("t_ms", "blink", "ear_avg", "valor"):
        if col in df:
            df[col] = a_num(df[col])
    return df


def tasa_ic(d, marcado):
    """Proporción agregada con IC 95 % por bootstrap clusterizado por video."""
    marcado = np.asarray(marcado, dtype=float)
    if len(d) == 0:
        return dict(n=0, videos=0, marcados=0, p=None, ic=[None, None])
    g = pd.DataFrame(dict(video=d.video.to_numpy(), m=marcado)).groupby("video")["m"].agg(["sum", "count"])
    num, den = g["sum"].to_numpy(), g["count"].to_numpy()
    i = rng.integers(0, len(num), (REPLICAS, len(num)))
    db = den[i].sum(1)
    boot = np.where(db > 0, num[i].sum(1) / np.maximum(db, 1), np.nan)
    return dict(n=int(den.sum()), videos=int(len(num)), marcados=int(num.sum()), p=float(num.sum() / den.sum()),
                ic=[float(np.nanpercentile(boot, 2.5)), float(np.nanpercentile(boot, 97.5))])


def mostrar(nombre, m, veredicto=""):
    if m["p"] is None:
        print(f"{nombre:<52} sin datos")
        return
    print(f"{nombre:<52} {m['p']:.4f}  IC [{m['ic'][0]:.4f}, {m['ic'][1]:.4f}]  "
          f"({m['marcados']}/{m['n']}, {m['videos']} videos) {veredicto}")


def percentiles(x):
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return dict(n=0)
    return dict(n=int(len(x)), p10=float(np.percentile(x, 10)), p50=float(np.percentile(x, 50)),
                p90=float(np.percentile(x, 90)), max=float(x.max()), min=float(x.min()))


# ---------------------------------------------------------------------------
# 1. Fidelidad
# ---------------------------------------------------------------------------
def node(script, *args):
    return json.loads(subprocess.run(["node", os.path.join(AQUI, script), *args],
                                     capture_output=True, text=True, check=True).stdout)


def lm_de(c):
    return {int(k): v for k, v in c["lm"].items()} if c["lm"] else None


def fidelidad_cuadros(nat):
    titulo("1a — FIDELIDAD POR CUADRO (400 cuadros) contra faceScore.js original")
    cand = []
    for v in VIDEOS:
        with open(os.path.join(DIR_MUESTRA, f"{v}_cuadros.json"), encoding="utf-8") as f:
            cand += json.load(f)
    cand = [c for c in cand if c["m_col"] is not None and c["bs"] is not None]
    cand.sort(key=lambda c: (c["sorteo"], c["video"], c["k"]))
    muestra = cand[:N_MUESTRA]
    if len(muestra) < N_MUESTRA:
        detener(f"🔴 Sólo {len(muestra)} candidatos con rostro para la muestra por cuadro. No se mide.")

    tmp = os.path.join(SALIDA, "_muestra_cuadros_tmp.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(muestra, f)
    try:
        js = node("equivalencia_facescore.mjs", FACESCORE_JS, tmp)
    finally:
        os.remove(tmp)

    py_cabeza = [fs.en_pantalla(*fs.angulos_cabeza(c["m_col"], lm_de(c))) for c in muestra]
    py_completo = [fs.en_pantalla(*fs.angulos_cabeza(c["m_col"], lm_de(c)), c["bs"]) for c in muestra]
    idx = nat.set_index(["video", "k"])
    csv_ok = [bool(idx.loc[(c["video"], c["k"]), "rostro"] == 1
                   and idx.loc[(c["video"], c["k"]), "blink"] == fs.parpadeo(c["bs"])) for c in muestra]

    n = len(muestra)
    c1 = sum(a == b for a, b in zip(js["cabeza"], py_cabeza)) / n
    c2 = sum(a == b for a, b in zip(js["completo"], py_completo)) / n
    c3 = sum(csv_ok) / n
    print(f"cuadros                        : {n}  (videos: {sorted({c['video'] for c in muestra}, key=int)})")
    print(f"en pantalla JS cabeza/completo : {sum(js['cabeza'])} / {sum(js['completo'])}")
    print(f"con eyeBlink > 0,5 en la muestra: {sum(fs.parpadeo(c['bs']) > UMBRAL_BLINK for c in muestra)}")
    print(f"coincidencia cabeza sola       : {c1:.4f}")
    print(f"coincidencia completa          : {c2:.4f}")
    print(f"CSV reproduce eyeBlink crudo   : {c3:.4f}")
    res["fidelidad_cuadros"] = dict(n=n, cabeza=c1, completo=c2, csv=c3)
    if not (c1 == 1.0 and c2 == 1.0 and c3 == 1.0):
        detener("🔴 La fidelidad por cuadro no es 100 %. No se mide nada (§2).")
    print("✅ 100 % en las tres.")


def fidelidad_temporal(g6):
    titulo("1b — FIDELIDAD TEMPORAL (40 cortes) contra faceScore.js original")
    clips, refs = [], []
    for v in VIDEOS:
        with open(os.path.join(DIR_MUESTRA, f"{v}_6fps.json"), encoding="utf-8") as f:
            m = json.load(f)
        for corte in m["cortes"]:
            cuadros = [c for c in m["cuadros"] if c["t"] <= corte]
            if cuadros:
                clips.append(dict(cuadros=cuadros))
                refs.append((v, cuadros[-1]["k"]))
    if len(clips) != CORTES_ESPERADOS:
        detener(f"🔴 Hay {len(clips)} cortes y se esperaban {CORTES_ESPERADOS}. No se mide.")

    tmp = os.path.join(SALIDA, "_clips_tmp.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(clips, f)
    try:
        js = node("equivalencia_clips.mjs", FACESCORE_JS, tmp)
    finally:
        os.remove(tmp)

    def valor_py(clip, cabeza):
        p, ultimo = fs.PuntajeCara(), None
        for c in clip["cuadros"]:
            bs = ({} if cabeza else c["bs"]) if c["m_col"] is not None else None
            p.registrar(c["t"], c["rostro"], c["m_col"], lm_de(c), bs)
            ultimo = c["t"]
        return p.valor(ultimo)

    idx = g6.set_index(["video", "k"])
    iguales = dict(completo=0, cabeza=0, csv=0)
    ojos_en_cortes = 0
    for i, clip in enumerate(clips):
        pc, ph = valor_py(clip, False), valor_py(clip, True)
        iguales["completo"] += int(pc == js["completo"][i])
        iguales["cabeza"] += int(ph == js["cabeza"][i])
        v_csv = idx.loc[refs[i], "valor"]
        v_csv = None if np.isnan(v_csv) else float(v_csv)
        iguales["csv"] += int(v_csv == pc)
        ojos_en_cortes += int(pc is not None and ph is not None and pc != ph)
    n = len(clips)
    tasas = {k: v / n for k, v in iguales.items()}
    print(f"cortes                         : {n}")
    print(f"cortes donde mirada/ojos cambian el valor: {ojos_en_cortes}")
    for k, v in tasas.items():
        print(f"coincidencia {k:<18}: {v:.4f}")
    res["fidelidad_temporal"] = dict(n=n, **tasas)
    if any(v != 1.0 for v in tasas.values()):
        detener("🔴 La fidelidad temporal no es 100 %. No se mide nada (§2).")
    print("✅ 100 % en las tres.")


def fidelidad_r2():
    titulo("1c — R2: reglas.js congelado y equivalencia con Python")
    sha = sha256(REGLAS_JS)
    if sha != SHA_REGLAS:
        detener(f"🔴 reglas.js no es el congelado (leído {sha}).")
    r = subprocess.run(["node", "--test", "tests/reglas.equivalenciaPython.test.js"],
                       cwd=PRODUCTO, capture_output=True, text=True)
    resumen = [ln for ln in r.stdout.splitlines() if ln.startswith(("# pass", "# fail"))]
    print("SHA-256 de reglas.js: coincide ·", " · ".join(resumen))
    res["fidelidad_r2"] = dict(returncode=r.returncode, resumen=resumen)
    if r.returncode != 0:
        detener("🔴 reglas.equivalenciaPython.test.js no está en verde. No se mide nada (§2).")
    print("✅ En verde.")


# ---------------------------------------------------------------------------
# 2. Anotación
# ---------------------------------------------------------------------------
def anotacion(video):
    ts = tiempos(video)

    def t_de(k):
        return ts[k - 1] if 1 <= k <= len(ts) else None

    filas, dentro = [], False
    with open(archivo(video, "*.tag"), encoding="utf-8", errors="replace") as f:
        for ln in f:
            ln = ln.strip()
            if ln == "#start":
                dentro = True
                continue
            if dentro and ln and not ln.startswith("#"):
                c = ln.split(":")
                filas.append(dict(video=video, k=int(c[0]), bid=int(c[1]),
                                  ambos_c=c[3] == "C" and c[5] == "C", nv=c[4] == "N" or c[6] == "N"))
    cuadros = pd.DataFrame(filas)

    parp = []
    for bid, g in cuadros[cuadros.bid >= 0].groupby("bid"):
        ks = sorted(g.k)
        t0, t1 = t_de(ks[0]), t_de(ks[-1] + 1)
        if t0 is None or t1 is None:
            parp.append(dict(video=video, bid=int(bid), grupo="sin_tiempo"))
            continue
        ambos = sorted(g.k[g.ambos_c])
        tramo, i = 0.0, 0
        while i < len(ambos):
            j = i
            while j + 1 < len(ambos) and ambos[j + 1] == ambos[j] + 1:
                j += 1
            tramo = max(tramo, t_de(ambos[j] + 1) - t_de(ambos[i]))
            i = j + 1
        intervalo = t1 - t0
        grupo = "corto" if intervalo < LIMITE_MS else ("ambiguo" if tramo < LIMITE_MS else "largo")
        parp.append(dict(video=video, bid=int(bid), t0=t0, t1=t1, intervalo=intervalo, tramo=tramo,
                         primer_c=t_de(ambos[0]) if ambos else None, grupo=grupo))
    return cuadros, pd.DataFrame(parp)


# ---------------------------------------------------------------------------
# 3. Medición
# ---------------------------------------------------------------------------
def disparos(parp, muestras):
    """Por parpadeo: ¿alguna muestra con t en [t0, t1) quedó fuera por ojos (C5)?"""
    por_video = {v: (g.t_ms.to_numpy(), (g.causa == "ojos").to_numpy(), (g.rostro == 1).to_numpy())
                 for v, g in muestras.sort_values(["video", "t_ms"]).groupby("video")}
    marc, n_mu, n_ro = [], [], []
    for p in parp.itertuples():
        t, ojos, ro = por_video[p.video]
        a, b = np.searchsorted(t, p.t0, "left"), np.searchsorted(t, p.t1, "left")
        marc.append(bool(ojos[a:b].any()))
        n_mu.append(b - a)
        n_ro.append(int(ro[a:b].sum()))
    return np.array(marc), np.array(n_mu), np.array(n_ro)


def veredicto_k1(p):
    return "✅ ÉXITO" if p <= 0.05 else ("🟡 zona intermedia" if p <= 0.10 else "🔴 NEGATIVO")


def medir_k1(parp, g6, nat):
    titulo("K1 — PARPADEOS QUE DISPARAN C5 (primario: grupo corto, 6 fps)")
    res["K1"] = {}
    for cad, muestras in (("6fps", g6), ("nativo", nat)):
        marc, n_mu, n_ro = disparos(parp, muestras)
        res["K1"][cad] = {}
        for grupo in ("corto", "ambiguo", "largo", "todos_408"):
            sel = np.ones(len(parp), bool) if grupo == "todos_408" else (parp.grupo == grupo).to_numpy()
            m = tasa_ic(parp[sel], marc[sel])
            m["sin_muestras_en_el_intervalo"] = int((n_mu[sel] == 0).sum())
            m["sin_rostro_en_todas_sus_muestras"] = int(((n_mu[sel] > 0) & (n_ro[sel] == 0)).sum())
            primario = cad == "6fps" and grupo == "corto"
            if primario:
                m["veredicto"] = veredicto_k1(m["p"])
            res["K1"][cad][grupo] = m
            mostrar(f"K1 {cad:<6} {grupo:<10}{' · PRIMARIO' if primario else ' · sin veredicto'}", m,
                    m.get("veredicto", ""))
        print(f"   parpadeos sin ninguna muestra en su intervalo ({cad}): "
              f"{ {g: res['K1'][cad][g]['sin_muestras_en_el_intervalo'] for g in ('corto', 'ambiguo', 'largo')} }")


def medir_por_cuadro(cuadros, nat, g6):
    j = cuadros.merge(nat, on=["video", "k"], how="left", validate="one_to_one")
    con_tiempo = j.t_ms.notna()
    pop2 = (j.ambos_c & ~j.nv & con_tiempo).to_numpy()
    pop3 = ((j.bid < 0) & ~j.nv & con_tiempo).to_numpy()
    con_blink = j.blink.notna().to_numpy()
    sin_rostro = (j.rostro.fillna(0) == 0).to_numpy()
    res["poblaciones"] = dict(
        K2_cuadros=int(pop2.sum()), K3_cuadros=int(pop3.sum()),
        K2_sin_rostro=int((pop2 & sin_rostro).sum()), K2_rostro_sin_blendshapes=int((pop2 & ~sin_rostro & ~con_blink).sum()),
        K3_sin_rostro=int((pop3 & sin_rostro).sum()), K3_rostro_sin_blendshapes=int((pop3 & ~sin_rostro & ~con_blink).sum()),
        anotados_sin_tiempo=int((~con_tiempo).sum()))
    # 67.275 y no 67.278 (adenda §10): §8.3 contó 3 cuadros anotados sin tiempo —el cuadro 0 de los
    # videos 1, 3 y 8— que el método no procesa (§9.2). La primera corrida se detuvo acá.
    if not ENSAYO and (res["poblaciones"]["K2_cuadros"], res["poblaciones"]["K3_cuadros"]) != (1720, 67275):
        detener(f"🔴 Poblaciones distintas de la adenda §8.3: {res['poblaciones']}. No se mide.")
    print(f"poblaciones: {res['poblaciones']}")

    titulo("K2 · K3 — UMBRAL INSTANTÁNEO DE C5 (eyeBlink medio > 0,5)")
    blink_alto = (j.blink > UMBRAL_BLINK).to_numpy()
    k2 = tasa_ic(j[pop2 & con_blink], blink_alto[pop2 & con_blink])
    k2["veredicto"] = "✅ ÉXITO" if k2["p"] is not None and k2["p"] >= 0.90 else "🔴 NO CUMPLE (≥ 0,90)"
    k3 = tasa_ic(j[pop3 & con_blink], blink_alto[pop3 & con_blink])
    k3["veredicto"] = "✅ ÉXITO" if k3["p"] is not None and k3["p"] <= 0.05 else "🔴 NO CUMPLE (≤ 5 %)"
    res["K2"], res["K3"] = k2, k3
    mostrar("K2 sensibilidad (cuadros con los 2 ojos cerrados)", k2, k2["veredicto"])
    mostrar("K3 falsa marca (cuadros fuera de parpadeo)", k3, k3["veredicto"])

    titulo("K4 — CRITERIO POR CUADRO DE R2 (ear_avg < 0,30 × línea base)")
    bases = {}
    for v in VIDEOS:
        e = g6[g6.video == v].sort_values("t_ms")
        fin = e[np.isfinite(e.ear_avg)]
        if len(fin) < N_CALIB:
            bases[v] = dict(base=np.nan, t_calib=np.nan, finitos=int(len(fin)))
        else:
            bases[v] = dict(base=float(np.median(fin.ear_avg.to_numpy()[:N_CALIB])),
                            t_calib=float(fin.t_ms.to_numpy()[N_CALIB - 1]), finitos=int(len(fin)))
    j["base"] = j.video.map({v: b["base"] for v, b in bases.items()})
    j["t_calib"] = j.video.map({v: b["t_calib"] for v, b in bases.items()})
    evaluable = (np.isfinite(j.ear_avg) & np.isfinite(j.base) & (j.t_ms > j.t_calib)).to_numpy()
    cerrado_r2 = (j.ear_avg < R.EAR_FRAC_CIERRE * j.base).to_numpy()
    k4s = tasa_ic(j[pop2 & evaluable], cerrado_r2[pop2 & evaluable])
    k4f = tasa_ic(j[pop3 & evaluable], cerrado_r2[pop3 & evaluable])
    ok = k4s["p"] is not None and k4f["p"] is not None and k4s["p"] >= 0.90 and k4f["p"] <= 0.05
    res["K4"] = dict(sensibilidad=k4s, falsa_marca=k4f, veredicto="✅ ÉXITO" if ok else "🔴 NO CUMPLE (≥ 0,90 y ≤ 5 %)",
                     videos_sin_linea_base=[v for v, b in bases.items() if not np.isfinite(b["base"])],
                     excluidos_calibracion=dict(K2=int((pop2 & (j.t_ms <= j.t_calib).to_numpy()).sum()),
                                                K3=int((pop3 & (j.t_ms <= j.t_calib).to_numpy()).sum())),
                     tiempo_de_calibracion_s=percentiles([b["t_calib"] / 1000 for b in bases.values()]))
    mostrar("K4 sensibilidad (cuadros con los 2 ojos cerrados)", k4s)
    mostrar("K4 falsa marca (cuadros fuera de parpadeo)", k4f)
    print(f"K4 veredicto: {res['K4']['veredicto']} · excluidos por calibración {res['K4']['excluidos_calibracion']}"
          f" · sin línea base {res['K4']['videos_sin_linea_base']}")
    return j


def medir_k5_k6(parp, j, nat, g6):
    titulo("K5 · K6 — DESCRIPTIVOS")
    k5 = dict(intervalo_ms={g: percentiles(parp[parp.grupo == g].intervalo) for g in ("corto", "ambiguo", "largo")},
              cierre_total_ms={g: percentiles(parp[parp.grupo == g].tramo) for g in ("corto", "ambiguo", "largo")})
    por_video = {v: g.sort_values("t_ms") for v, g in nat.groupby("video")}
    lat, sin = [], 0
    for p in parp.itertuples():
        if p.primer_c is None or not np.isfinite(p.primer_c):
            continue
        g = por_video[p.video]
        dentro = g[(g.t_ms >= p.t0) & (g.t_ms < p.t1) & (g.blink > UMBRAL_BLINK)]
        if len(dentro):
            lat.append(float(dentro.t_ms.iloc[0]) - p.primer_c)
        else:
            sin += 1
    k5["latencia_ms_primer_blink_alto_menos_primer_cierre_total"] = percentiles(lat)
    k5["parpadeos_con_cierre_total_sin_blink_alto_en_el_intervalo"] = sin
    res["K5"] = k5
    print(f"K5 latencia (ms): {k5['latencia_ms_primer_blink_alto_menos_primer_cierre_total']} · sin blink alto: {sin}")

    k6 = {}
    for v in VIDEOS:
        a, b = nat[nat.video == v], g6[g6.video == v]
        k6[v] = dict(nativo_rostro=float(a.rostro.mean()), nativo_omitidos=int(a.omitido.sum()),
                     grilla_rostro=float(b.rostro.mean()), grilla_omitidos=int(b.omitido.sum()))
    res["K6"] = k6
    for v, d in k6.items():
        print(f"K6 video {v:>2}: rostro nativo {d['nativo_rostro']:.4f} · grilla {d['grilla_rostro']:.4f} · "
              f"omitidos {d['nativo_omitidos']}/{d['grilla_omitidos']}")


# ---------------------------------------------------------------------------
def main():
    if os.path.exists(RESULTADO) and not ENSAYO:
        raise SystemExit(f"🔴 {RESULTADO} ya existe: la medición se corre UNA vez.")
    with open(EXTRACCION, encoding="utf-8") as f:
        meta = json.load(f)
    if meta.get("ensayo") and not ENSAYO:
        raise SystemExit("🔴 La extracción es un ensayo. No se mide sobre datos falsos.")
    faltan = [v for v in VIDEOS if v not in meta.get("videos", {})]
    if faltan:
        raise SystemExit(f"🔴 Extracción incompleta, faltan videos {faltan}.")
    res["extraccion"] = {k: meta[k] for k in ("modelo", "versiones", "alineacion", "grilla", "semilla") if k in meta}
    res["extraccion"]["videos"] = {v: {k: d[k] for k in ("cuadros_leidos", "sin_tiempo", "procesados", "duracion_s",
                                                         "nativo", "grilla_6fps")} for v, d in meta["videos"].items()}
    if sha256(FACESCORE_JS) != SHA_JS:
        raise SystemExit("🔴 faceScore.js no es el congelado.")

    nat, g6 = cargar("nativo"), cargar("6fps")

    fidelidad_cuadros(nat)
    fidelidad_temporal(g6)
    fidelidad_r2()

    titulo("2 — ANOTACIÓN (en memoria)")
    partes = [anotacion(v) for v in VIDEOS]
    cuadros = pd.concat([c for c, _ in partes], ignore_index=True)
    parp = pd.concat([p for _, p in partes], ignore_index=True)
    grupos = parp.grupo.value_counts().to_dict()
    res["grupos"] = {k: int(v) for k, v in grupos.items()}
    print(f"parpadeos por grupo: {res['grupos']} · cuadros anotados: {len(cuadros)}")
    if "sin_tiempo" in grupos:
        detener("🔴 Hay parpadeos sin tiempo; la adenda §8 dice que no. No se mide.")
    if not ENSAYO and {g: grupos.get(g, 0) for g in GRUPOS_ESPERADOS} != GRUPOS_ESPERADOS:
        detener(f"🔴 Grupos distintos de la adenda §8.2 ({GRUPOS_ESPERADOS}). No se mide.")

    medir_k1(parp, g6, nat)
    j = medir_por_cuadro(cuadros, nat, g6)
    medir_k5_k6(parp, j, nat, g6)

    guardar()
    titulo("RESUMEN — 4 sujetos, IC optimista por video")
    print(f"K1 primario (corto, 6 fps): {res['K1']['6fps']['corto']['p']:.4f} → {res['K1']['6fps']['corto']['veredicto']}")
    print(f"K2: {res['K2']['p']:.4f} → {res['K2']['veredicto']}")
    print(f"K3: {res['K3']['p']:.4f} → {res['K3']['veredicto']}")
    print(f"K4: sens {res['K4']['sensibilidad']['p']:.4f} · falsa marca {res['K4']['falsa_marca']['p']:.4f}"
          f" → {res['K4']['veredicto']}")
    print(f"\nguardado -> {RESULTADO}")


if __name__ == "__main__":
    main()
