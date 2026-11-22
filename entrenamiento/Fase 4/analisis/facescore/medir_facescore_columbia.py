"""Medición pre-registrada de la suma cabeza + mirada de `faceScore` contra Columbia Gaze.

Criterios: `Preregistro_ColumbiaGaze.md` §3, adenda §8 y precisiones del §7. Se corre UNA vez.

Orden obligatorio, y cada paso bloquea al siguiente:
  1. Fidelidad: 400 imágenes; `faceScore.js` original = port, con mirada y cabeza
     sola; y las columnas del CSV reproducen las dos decisiones. Si no, se detiene.
  2. Anclas de signo (§2, §7.1). S_P con la matriz detiene todo si |r| < 0,5.
     S_H decide si G4 es concluyente.
  3. G1 (primario), G2 y G3, con la escala común.
  4. G4 (escala de la mirada), G5, G6 y la grilla de casos, descriptivos.

Salida: sólo agregados (`facescore_columbia_resultado.json`). IC por bootstrap de
sujetos (56). Columbia es un montaje con mentonera a 2 m y fotos DSLR: un resultado
positivo NO transfiere solo a la webcam (§1).

ENSAYO: con COLUMBIA_ENSAYO=1 y FACESCORE_SALIDA apuntando a datos inventados
(`ensayo_medir_facescore_columbia.py`). No controla la marca de corrida única.
"""
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
import facescore_ref as fs  # noqa: E402

ENSAYO = os.environ.get("COLUMBIA_ENSAYO") == "1"
SALIDA = os.environ.get("FACESCORE_SALIDA", os.path.join(AQUI, "salida"))
CSV = os.path.join(SALIDA, "facescore_columbia.csv")
MUESTRA = os.path.join(SALIDA, "muestra_columbia.jsonl")
EXTRACCION = os.path.join(SALIDA, "facescore_columbia_extraccion.json")
RESULTADO = os.path.join(SALIDA, "facescore_columbia_resultado.json")

PRODUCTO = os.environ.get("SPARKLE_FRONTEND", os.path.abspath(os.path.join(
    AQUI, "..", "..", "..", "extension_medida", "frontend")))
FACESCORE_JS = os.path.join(PRODUCTO, "src", "offscreen", "faceScore.js")
SHA_JS = "cab6fa04fb5375873304f739225d61cc95075ab83db6e102d628694143cfc5e2"

N_ESPERADO = 5880
N_MUESTRA = 400
LAT, ABAJO, ARRIBA = fs.SIDE_LIMIT, fs.DOWN_LIMIT, fs.UP_LIMIT
GRADOS = fs.GAZE_DEGREES
REPLICAS, SEMILLA = 2000, 42
rng = np.random.default_rng(SEMILLA)
res = dict(preregistro="Preregistro_ColumbiaGaze.md §3, adenda §8 y §7", ensayo=ENSAYO, faceScore_sha256=SHA_JS,
           advertencia="Mentonera, 2 m, fotos DSLR: condiciones más fáciles que la webcam. "
                       "Según la adenda §8 ninguna imagen está fuera de 25°: G1 es especificidad.")


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


def num(col):
    # float() de Python lee exactamente lo que escribió repr(): la fidelidad compara igualdad.
    return np.array([float(x) if x != "" else np.nan for x in col], dtype=float)


def cargar():
    df = pd.read_csv(CSV, dtype=str, keep_default_na=False)
    if df.archivo.duplicated().any():
        raise SystemExit("🔴 El CSV tiene imágenes repetidas.")
    for c in ("P", "V", "H", "detectado", "mitad", "incompleto"):
        df[c] = df[c].astype(int)
    for c in ("yaw_fs", "pitch_fs", "yaw_mat", "pitch_mat", "gaze_x", "gaze_y", "blink"):
        df[c] = num(df[c])
    return df


