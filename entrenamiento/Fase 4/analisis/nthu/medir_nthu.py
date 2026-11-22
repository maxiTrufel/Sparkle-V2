"""Medición pre-registrada sobre NTHU-DDD (Training set). Se corre UNA vez.

Criterios: `Preregistro_FaceScore.md` §5.1, §5.2 y adenda §5.3.

Orden obligatorio, cada paso bloquea al siguiente (§5.1.9):
  1. Fidelidad
     a. `reglas.js` congelado y `reglas.equivalenciaPython.test.js` en verde.
     b. `faceScore` temporal: los 40 tramos de 10 s sorteados antes de extraer
        dan el MISMO valor en el JS original y en el port; y el CSV coincide con el
        port corrido sobre la HISTORIA COMPLETA de esos 40 videos, en todas sus
        muestras (adenda §5.4).
     c. Veredicto: el arnés en Node (`veredicto_arnes.mjs`), que corre `faceScore.js`,
        `reglas.js` y `noFaceFraction` ORIGINALES, y `veredicto_ref.py` clasifican
        idéntico en todos los instantes de **400 secuencias sintéticas** y de las
        **40 secuencias reales** completas (`extraer_secuencias_veredicto.py`).
  2. N1 y N2 (primarios), N3 y N4 (secundarios por cuadro).
  3. F1–F3 de `faceScore` (secundarios y exploratorio).
  4. V1 (desplegado, con cotas) y V2 (tres estados), descriptivos.

Salida: sólo agregados (`nthu_resultado.json`), que **tampoco se versionan**: el
EULA prohíbe redistribuir la base y sus etiquetas. Las cifras que se publican van
escritas en la bitácora.

⚠️ **Lectura declarada de §5.1.5.** Dice «ventanas deslizantes con paso de 10 s
desde t = 30 s», y §5.1.6 fija los instantes en t = 50 s, 60 s… Se usan ventanas
COMPLETAS de 300 muestras con paso de 60 (10 s), la primera terminando a los 50 s:
es lo que hace el producto, que exige la ventana llena antes de dejar decidir a una
regla. Las ventanas disjuntas se reportan al lado, sin veredicto (§5.1.5).
"""
import hashlib
import math
import random
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
sys.path.insert(0, os.path.join(AQUI, "..", "facescore"))
sys.path.insert(0, os.path.dirname(AQUI))
import facescore_ref as fs  # noqa: E402
import reglas_geometricas as R  # noqa: E402
import veredicto_ref as V  # noqa: E402

ENSAYO = os.environ.get("NTHU_ENSAYO") == "1"
SALIDA = os.environ.get("FACESCORE_SALIDA", os.path.join(AQUI, "salida"))
CSV = os.path.join(SALIDA, "nthu_muestras.csv")
DIR_MUESTRA = os.path.join(SALIDA, "muestra_nthu")
EXTRACCION = os.path.join(SALIDA, "nthu_extraccion.json")
RESULTADO = os.path.join(SALIDA, "nthu_resultado.json")

PRODUCTO = os.environ.get("SPARKLE_FRONTEND", os.path.abspath(os.path.join(
    AQUI, "..", "..", "..", "extension_medida", "frontend")))
OFFSCREEN = os.path.join(PRODUCTO, "src", "offscreen")
SHA_JS = {"faceScore.js": "cab6fa04fb5375873304f739225d61cc95075ab83db6e102d628694143cfc5e2",
          "reglas.js": "22fb3246cc242d45751c938c94934ce01f661861c2929000c48e12304b45d49c"}

VENTANA, PASO, VENTANA_ROSTRO = 300, 60, 60      # 50 s, 10 s, 60 muestras
TRAMO = 60                                        # 10 s a 6 fps, unidad de faceScore
N_CALIB = 180
MAX_SIN_ROSTRO = 0.30
YAW_R1 = 20.0                                     # `reglas.js`
REPLICAS, SEMILLA = 2000, 42
rng = np.random.default_rng(SEMILLA)
res = dict(preregistro="Preregistro_FaceScore.md §5.1, §5.2, adenda §5.3", ensayo=ENSAYO,
           lectura_ventanas="§5.1.5 leído como §5.1.6: ventanas completas de 300 muestras, "
                            "paso de 60, la primera termina a los 50 s",
           advertencia="Infrarrojo, conductores en simulador. `looking aside` no es mirar fuera de "
                       "la pantalla de una clase: la transferencia es parcial y así se informa.")


