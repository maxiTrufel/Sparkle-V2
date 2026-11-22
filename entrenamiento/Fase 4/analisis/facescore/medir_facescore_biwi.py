"""Medición pre-registrada de la capa geométrica desplegada (`faceScore`) contra BIWI.

Criterios: `Preregistro_FaceScore.md` §2 y §3, congelado el 2026-09-14 antes de
correr esto. Se corre UNA vez.

Orden obligatorio, y cada paso bloquea al siguiente:
  1. Fidelidad: el port coincide con el `faceScore.js` original en el 100 % de
     la muestra, en las dos variantes. Si no, se detiene sin medir.
  2. Convención de signo: S1 (ejes) detiene todo si falla; S2 (qué es "abajo")
     decide si el eje vertical es concluyente.
  3. B1–B5, con sus criterios.
  4. D1–D5, descriptivos.
"""
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

SALIDA = os.path.join(AQUI, "salida")
CSV = os.path.join(SALIDA, "facescore_biwi.csv")
MUESTRA = os.path.join(SALIDA, "muestra_equivalencia.json")
RESULTADO = os.path.join(SALIDA, "facescore_biwi_resultado.json")

REPLICAS = 2000
SEMILLA = 42
LAT, ABAJO, ARRIBA = fs.SIDE_LIMIT, fs.DOWN_LIMIT, fs.UP_LIMIT

rng = np.random.default_rng(SEMILLA)
res = {"preregistro": "Preregistro_FaceScore.md", "faceScore_sha256": SHA_JS}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def titulo(texto):
    print("\n" + "=" * 70 + f"\n{texto}\n" + "=" * 70)


# ---------------------------------------------------------------------------
# 1. Fidelidad
# ---------------------------------------------------------------------------
def fidelidad(df):
    titulo("§2 — FIDELIDAD DEL PORT CONTRA EL faceScore.js ORIGINAL")
    sha = sha256(FACESCORE_JS)
    if sha != SHA_JS:
        raise SystemExit(f"🔴 faceScore.js no es el congelado.\n   esperado {SHA_JS}\n   leído    {sha}")
    print("SHA-256 de faceScore.js: coincide con el congelado")

    muestra = json.load(open(MUESTRA, encoding="utf-8"))
    salida = subprocess.run(
        ["node", os.path.join(AQUI, "equivalencia_facescore.mjs"), FACESCORE_JS, MUESTRA],
        capture_output=True, text=True, check=True)
    js = json.loads(salida.stdout)

    def lm_de(c):
        return {int(k): v for k, v in c["lm"].items()}

    py_cabeza = [fs.en_pantalla(*fs.angulos_cabeza(c["m_col"], lm_de(c))) for c in muestra]
    py_completo = [fs.en_pantalla(*fs.angulos_cabeza(c["m_col"], lm_de(c)), c["bs"]) for c in muestra]

    # Además: que las columnas del CSV reproduzcan la decisión calculada desde
    # los valores crudos. Si no, el CSV no describe lo que se verificó.
    idx = df.set_index(["secuencia", "cuadro"])
    csv_cabeza = []
    for c in muestra:
        f = idx.loc[(int(c["secuencia"]) if df.secuencia.dtype != object else c["secuencia"], c["cuadro"])]
        csv_cabeza.append(fs.en_pantalla_desde_resumen(f.yaw_fs, f.pitch_fs))

    n = len(muestra)
    c1 = sum(a == b for a, b in zip(js["cabeza"], py_cabeza)) / n
    c2 = sum(a == b for a, b in zip(js["completo"], py_completo)) / n
    c3 = sum(a == b for a, b in zip(csv_cabeza, py_cabeza)) / n
    print(f"cuadros en la muestra             : {n}")
    print(f"  en pantalla (JS, cabeza/completo): {sum(js['cabeza'])} / {sum(js['completo'])}")
    print(f"coincidencia cabeza sola          : {c1:.4f}")
    print(f"coincidencia completa             : {c2:.4f}")
    print(f"CSV reproduce la decisión cruda   : {c3:.4f}")
    res["fidelidad"] = dict(n=n, cabeza=c1, completo=c2, csv=c3,
                            en_pantalla_js=[sum(js["cabeza"]), sum(js["completo"])])
    if not (c1 == 1.0 and c2 == 1.0 and c3 == 1.0):
        guardar()
        raise SystemExit("🔴 La fidelidad no es 100 %. No se mide nada (Preregistro §2).")
    print("✅ 100 % en las tres. Se puede medir.")