def tasa_ic(d, exito):
    """Proporción agregada con IC 95 % por bootstrap clusterizado por sujeto."""
    exito = np.asarray(exito, dtype=float)
    if len(d) == 0:
        return dict(n=0, sujetos=0, aciertos=0, p=None, ic=[None, None])
    g = pd.DataFrame(dict(s=d.sujeto.to_numpy(), e=exito)).groupby("s")["e"].agg(["sum", "count"])
    a, n = g["sum"].to_numpy(), g["count"].to_numpy()
    i = rng.integers(0, len(a), (REPLICAS, len(a)))
    nb = n[i].sum(1)
    boot = np.where(nb > 0, a[i].sum(1) / np.maximum(nb, 1), np.nan)
    return dict(n=int(n.sum()), sujetos=int(len(a)), aciertos=int(a.sum()), p=float(a.sum() / n.sum()),
                ic=[float(np.nanpercentile(boot, 2.5)), float(np.nanpercentile(boot, 97.5))])


def escala_comun(m):
    if m["p"] is None:
        return "sin datos"
    if m["p"] >= 0.90 and m["ic"][0] >= 0.85:
        return "✅ ÉXITO"
    return "🟡 se reporta sin declarar éxito" if m["p"] >= 0.85 else "🔴 NEGATIVO"


def mostrar(nombre, m, veredicto=""):
    if m["p"] is None:
        print(f"{nombre:<50} sin datos")
        return
    print(f"{nombre:<50} {m['p']:.4f}  IC [{m['ic'][0]:.4f}, {m['ic'][1]:.4f}]  "
          f"({m['aciertos']}/{m['n']}, {m['sujetos']} sujetos) {veredicto}")


def pendiente_ic(x, y, sujetos):
    """Pendiente por mínimos cuadrados e IC por bootstrap de sujetos (estadísticos suficientes)."""
    t = pd.DataFrame(dict(s=sujetos, x=x, y=y, xy=x * y, xx=x * x)).groupby("s").agg(
        n=("x", "size"), sx=("x", "sum"), sy=("y", "sum"), sxy=("xy", "sum"), sxx=("xx", "sum"))
    M = t.to_numpy()

    def pend(tot):
        n, sx, sy, sxy, sxx = tot
        den = n * sxx - sx * sx
        return (n * sxy - sx * sy) / den if den != 0 else np.nan

    punto = pend(M.sum(0))
    i = rng.integers(0, len(M), (REPLICAS, len(M)))
    boot = np.array([pend(M[fila].sum(0)) for fila in i])
    ic = [float(np.nanpercentile(boot, 2.5)), float(np.nanpercentile(boot, 97.5))]
    return dict(n=int(len(x)), sujetos=int(len(M)), pendiente=float(punto), ic=ic,
                ordenada=float(np.mean(y) - punto * np.mean(x)),
                mae_grados=float(np.mean(np.abs(y - x))), pearson=float(np.corrcoef(x, y)[0, 1]),
                ic_excluye_1=bool(ic[0] > 1 or ic[1] < 1))