# ---------------------------------------------------------------------------
def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def titulo(t):
    print("\n" + "=" * 74 + f"\n{t}\n" + "=" * 74)


def guardar():
    res["fecha"] = datetime.now().isoformat(timespec="seconds")
    with open(RESULTADO, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=1, ensure_ascii=False)


def detener(msg):
    res["detenido"] = msg
    guardar()
    raise SystemExit(msg)


def num(col):
    return np.array([float(x) if x != "" else np.nan for x in col], dtype=float)


def cargar():
    df = pd.read_csv(CSV, dtype=str, keep_default_na=False)
    for c in ("k", "rostro", "omitido"):
        df[c] = df[c].astype(int)
    for c in ("t_ms", "yaw_fs", "pitch_fs", "gaze_x", "gaze_y", "blink", "ear_avg", "valor"):
        df[c] = num(df[c])
    return df


def ic_prop(exitos, n, sujetos):
    """Proporción agregada con IC 95 % por bootstrap clusterizado por sujeto."""
    if len(exitos) == 0:
        return dict(n=0, sujetos=0, p=None, ic=[None, None])
    t = pd.DataFrame(dict(s=sujetos, e=np.asarray(exitos, float))).groupby("s")["e"].agg(["sum", "count"])
    a, d = t["sum"].to_numpy(), t["count"].to_numpy()
    i = rng.integers(0, len(a), (REPLICAS, len(a)))
    db = d[i].sum(1)
    boot = np.where(db > 0, a[i].sum(1) / np.maximum(db, 1), np.nan)
    return dict(n=int(d.sum()), sujetos=int(len(a)), marcados=int(a.sum()), p=float(a.sum() / d.sum()),
                ic=[float(np.nanpercentile(boot, 2.5)), float(np.nanpercentile(boot, 97.5))])


def ba_ic(pos_marc, pos_suj, neg_marc, neg_suj):
    """Sensibilidad, especificidad y BA con IC por bootstrap de sujetos de la unión."""
    sens = ic_prop(pos_marc, len(pos_marc), pos_suj)
    esp = ic_prop([1 - x for x in neg_marc], len(neg_marc), neg_suj)
    sujetos = sorted(set(pos_suj) | set(neg_suj))
    dp = pd.DataFrame(dict(s=pos_suj, e=np.asarray(pos_marc, float)))
    dn = pd.DataFrame(dict(s=neg_suj, e=np.asarray(neg_marc, float)))
    gp, gn = dp.groupby("s")["e"].agg(["sum", "count"]), dn.groupby("s")["e"].agg(["sum", "count"])
    P = {s: (gp.loc[s, "sum"], gp.loc[s, "count"]) if s in gp.index else (0, 0) for s in sujetos}
    N = {s: (gn.loc[s, "sum"], gn.loc[s, "count"]) if s in gn.index else (0, 0) for s in sujetos}
    boot = []
    for _ in range(REPLICAS):
        m = rng.integers(0, len(sujetos), len(sujetos))
        ps = sum(P[sujetos[j]][0] for j in m); pn = sum(P[sujetos[j]][1] for j in m)
        ns = sum(N[sujetos[j]][0] for j in m); nn = sum(N[sujetos[j]][1] for j in m)
        boot.append(np.nan if pn == 0 or nn == 0 else 0.5 * (ps / pn + 1 - ns / nn))
    punto = (np.nan if sens["p"] is None or esp["p"] is None else 0.5 * (sens["p"] + esp["p"]))
    return dict(sensibilidad=sens, especificidad=esp, ba=float(punto),
                ba_ic=[float(np.nanpercentile(boot, 2.5)), float(np.nanpercentile(boot, 97.5))],
                replicas_validas=int(np.sum(~np.isnan(boot))))