# ---------------------------------------------------------------------------
# utilidades
# ---------------------------------------------------------------------------
def tasa_ic(d, exito):
    """Proporción agregada y su IC 95 % por bootstrap clusterizado por secuencia.

    La réplica remuestrea SECUENCIAS y recalcula suma/suma: cada secuencia pesa
    lo que pesan sus cuadros, como en la cifra puntual.
    """
    g = d.assign(_e=exito.astype(float)).groupby("secuencia")["_e"].agg(["sum", "count"])
    num, den = g["sum"].to_numpy(), g["count"].to_numpy()
    if den.sum() == 0:
        return dict(n=0, secuencias=0, p=None, ic=[None, None])
    k = len(num)
    i = rng.integers(0, k, (REPLICAS, k))
    d_b = den[i].sum(1)
    boot = np.where(d_b > 0, num[i].sum(1) / np.maximum(d_b, 1), np.nan)
    return dict(n=int(den.sum()), secuencias=int(k), p=float(num.sum() / den.sum()),
                ic=[float(np.nanpercentile(boot, 2.5)), float(np.nanpercentile(boot, 97.5))])


def por_secuencia(d, exito):
    g = d.assign(_e=exito.astype(float)).groupby("secuencia")["_e"].agg(["mean", "count"])
    return {str(s): dict(tasa=float(r["mean"]), n=int(r["count"])) for s, r in g.iterrows()}


def veredicto_acuerdo(m):
    if m["p"] is None:
        return "sin datos"
    if m["p"] >= 0.90 and m["ic"][0] >= 0.85:
        return "✅ ÉXITO"
    if m["p"] >= 0.85:
        return "🟡 se reporta sin declarar éxito"
    return "🔴 NEGATIVO"


def veredicto_b4(m):
    if m["p"] is None:
        return "sin datos"
    return "✅ ÉXITO" if m["p"] <= 0.10 else ("🟡 zona intermedia" if m["p"] <= 0.25 else "🔴 NEGATIVO")


def mostrar(nombre, m, veredicto=None):
    if m["p"] is None:
        print(f"{nombre:<46} sin datos"); return
    extra = f"   {veredicto}" if veredicto else ""
    print(f"{nombre:<46} {m['p']:.4f}  IC [{m['ic'][0]:.4f}, {m['ic'][1]:.4f}]  "
          f"n={m['n']} · {m['secuencias']} sec{extra}")