# ---------------------------------------------------------------------------
def fidelidad(df):
    titulo("1 — FIDELIDAD DEL PORT CONTRA EL faceScore.js ORIGINAL (400 imágenes)")
    if sha256(FACESCORE_JS) != SHA_JS:
        detener("🔴 faceScore.js no es el congelado.")
    vistos, cand = set(), []
    with open(MUESTRA, encoding="utf-8") as f:
        for linea in f:
            c = json.loads(linea)
            if c["archivo"] not in vistos:     # si la extracción se retomó, puede haber repetidas
                vistos.add(c["archivo"])
                cand.append(c)
    cand.sort(key=lambda c: c["orden"])
    muestra = cand[:N_MUESTRA]
    if len(muestra) < N_MUESTRA:
        detener(f"🔴 Sólo {len(muestra)} candidatas con rostro completo. No se mide.")

    tmp = os.path.join(SALIDA, "_muestra_columbia_tmp.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(muestra, f)
    try:
        js = json.loads(subprocess.run(["node", os.path.join(AQUI, "equivalencia_facescore.mjs"), FACESCORE_JS, tmp],
                                       capture_output=True, text=True, check=True).stdout)
    finally:
        os.remove(tmp)

    def lm_de(c):
        return {int(k): v for k, v in c["lm"].items()}

    py_cab = [fs.en_pantalla(*fs.angulos_cabeza(c["m_col"], lm_de(c))) for c in muestra]
    py_com = [fs.en_pantalla(*fs.angulos_cabeza(c["m_col"], lm_de(c)), c["bs"]) for c in muestra]
    idx = df.set_index("archivo")
    csv_cab, csv_com = [], []
    for c in muestra:
        r = idx.loc[c["archivo"]]
        csv_cab.append(fs.en_pantalla_desde_resumen(r.yaw_fs, r.pitch_fs))
        csv_com.append(fs.en_pantalla_desde_resumen(r.yaw_fs, r.pitch_fs, r.gaze_x, r.gaze_y, r.blink))

    n = len(muestra)
    t = dict(cabeza=sum(a == b for a, b in zip(js["cabeza"], py_cab)) / n,
             completo=sum(a == b for a, b in zip(js["completo"], py_com)) / n,
             csv_cabeza=sum(a == b for a, b in zip(csv_cab, py_cab)) / n,
             csv_completo=sum(a == b for a, b in zip(csv_com, py_com)) / n)
    print(f"imágenes: {n} · en pantalla JS cabeza/completo: {sum(js['cabeza'])} / {sum(js['completo'])}")
    for k, v in t.items():
        print(f"coincidencia {k:<13}: {v:.4f}")
    res["fidelidad"] = dict(n=n, **t, en_pantalla_js=[sum(js["cabeza"]), sum(js["completo"])])
    if any(v != 1.0 for v in t.values()):
        detener("🔴 La fidelidad no es 100 %. No se mide nada (§4).")
    print("✅ 100 % en las cuatro.")


def anclas(d):
    titulo("2 — ANCLAS DE SIGNO (§2, §7.1)")
    a = d[(d.H == 0) & (d.V == 0)]
    r_mat = float(np.corrcoef(a.yaw_mat, a.P)[0, 1])
    r_fs = float(np.corrcoef(a.yaw_fs, a.P)[0, 1])
    print(f"S_P  Pearson yaw de la matriz vs P (H = V = 0, n={len(a)}): {r_mat:+.4f}")
    print(f"S_P  Pearson yaw_fs vs P (el que compone faceScore)       : {r_fs:+.4f}")
    b = d[(d.P == 0) & (d.blink <= fs.EYE_CLOSED_THRESHOLD)]
    r_g = float(np.corrcoef(b.gaze_x, b.H)[0, 1])
    print(f"S_H  Pearson gazeX vs H (P = 0, ojos abiertos, n={len(b)}) : {r_g:+.4f}")
    out = dict(r_yaw_matriz=r_mat, r_yaw_fs=r_fs, r_gaze=r_g, n_cabeza=int(len(a)), n_mirada=int(len(b)),
               signos_coherentes=bool(np.sign(r_mat) == np.sign(r_fs)))
    res["anclas"] = out
    if abs(r_mat) < 0.5:
        detener("🔴 S_P falla: el yaw de la matriz no acompaña a la pose nominal. Se detiene (§2).")
    out["s_P"] = float(np.sign(r_fs))
    out["s_H"] = float(np.sign(r_g))
    out["g4_concluyente"] = bool(abs(r_g) >= 0.5 and abs(r_fs) >= 0.5)
    print(f"✅ S_P: signo {out['s_P']:+.0f} · coherente con la matriz: {out['signos_coherentes']}")
    print(("✅" if out["g4_concluyente"] else "🟡") +
          f" S_H: signo {out['s_H']:+.0f} · G4 {'concluyente' if out['g4_concluyente'] else 'NO CONCLUYENTE'}")
    return out


def main():
    if os.path.exists(RESULTADO) and not ENSAYO:
        raise SystemExit(f"🔴 {RESULTADO} ya existe: la medición se corre UNA vez.")
    with open(EXTRACCION, encoding="utf-8") as f:
        meta = json.load(f)
    df = cargar()
    if len(df) != N_ESPERADO:
        raise SystemExit(f"🔴 El CSV tiene {len(df)} imágenes y el §7 dice {N_ESPERADO}.")
    res["extraccion"] = {k: meta[k] for k in ("modelo", "versiones", "imagenes", "detectadas",
                                              "detectadas_a_la_mitad", "incompletas", "por_pose") if k in meta}
    print(f"imágenes {len(df)} · detectadas {int(df.detectado.sum())} · a la mitad "
          f"{int((df.mitad & df.detectado).sum())} · incompletas {int(df.incompleto.sum())}")

    fidelidad(df)

    # Sin rostro e incompletas: contadas, fuera de G1–G5 (§4).
    d = df[(df.detectado == 1) & (df.incompleto == 0)].copy()
    signos = anclas(d)

    abiertos = (d.blink <= fs.EYE_CLOSED_THRESHOLD).to_numpy()
    d["dir_x"] = d.yaw_fs + np.where(abiertos, d.gaze_x * GRADOS, 0.0)
    d["dir_y"] = d.pitch_fs + np.where(abiertos, d.gaze_y * GRADOS, 0.0)
    d["fuera_completo"] = d.dir_x.abs() > LAT
    d["fuera_cabeza"] = d.yaw_fs.abs() > LAT
    d["verdad_completo"] = d.H.abs() > LAT          # §8: nunca
    d["verdad_cabeza"] = d.P.abs() > LAT            # §7.3: P = ±30

    titulo("3 — G1 (PRIMARIO), G2, G3")
    g1 = tasa_ic(d, d.fuera_completo == d.verdad_completo)
    g1["veredicto"] = escala_comun(g1)
    g1["positivos_de_verdad"] = int(d.verdad_completo.sum())
    g2 = tasa_ic(d, d.fuera_cabeza == d.verdad_cabeza)
    g2["veredicto"] = escala_comun(g2)
    pos, neg = d[d.verdad_cabeza], d[~d.verdad_cabeza]
    g2["sensibilidad"] = tasa_ic(pos, pos.fuera_cabeza)
    g2["especificidad"] = tasa_ic(neg, ~neg.fuera_cabeza)
    esp = tasa_ic(d, ~d.fuera_completo)
    g3 = dict(especificidad=esp, sensibilidad=None,
              nota="Sin positivos (adenda §8): la sensibilidad no es computable. Coincide con G1 por construcción.",
              veredicto="✅ ÉXITO" if esp["p"] is not None and esp["p"] >= 0.90 else "🔴 NO CUMPLE (≥ 0,90)")
    res.update(G1=g1, G2=g2, G3=g3)
    mostrar("G1 acuerdo lateral cabeza + mirada (PRIMARIO)", g1, g1["veredicto"])
    print(f"   positivos de verdad en G1: {g1['positivos_de_verdad']} (esperado 0, adenda §8)")
    mostrar("G2 acuerdo lateral cabeza sola", g2, g2["veredicto"])
    mostrar("   G2 sensibilidad (P = ±30)", g2["sensibilidad"])
    mostrar("   G2 especificidad (|P| ≤ 15)", g2["especificidad"])
    mostrar("G3 especificidad de G1", esp, g3["veredicto"])
    print("   G3 sensibilidad: no computable (sin positivos)")

    titulo("4 — DESCRIPTIVOS: G4 ESCALA DE LA MIRADA, G5, G6, GRILLA")
    g4 = dict(concluyente=signos["g4_concluyente"], ojos_cerrados_excluidas=int((~abiertos).sum()))
    if signos["g4_concluyente"]:
        a = d[abiertos]
        rel = signos["s_H"] * a.H.to_numpy() - signos["s_P"] * a.P.to_numpy()
        y = a.gaze_x.to_numpy() * GRADOS
        g4["todas"] = pendiente_ic(rel, y, a.sujeto.to_numpy())
        c = a.P.to_numpy() == 0
        g4["cabeza_0"] = pendiente_ic(rel[c], y[c], a.sujeto.to_numpy()[c])
        for k in ("cabeza_0", "todas"):
            m = g4[k]
            print(f"G4 {k:<9} pendiente {m['pendiente']:.4f} IC [{m['ic'][0]:.4f}, {m['ic'][1]:.4f}] · "
                  f"MAE {m['mae_grados']:.2f}° · r {m['pearson']:+.3f} · n={m['n']}"
                  + ("  → el IC EXCLUYE 1 (§5)" if m["ic_excluye_1"] else ""))
    else:
        print("G4 no concluyente: el ancla de la mirada no alcanzó |r| ≥ 0,5")
    res["G4"] = g4

    g5 = tasa_ic(d, ~d.dir_y.between(ABAJO, ARRIBA))
    res["G5"] = g5
    mostrar("G5 marcadas fuera por el eje vertical", g5)

    g6 = {}
    for P, sub in df.groupby("P"):
        g6[str(P)] = dict(n=int(len(sub)), deteccion=float(sub.detectado.mean()),
                          a_la_mitad=int((sub.mitad & sub.detectado).sum()), incompletas=int(sub.incompleto.sum()))
        print(f"G6 P={P:>+3}: detección {g6[str(P)]['deteccion']:.4f} · a la mitad {g6[str(P)]['a_la_mitad']}")
    res["G6"] = g6

    grilla = {}
    for (P, H), sub in d.groupby(["P", "H"]):
        grilla[f"P{P:+d}_H{H:+d}"] = dict(n=int(len(sub)), fuera_completo=float(sub.fuera_completo.mean()),
                                          fuera_cabeza=float(sub.fuera_cabeza.mean()))
    res["grilla"] = grilla
    tabla = pd.DataFrame({k: v["fuera_completo"] for k, v in grilla.items()}, index=[0]).T
    tabla.index = pd.MultiIndex.from_tuples([(int(k.split("_")[0][1:]), int(k.split("_")[1][1:])) for k in tabla.index],
                                            names=["P", "H"])
    print("\nGrilla: fracción marcada «fuera» con cabeza + mirada (filas P, columnas H)")
    print(tabla[0].unstack("H").round(3).to_string())

    cambia = d.fuera_completo != d.fuera_cabeza
    res["mirada_cambia_decision"] = dict(fraccion=float(cambia.mean()),
                                         dentro_a_fuera=float((~d.fuera_cabeza & d.fuera_completo).mean()),
                                         fuera_a_dentro=float((d.fuera_cabeza & ~d.fuera_completo).mean()))
    print(f"\nLa mirada cambia la decisión lateral en {cambia.mean():.2%} de las imágenes "
          f"(dentro→fuera {res['mirada_cambia_decision']['dentro_a_fuera']:.2%} · "
          f"fuera→dentro {res['mirada_cambia_decision']['fuera_a_dentro']:.2%})")

    guardar()
    titulo("RESUMEN")
    print(f"G1 (primario): {g1['p']:.4f} → {g1['veredicto']}")
    print(f"G2: {g2['p']:.4f} → {g2['veredicto']}")
    print(f"G3 especificidad: {esp['p']:.4f} → {g3['veredicto']}")
    if signos["g4_concluyente"]:
        print(f"G4 pendiente (todas): {g4['todas']['pendiente']:.4f} · IC excluye 1: {g4['todas']['ic_excluye_1']}")
    print(f"\nguardado -> {RESULTADO}")
    print("Contador de evaluaciones sobre particiones de prueba: sigue en 0 (Columbia no tiene).")


if __name__ == "__main__":
    main()