def veredicto_n(m):
    """Criterio de §5.1.5: BA ≥ 0,80 con LI ≥ 0,70 Y especificidad ≥ 0,90."""
    if not np.isfinite(m["ba"]) or m["especificidad"]["p"] is None:
        return "sin datos"
    ok = m["ba"] >= 0.80 and m["ba_ic"][0] >= 0.70 and m["especificidad"]["p"] >= 0.90
    return "✅ ÉXITO" if ok else "🔴 NEGATIVO"


def mostrar(nombre, m, extra=""):
    if m["p"] is None:
        print(f"{nombre:<52} sin datos"); return
    print(f"{nombre:<52} {m['p']:.4f}  IC [{m['ic'][0]:.4f}, {m['ic'][1]:.4f}]  "
          f"({m['marcados']}/{m['n']}, {m['sujetos']} suj) {extra}")


def mostrar_ba(nombre, m):
    print(f"{nombre}")
    mostrar("   sensibilidad", m["sensibilidad"])
    mostrar("   especificidad", m["especificidad"])
    print(f"   BA {m['ba']:.4f}  IC [{m['ba_ic'][0]:.4f}, {m['ba_ic'][1]:.4f}]   {veredicto_n(m)}")


# ---------------------------------------------------------------------------
# 1. Fidelidad
# ---------------------------------------------------------------------------
def instantes_port(muestras):
    """Veredicto V1 del port en cada instante, con el mismo orden que el arnés."""
    ear = [m["ear"] for m in muestras if m["ear"] is not None and np.isfinite(m["ear"])]
    base = float(np.median(ear[:N_CALIB])) if len(ear) >= N_CALIB else None
    p, salida = fs.PuntajeCara(), []
    for i, m in enumerate(muestras):
        lm = {int(k): v for k, v in m["lm"].items()} if m.get("lm") else None
        p.registrar(m["t"], m["rostro"], m["m_col"], lm, m["bs"])
        if i < VENTANA - 1 or (i - (VENTANA - 1)) % VENTANA_ROSTRO != 0:
            continue
        ventana = muestras[i - VENTANA + 1:i + 1]
        sin_valor = [x for x in ventana[-VENTANA_ROSTRO:] if not x["rostro"] or x["yaw"] is None]
        frac = len(sin_valor) / VENTANA_ROSTRO
        yaw = np.array([np.nan if x["yaw"] is None else x["yaw"] for x in ventana], float)
        ea = np.array([np.nan if x["ear"] is None else x["ear"] for x in ventana], float)
        seq = np.column_stack([yaw, ea])
        r1, _ = R.r1_mirada_fuera(seq, ["yaw", "ear_avg"])
        r2, _ = R.r2_ojos_cerrados(seq, ["yaw", "ear_avg"], baseline_ear=base)
        salida.append(V.v1(p.valor(m["t"]), bool(r1), bool(r2), frac))
    return salida


def _cuadro_sintetico(t, rnd, rostro=True, con_matriz=True, yaw_deg=0.0, pitch_deg=0.0,
                      blink=0.05, ear=0.30):
    """Un cuadro con la forma que espera `faceScore.js`, con valores elegidos."""
    if not rostro:
        return dict(t=t, rostro=False, m_col=None, lm=None, bs=None, yaw=None, ear=None)
    lm = {fs.MEJILLA_A: (0.40, 0.5, 0.0), fs.MEJILLA_B: (0.60, 0.5, 0.0),
          fs.NARIZ: (0.49 if yaw_deg >= 0 else 0.51, 0.5, 0.0),
          fs.FRENTE: (0.5, 0.3, 0.0 if pitch_deg < 0 else 0.02),
          fs.MENTON: (0.5, 0.7, 0.02 if pitch_deg < 0 else 0.0)}
    if not con_matriz:
        return dict(t=t, rostro=True, m_col=None, lm={str(k): list(v) for k, v in lm.items()},
                    bs=None, yaw=None, ear=ear)
    a, b = math.radians(yaw_deg), math.radians(pitch_deg)
    ry = np.array([[math.cos(a), 0, math.sin(a), 0], [0, 1, 0, 0],
                   [-math.sin(a), 0, math.cos(a), 0], [0, 0, 0, 1]])
    rx = np.array([[1, 0, 0, 0], [0, math.cos(b), -math.sin(b), 0],
                   [0, math.sin(b), math.cos(b), 0], [0, 0, 0, 1]])
    M = ry @ rx
    M[:3, 3] = [0.5, -1.0, -60.0]
    m_col = M.T.flatten().tolist()
    bs = {n: 0.0 for n in ("eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
                           "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight")}
    bs["eyeBlinkLeft"] = bs["eyeBlinkRight"] = blink
    yaw = fs.angulos_cabeza(m_col, lm)[0]
    return dict(t=t, rostro=True, m_col=m_col, lm={str(k): list(v) for k, v in lm.items()},
                bs=bs, yaw=yaw, ear=ear)