def guardar():
    with open(RESULTADO, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
def main():
    df = pd.read_csv(CSV, dtype={"secuencia": str, "cuadro": str})
    print(f"pares: {len(df)} · secuencias: {df.secuencia.nunique()} · "
          f"con rostro: {int(df.detectado.sum())} · incompletos: {int(df.incompleto.sum())}")
    res["conjunto"] = dict(pares=int(len(df)), secuencias=int(df.secuencia.nunique()),
                           detectados=int(df.detectado.sum()), incompletos=int(df.incompleto.sum()))

    fidelidad(df)

    # Un cuadro "incompleto" no lo registra el JS. Se excluye de todo y queda contado.
    df = df[df.incompleto == 0].copy()
    det = df.detectado == 1

    # -----------------------------------------------------------------------
    titulo("§3.2 — CONVENCIÓN DE SIGNO")
    d = df[det]
    r_yaw = float(np.corrcoef(d.yaw_mat, d.yaw_gt)[0, 1])
    r_pitch = float(np.corrcoef(d.pitch_mat, d.pitch_gt)[0, 1])
    print(f"S1  Pearson yaw (matriz vs sensor)   : {r_yaw:+.4f}")
    print(f"S1  Pearson pitch (matriz vs sensor) : {r_pitch:+.4f}")
    res["S1"] = dict(r_yaw=r_yaw, r_pitch=r_pitch)
    if abs(r_yaw) < 0.5 or abs(r_pitch) < 0.5:
        guardar()
        raise SystemExit("🔴 S1 falla: los ejes no se corresponden. Se detiene (Preregistro §3.2).")
    print("✅ S1: ejes correspondidos")

    ok = d.nariz_cociente.replace([np.inf, -np.inf], np.nan).notna()
    rho = float(d[ok].pitch_gt.corr(d[ok].nariz_cociente, method="spearman"))
    vertical = abs(rho) >= 0.3
    # rho > 0: pitch_gt mayor <-> nariz más cerca de la boca <-> abajo. Abajo tiene
    # que quedar NEGATIVO, que es la convención de faceScore.
    signo = (-1.0 if rho > 0 else 1.0) if vertical else None
    print(f"S2  Spearman pitch_gt vs cociente de nariz: {rho:+.4f}")
    res["S2"] = dict(rho=rho, concluyente=bool(vertical), signo_gt=signo)
    if vertical:
        print(f"✅ S2: abajo = pitch_gt {'positivo' if rho > 0 else 'negativo'} "
              f"-> se multiplica por {signo:+.0f}")
    else:
        print("🟡 S2 NO CONCLUYENTE: el eje vertical no se valida con BIWI (Preregistro §3.2)")

    # -----------------------------------------------------------------------
    df["gt_lat_fuera"] = df.yaw_gt.abs() > LAT
    df["fs_lat_fuera"] = det & (df.yaw_fs.abs() > LAT)
    if vertical:
        df["pgt"] = signo * df.pitch_gt
        df["gt_vert_fuera"] = ~df.pgt.between(ABAJO, ARRIBA)
        df["gt_en_pantalla"] = ~df.gt_lat_fuera & ~df.gt_vert_fuera
        df["fs_vert_fuera"] = det & ~df.pitch_fs.between(ABAJO, ARRIBA)
    # La decisión de faceScore, cabeza sola; un cuadro sin rostro es "fuera" (C6).
    df["fs_en_pantalla"] = det & df.apply(
        lambda f: fs.en_pantalla_desde_resumen(f.yaw_fs, f.pitch_fs) if f.detectado == 1 else False,
        axis=1)

    def bloque_b(sub, etiqueta):
        titulo(f"§3.3 — MÉTRICAS  ({etiqueta})")
        out = {}
        sd = sub[sub.detectado == 1]
        out["B1"] = tasa_ic(sd, sd.fs_lat_fuera == sd.gt_lat_fuera)
        mostrar("B1  acuerdo lateral |yaw| > 25°", out["B1"], veredicto_acuerdo(out["B1"]))
        if vertical:
            out["B2"] = tasa_ic(sd, sd.fs_vert_fuera == sd.gt_vert_fuera)
            mostrar("B2  acuerdo vertical [−20°, 25°]", out["B2"], veredicto_acuerdo(out["B2"]))
            out["B3"] = tasa_ic(sd, sd.fs_en_pantalla == sd.gt_en_pantalla)
            mostrar("B3  acuerdo en pantalla (PRIMARIO)", out["B3"], veredicto_acuerdo(out["B3"]))

            pob = sub[sub.gt_en_pantalla]
            out["B4"] = tasa_ic(pob, ~pob.fs_en_pantalla)
            mostrar("B4  falsa salida extremo a extremo (PRIM.)", out["B4"], veredicto_b4(out["B4"]))
            ps = por_secuencia(pob, ~pob.fs_en_pantalla)
            peores = {s: v for s, v in ps.items() if v["tasa"] > 0.50}
            out["B4_por_secuencia"] = ps
            out["B4_secuencias_sobre_050"] = sorted(peores)
            print(f"    máx. por secuencia: {max(v['tasa'] for v in ps.values()):.4f} · "
                  f"secuencias > 0,50: {sorted(peores) if peores else 'ninguna'}"
                  + ("   🔴 MODO DE FALLA (Preregistro §3.3)" if peores else ""))

            pob5 = sd[~sd.gt_en_pantalla]
            out["B5"] = tasa_ic(pob5, ~pob5.fs_en_pantalla)
            v5 = "sin datos" if out["B5"]["p"] is None else ("✅ ÉXITO" if out["B5"]["p"] >= 0.90 else "❌ no cumple")
            mostrar("B5  sensibilidad condicionada a detección", out["B5"], v5)
            pob5e = sub[~sub.gt_en_pantalla]
            out["B5_extremo_a_extremo"] = tasa_ic(pob5e, ~pob5e.fs_en_pantalla)
            mostrar("    extremo a extremo (descriptiva, por construcción)", out["B5_extremo_a_extremo"])
        else:
            pob = sub[~sub.gt_lat_fuera]
            out["B4_lateral"] = tasa_ic(pob, (pob.detectado == 0) | pob.fs_lat_fuera)
            mostrar("B4  sólo lateral (descriptiva)", out["B4_lateral"])
            pob5 = sd[sd.gt_lat_fuera]
            out["B5_lateral"] = tasa_ic(pob5, pob5.fs_lat_fuera)
            mostrar("B5  sólo lateral (descriptiva)", out["B5_lateral"])
        return out

    res["rango_completo"] = bloque_b(df, "rango completo — PRIMARIO")
    res["rango_45"] = bloque_b(df[df.yaw_gt.abs() <= 45], "|yaw_gt| ≤ 45° — secundario")

    # -----------------------------------------------------------------------
    titulo("§3.4 — DESCRIPTIVOS")
    d = df[det].copy()
    desc = {}
    if vertical:
        err = d.pitch_fs - d.pgt
        desc["D1"] = dict(mae=float(err.abs().mean()), sesgo=float(err.mean()),
                          p90=float(err.abs().quantile(0.90)))
        d45 = d[d.pgt.abs() <= 45]
        pend = float(np.polyfit(d45.pgt, d45.pitch_fs, 1)[0])
        secs = d45.secuencia.unique()
        grupos = {s: d45[d45.secuencia == s] for s in secs}
        boot = []
        for _ in range(REPLICAS):
            m = pd.concat([grupos[s] for s in rng.choice(secs, len(secs))])
            boot.append(np.polyfit(m.pgt, m.pitch_fs, 1)[0])
        desc["D1"]["pendiente_45"] = pend
        desc["D1"]["pendiente_ic"] = [float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))]
        print(f"D1  pitch: MAE {desc['D1']['mae']:.2f}° · sesgo {desc['D1']['sesgo']:+.2f}° · "
              f"p90 {desc['D1']['p90']:.2f}° · pendiente {pend:.4f} "
              f"IC [{desc['D1']['pendiente_ic'][0]:.4f}, {desc['D1']['pendiente_ic'][1]:.4f}]")

        s = d[d.pgt.abs() > 10]
        desc["D2"] = tasa_ic(s, np.sign(s.pitch_fs) == np.sign(s.pgt))
        mostrar("D2  signo de C3 correcto (|pitch| > 10°)", desc["D2"])

    completo = d.apply(lambda f: fs.en_pantalla_desde_resumen(
        f.yaw_fs, f.pitch_fs, f.gaze_x, f.gaze_y, f.blink), axis=1)
    cambia = completo != d.fs_en_pantalla
    desc["D3"] = dict(cambia=float(cambia.mean()),
                      dentro_a_fuera=float((d.fs_en_pantalla & ~completo).mean()),
                      fuera_a_dentro=float((~d.fs_en_pantalla & completo).mean()))
    print(f"D3  la mirada cambia la decisión en {desc['D3']['cambia']:.2%} de los cuadros "
          f"(dentro→fuera {desc['D3']['dentro_a_fuera']:.2%} · fuera→dentro {desc['D3']['fuera_a_dentro']:.2%})"
          "  — NO es error: BIWI no tiene ground truth de mirada")
    desc["D4"] = float((d.blink > fs.EYE_CLOSED_THRESHOLD).mean())
    print(f"D4  cuadros con eyeBlink medio > 0,5: {desc['D4']:.2%}")

    g = df.groupby("secuencia").agg(tz=("tz_mm", "mean"), deteccion=("detectado", "mean"))
    clave = "B4_por_secuencia" if vertical else None
    if clave:
        g["b4"] = [res["rango_completo"][clave][str(sq)]["tasa"] for sq in g.index]
        desc["D5"] = dict(spearman_tz_b4=float(g.tz.corr(g.b4, method="spearman")),
                          por_secuencia={str(sq): dict(tz_mm=float(r.tz), deteccion=float(r.deteccion),
                                                       b4=float(r.b4)) for sq, r in g.iterrows()})
        print(f"D5  Spearman distancia al Kinect vs B4 por secuencia: {desc['D5']['spearman_tz_b4']:+.3f}")
    res["descriptivos"] = desc

    guardar()
    print(f"\nresultado -> {RESULTADO}")
    print("Contador de evaluaciones sobre particiones de prueba: sigue en 0.")


if __name__ == "__main__":
    main()