def secuencias_sinteticas(n=400, largo=420):
    """400 secuencias inventadas que cubren las ramas del veredicto (§5.1.3)."""
    out = []
    for s in range(n):
        rnd = random.Random(f"{SEMILLA}-{s}")
        modo = s % 5   # 0 normal · 1 cabeza girada · 2 ojos cerrados · 3 sin rostro · 4 mezcla
        muestras = []
        for i in range(largo):
            t = i * 1000.0 / 6
            sin_rostro = (modo == 3 and i % 3 == 0) or (modo == 4 and rnd.random() < 0.5)
            girado = modo == 1 and i > 60
            cerrado = modo == 2 and i > 60
            muestras.append(_cuadro_sintetico(
                t, rnd, rostro=not sin_rostro, con_matriz=not (modo == 4 and rnd.random() < 0.1),
                yaw_deg=(rnd.uniform(22, 40) if girado else rnd.uniform(-8, 8)),
                pitch_deg=rnd.uniform(-10, 10),
                blink=(0.9 if cerrado else 0.05),
                ear=(0.05 if cerrado else rnd.uniform(0.28, 0.32))))
        out.append(dict(id=f"sint-{s:03d}", muestras=muestras))
    return out


def secuencias_reales():
    """Las 40 secuencias completas del segundo pase (`extraer_secuencias_veredicto.py`)."""
    d = os.path.join(SALIDA, "secuencias_veredicto")
    if not os.path.isdir(d):
        return []
    return [json.load(open(os.path.join(d, a), encoding="utf-8"))
            for a in sorted(os.listdir(d)) if a.endswith(".json")]


def muestras_de_fidelidad():
    archivos = sorted(f for f in os.listdir(DIR_MUESTRA) if f.endswith(".json"))
    return [json.load(open(os.path.join(DIR_MUESTRA, a), encoding="utf-8")) for a in archivos]


def fidelidad(df):
    titulo("1a — reglas.js congelado y equivalencia con Python")
    for nombre, sha in SHA_JS.items():
        leido = sha256(os.path.join(OFFSCREEN, nombre))
        if leido != sha:
            detener(f"🔴 {nombre} no es el congelado (leído {leido}).")
    r = subprocess.run(["node", "--test", "tests/reglas.equivalenciaPython.test.js"],
                       cwd=PRODUCTO, capture_output=True, text=True)
    resumen = [l for l in r.stdout.splitlines() if l.startswith(("# pass", "# fail"))]
    print("SHA de faceScore.js y reglas.js: coinciden ·", " · ".join(resumen))
    res["fidelidad_reglas"] = dict(returncode=r.returncode, resumen=resumen)
    if r.returncode != 0:
        detener("🔴 reglas.equivalenciaPython.test.js no está en verde.")
    print("✅ En verde.")

    titulo("1b — faceScore temporal: 40 tramos contra el JS original")
    tramos = muestras_de_fidelidad()
    if len(tramos) != 40:
        detener(f"🔴 hay {len(tramos)} tramos de fidelidad y §5.1.3 fija 40.")
    tmp = os.path.join(SALIDA, "_tramos_tmp.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump([dict(cuadros=t["cuadros"]) for t in tramos], f)
    try:
        js = json.loads(subprocess.run(
            ["node", os.path.join(AQUI, "..", "facescore", "equivalencia_clips.mjs"),
             os.path.join(OFFSCREEN, "faceScore.js"), tmp],
            capture_output=True, text=True, check=True).stdout)
    finally:
        os.remove(tmp)

    def valor_py(t, cabeza):
        p, ultimo = fs.PuntajeCara(), None
        for c in t["cuadros"]:
            lm = {int(k): v for k, v in c["lm"].items()} if c["lm"] else None
            bs = ({} if cabeza else c["bs"]) if c["m_col"] is not None else None
            p.registrar(c["t"], c["rostro"], c["m_col"], lm, bs)
            ultimo = c["t"]
        return p.valor(ultimo) if ultimo is not None else None

    ig = dict(completo=0, cabeza=0)
    for i, t in enumerate(tramos):
        pc, ph = valor_py(t, False), valor_py(t, True)
        ig["completo"] += int(pc == js["completo"][i])
        ig["cabeza"] += int(ph == js["cabeza"][i])
    tasas = {k: v / len(tramos) for k, v in ig.items()}

    # Adenda §5.4. El valor del CSV se calcula con TODA la historia del video: su ventana
    # de 10 s arranca antes del tramo. Por eso el CSV se compara con el port corrido sobre
    # la historia completa de los mismos 40 videos (segundo pase), en TODAS sus muestras.
    reales = secuencias_reales()
    if len(reales) != 40:
        detener(f"🔴 hay {len(reales)} secuencias completas y hacen falta 40 (adenda §5.4).")
    idx = df[df.cadencia == "6fps"].set_index(["video", "k"])["valor"]
    n = iguales = 0
    for s in reales:
        p = fs.PuntajeCara()
        for m in s["muestras"]:
            lm = {int(k): v for k, v in m["lm"].items()} if m["lm"] else None
            p.registrar(m["t"], m["rostro"], m["m_col"], lm, m["bs"])
            v = p.valor(m["t"])
            c = idx.loc[(s["id"], m["k"])]
            c = None if np.isnan(c) else float(c)
            n += 1
            iguales += int(c == v)
    tasas["csv_historia_completa"] = iguales / n
    res["fidelidad_facescore_muestras_csv"] = n
    for k, v in tasas.items():
        print(f"coincidencia {k:<9}: {v:.4f}")
    res["fidelidad_facescore"] = dict(n=len(tramos), **tasas)
    if any(v != 1.0 for v in tasas.values()):
        detener("🔴 La fidelidad de faceScore no es 100 %.")
    print("✅ 100 % en las tres.")

    titulo("1c — veredicto: arnés en Node contra veredicto_ref.py")
    sint = secuencias_sinteticas()
    reales = secuencias_reales()
    print(f"secuencias sintéticas: {len(sint)} · reales: {len(reales)}")
    if len(reales) != 40:
        detener(f"🔴 hay {len(reales)} secuencias reales y §5.1.3 fija 40. "
                f"Falta correr extraer_secuencias_veredicto.py.")
    total = {}
    for nombre, secuencias in (("sinteticas", sint), ("reales", reales)):
        tmp = os.path.join(SALIDA, f"_seq_{nombre}.json")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(secuencias, f)
        try:
            arnes = json.loads(subprocess.run(
                ["node", os.path.join(AQUI, "veredicto_arnes.mjs"), OFFSCREEN, tmp],
                capture_output=True, text=True, check=True).stdout)
        finally:
            os.remove(tmp)
        iguales = n = 0
        for s, a in zip(secuencias, arnes):
            port = instantes_port(s["muestras"])
            if len(port) != len(a["instantes"]):
                detener(f"🔴 {nombre}/{s['id']}: el arnés evaluó {len(a['instantes'])} instantes y el "
                        f"port {len(port)}.")
            for p, j in zip(port, a["instantes"]):
                n += 1
                iguales += int(p[0] == j["estado"] and p[1] == j["fuente"])
        total[nombre] = dict(instantes=n, coincidencia=(iguales / n if n else None))
        print(f"  {nombre:<11}: {n} instantes · coincidencia {iguales / n if n else float('nan'):.4f}")
    res["fidelidad_veredicto"] = total
    if any(v["coincidencia"] != 1.0 for v in total.values()):
        detener("🔴 El veredicto del port no coincide con el arnés. No se mide (§5.1.3).")
    print("✅ 100 % en las dos poblaciones.")


# ---------------------------------------------------------------------------
# 2. Ventanas y métricas
# ---------------------------------------------------------------------------
def ventanas(g):
    """Índices de fin de cada ventana completa de 300 muestras, paso 60."""
    return list(range(VENTANA - 1, len(g), PASO))


def clase_ventana(head, eye, tipo):
    """§5.1.4: positiva si ≥ 50 % positivos; negativa si 0 % y todas negativas."""
    if tipo == "R1":
        pos = (head == "2").mean()
        neg = ((head == "0").all())
    else:
        pos = (eye == "1").mean()
        neg = ((eye == "0") & (head != "")).all() and (eye != "1").all()
    if pos >= 0.5:
        return "positiva"
    if pos == 0 and neg:
        return "negativa"
    return "mixta"


def medir_reglas(df, res_key, tipo):
    """N1 (R1 contra head=2) o N2 (R2 contra eye=1), por ventana."""
    pos_m, pos_s, neg_m, neg_s, excl, mixtas, e2e_pos = [], [], [], [], {"positiva": 0, "negativa": 0}, 0, []
    for video, g in df.groupby("video", sort=True):
        g = g.sort_values("k")
        sujeto = g.sujeto.iloc[0]
        ear = g.ear_avg.to_numpy()
        fin = ear[np.isfinite(ear)]
        base = float(np.median(fin[:N_CALIB])) if len(fin) >= N_CALIB else None
        yaw, head, eye = g.yaw_fs.to_numpy(), g["head"].to_numpy(), g["eye"].to_numpy()
        for i in ventanas(g):
            sl = slice(i - VENTANA + 1, i + 1)
            clase = clase_ventana(head[sl], eye[sl], tipo)
            if clase == "mixta":
                mixtas += 1
                continue
            sin_rostro = float(np.mean(~np.isfinite(yaw[sl][-VENTANA_ROSTRO:])))
            seq = np.column_stack([yaw[sl], ear[sl]])
            d, _ = (R.r1_mirada_fuera(seq, ["yaw", "ear_avg"]) if tipo == "R1"
                    else R.r2_ojos_cerrados(seq, ["yaw", "ear_avg"], baseline_ear=base))
            if sin_rostro > MAX_SIN_ROSTRO:
                excl[clase] += 1
                if clase == "positiva":
                    e2e_pos.append((0, sujeto))      # extremo a extremo: no detectada
                continue
            if clase == "positiva":
                pos_m.append(int(bool(d))); pos_s.append(sujeto); e2e_pos.append((int(bool(d)), sujeto))
            else:
                neg_m.append(int(bool(d))); neg_s.append(sujeto)
    cond = ba_ic(pos_m, pos_s, neg_m, neg_s)
    e2e = ba_ic([m for m, _ in e2e_pos], [s for _, s in e2e_pos], neg_m, neg_s)
    res[res_key] = dict(condicionado=cond, extremo_a_extremo=e2e, ventanas_mixtas=mixtas,
                        excluidas_por_rostro=excl, veredicto=veredicto_n(cond))
    mostrar_ba(f"{res_key} condicionado a detección", cond)
    mostrar_ba(f"{res_key} extremo a extremo", e2e)
    print(f"   ventanas mixtas (fuera del primario): {mixtas} · excluidas por rostro: {excl}")


def medir_por_cuadro(df):
    titulo("N3 · N4 — criterios POR CUADRO")
    out = {}
    for nombre, col, pos_col, pos_val in (("N3", "yaw_fs", "head", "2"), ("N4", "ear_avg", "eye", "1")):
        marc_p, suj_p, marc_n, suj_n = [], [], [], []
        for video, g in df.groupby("video", sort=True):
            g = g.sort_values("k")
            sujeto = g.sujeto.iloc[0]
            ear = g.ear_avg.to_numpy(); fin = ear[np.isfinite(ear)]
            base = float(np.median(fin[:N_CALIB])) if len(fin) >= N_CALIB else np.nan
            if nombre == "N3":
                marca = np.abs(g.yaw_fs.to_numpy()) > YAW_R1
                neg = g["head"].to_numpy() == "0"
                pos = g["head"].to_numpy() == "2"
            else:
                marca = g.ear_avg.to_numpy() < R.EAR_FRAC_CIERRE * base
                neg = (g["eye"].to_numpy() == "0")
                pos = g["eye"].to_numpy() == "1"
            detectado = np.isfinite(g.yaw_fs.to_numpy() if nombre == "N3" else g.ear_avg.to_numpy())
            marc_p += list(marca[pos & detectado]); suj_p += [sujeto] * int((pos & detectado).sum())
            marc_n += list(marca[neg & detectado]); suj_n += [sujeto] * int((neg & detectado).sum())
        out[nombre] = ba_ic(marc_p, suj_p, marc_n, suj_n)
        mostrar_ba(f"{nombre} por cuadro, condicionado a detección", out[nombre])
    res["por_cuadro"] = out


def medir_facescore(df):
    titulo("F1 · F2 — faceScore en tramos disjuntos de 10 s")
    cortes = {"50": 50.0, "44_4": 400 / 9, "55_6": 500 / 9}
    datos = {c: dict(pm=[], ps=[], nm=[], ns=[]) for c in cortes}
    causas = {c: 0 for c in ("sin_rostro", "ojos", "lateral", "vertical", "")}
    sin_valor = 0
    for video, g in df.groupby("video", sort=True):
        g = g.sort_values("k"); sujeto = g.sujeto.iloc[0]
        head, eye, valor = g["head"].to_numpy(), g["eye"].to_numpy(), g.valor.to_numpy()
        for c in g.causa.to_numpy():
            causas[c if c in causas else ""] += 1
        for ini in range(0, len(g) - TRAMO + 1, TRAMO):
            sl = slice(ini, ini + TRAMO)
            v = valor[sl][-1]
            if not np.isfinite(v):
                sin_valor += 1
                continue
            clase = clase_ventana(head[sl], eye[sl], "R1")
            if clase == "mixta":
                continue
            for c, corte in cortes.items():
                d = datos[c]
                if clase == "positiva":
                    d["pm"].append(int(v <= corte)); d["ps"].append(sujeto)
                else:
                    d["nm"].append(int(v <= corte)); d["ns"].append(sujeto)
    res["F1"] = {}
    for c, d in datos.items():
        m = ba_ic(d["pm"], d["ps"], d["nm"], d["ns"])
        res["F1"][c] = m
        mostrar_ba(f"F1 con corte ≤ {c.replace('_', ',')}", m)
    res["F2_causas"] = causas
    res["F1_tramos_sin_valor"] = sin_valor
    print(f"   F2 causas de 'fuera' por muestra: {causas} · tramos sin valor: {sin_valor}")


def medir_veredictos(df):
    titulo("V1 · V2 — veredicto desplegado y veredicto de tres estados")
    filas = []
    for video, g in df.groupby("video", sort=True):
        g = g.sort_values("k"); sujeto = g.sujeto.iloc[0]
        yaw, ear = g.yaw_fs.to_numpy(), g.ear_avg.to_numpy()
        head, eye, valor = g["head"].to_numpy(), g["eye"].to_numpy(), g.valor.to_numpy()
        fin = ear[np.isfinite(ear)]
        base = float(np.median(fin[:N_CALIB])) if len(fin) >= N_CALIB else None
        for i in ventanas(g):
            sl = slice(i - VENTANA + 1, i + 1)
            seq = np.column_stack([yaw[sl], ear[sl]])
            r1, _ = R.r1_mirada_fuera(seq, ["yaw", "ear_avg"])
            r2, _ = R.r2_ojos_cerrados(seq, ["yaw", "ear_avg"], baseline_ear=base)
            frac = float(np.mean(~np.isfinite(yaw[sl][-VENTANA_ROSTRO:])))
            cara = None if not np.isfinite(valor[i]) else float(valor[i])
            pos = ((head[sl] == "2").mean() >= 0.5) or ((eye[sl] == "1").mean() >= 0.5)
            neg = (head[sl] == "0").all() and (eye[sl] == "0").all()
            clase = "positiva" if pos else ("negativa" if neg else "mixta")
            filas.append(dict(sujeto=sujeto, clase=clase,
                              v1=V.v1(cara, bool(r1), bool(r2), frac)[0],
                              v2=V.v2(cara, bool(r1), bool(r2), frac)[0]))
    d = pd.DataFrame(filas)
    res["veredictos"] = {}
    for col in ("v1", "v2"):
        rep = {cl: d[d.clase == cl][col].value_counts().to_dict() for cl in ("positiva", "negativa", "mixta")}
        pos, neg = d[(d.clase == "positiva")], d[(d.clase == "negativa")]
        marc_p = (pos[col] == V.DESATENTO).astype(int).tolist()
        marc_n = (neg[col] == V.DESATENTO).astype(int).tolist()
        m = ba_ic(marc_p, pos.sujeto.tolist(), marc_n, neg.sujeto.tolist())
        if col == "v1":
            ind_p = (pos[col] == V.INDETERMINADO).mean() if len(pos) else np.nan
            ind_n = (neg[col] == V.INDETERMINADO).mean() if len(neg) else np.nan
            m["cotas"] = dict(indeterminado_positivas=float(ind_p), indeterminado_negativas=float(ind_n),
                              nota="cotas: lo indeterminado cuenta en contra (punto) y a favor (+indeterminado)")
        res["veredictos"][col] = dict(reparto=rep, metricas=m)
        mostrar_ba(f"{col.upper()} desatento contra ventana positiva", m)
        print(f"   reparto: {rep}")


# ---------------------------------------------------------------------------
def main():
    if os.path.exists(RESULTADO) and not ENSAYO:
        raise SystemExit(f"🔴 {RESULTADO} ya existe: la medición se corre UNA vez.")
    with open(EXTRACCION, encoding="utf-8") as f:
        meta = json.load(f)
    if meta.get("ensayo") and not ENSAYO:
        raise SystemExit("🔴 La extracción es un ensayo. No se mide sobre datos falsos.")
    res["extraccion"] = {k: meta[k] for k in ("modelo", "versiones", "cadencias", "excluidos") if k in meta}
    df = cargar()
    res["conjunto"] = dict(videos=int(df.video.nunique()), sujetos=int(df.sujeto.nunique()),
                           muestras_6fps=int((df.cadencia == "6fps").sum()),
                           muestras_5fps=int((df.cadencia == "5fps").sum()))
    print(f"videos {res['conjunto']['videos']} · sujetos {res['conjunto']['sujetos']} · "
          f"muestras 6 fps {res['conjunto']['muestras_6fps']}")
    if not ENSAYO and res["conjunto"]["videos"] != 355:
        detener(f"🔴 hay {res['conjunto']['videos']} videos y §5.2 registró 355.")

    fidelidad(df)

    d6 = df[df.cadencia == "6fps"].copy()
    titulo("N1 · N2 — PRIMARIOS, por ventana de 50 s")
    medir_reglas(d6, "N1", "R1")
    medir_reglas(d6, "N2", "R2")
    medir_por_cuadro(d6)
    medir_facescore(d6)
    medir_veredictos(d6)

    titulo("SENSIBILIDAD A 5 fps — sin veredicto (§4.3 punto 3)")
    d5 = df[df.cadencia == "5fps"].copy()
    guardado = {k: res.get(k) for k in ("N1", "N2")}
    medir_reglas(d5, "N1_5fps", "R1")
    medir_reglas(d5, "N2_5fps", "R2")
    res.update({k: v for k, v in guardado.items() if v is not None})

    guardar()
    titulo("RESUMEN")
    for k in ("N1", "N2"):
        print(f"{k}: BA {res[k]['condicionado']['ba']:.4f} · "
              f"especificidad {res[k]['condicionado']['especificidad']['p']:.4f} → {res[k]['veredicto']}")
    print(f"\nguardado -> {RESULTADO}")
    print("Contador de evaluaciones sobre particiones de prueba: sigue en 0 (Evaluation set intacto).")


if __name__ == "__main__":
    main()
