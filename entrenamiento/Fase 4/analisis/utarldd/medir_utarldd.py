"""M1 · M2 · M3 · M4 de `Preregistro_UTA_RLDD.md`. Se corre UNA vez, sobre los 5 folds.

QUÉ MIDE
--------
  M1  Especificidad de R2 sobre los 60 videos «alerta»
        exito <= 5 %   ·   intermedio 5-10 %   ·   negativo > 10 %
  M2  Contraste somnoliento vs alerta, con IC bootstrap CLUSTERIZADO POR SUJETO
  M3  Robustez de la línea base autonormalizante (computable en >= 95 % de videos)
  M4  Ancho de rostro cerca de la frontera de detección (descriptivo, sin criterio)

Y el diagnóstico obligatorio de §4: la mediana de la línea base POR NIVEL, más el
análisis secundario con la línea base tomada del video «alerta» del propio sujeto.

🔴 POR QUÉ UNA SOLA VEZ
-----------------------
Los criterios están congelados en el pre-registro. Correr esto por fold, mirar y
decidir si seguir sería elegir el n después de ver datos. La extracción
(`extraer_utarldd.py`) puede correrse fold por fold; la MEDICIÓN no.

🔴 EL CONFUNDIDOR, DECLARADO ANTES DE MEDIR (pre-registro §4)
-------------------------------------------------------------
La línea base de R2 es la mediana de `ear_avg` del propio sujeto. Si el sujeto ya
está somnoliento durante los 30 s de calibración, su línea base BAJA, el umbral
0,30 x base baja con ella, y R2 se activa MENOS. Empuja en contra de lo que M2
predice. Por eso:
  - se reporta SIEMPRE la mediana de la línea base por nivel (§4.1), y
  - se recomputa M2 con la línea base del video «alerta» del sujeto (§4.2), que
    es DIAGNÓSTICO y no primario: el producto no puede hacerlo, porque en
    despliegue no existe un video previo del alumno.

USO
---
    python medir_utarldd.py                 # lee ./salida
    python medir_utarldd.py --salida ./otra
"""
import sys

# La consola de Windows suele venir en cp1252, donde los emoji NO existen: un
# `print` con uno lanza UnicodeEncodeError y aborta el script. Acá eso pasaría
# DESPUES de horas de trabajo, en la línea final del informe. Se fuerza UTF-8 y
# se degrada a `?` en vez de fallar.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import argparse
import csv
import glob
import io
import json
import os

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(AQUI, "..")))
import reglas_geometricas as R   # noqa: E402  (umbrales congelados de R2)

# --- Parámetros del pre-registro §3. NINGUNO se ajusta acá. -------------------
FPS = 6.0
CALIB_SEG = 30.0          # línea base: primeros 30 s de CADA video (Enmienda 5)
VENTANA_SEG = 50.0        # ventana del detector
MAX_SIN_ROSTRO = 0.30     # exclusión de ventana (MAX_SIN_ROSTRO de detector.js)
MIN_DETECCION_VIDEO = 0.70  # exclusión de video
N_BOOT = 2000
UMBRAL_M1_EXITO = 0.05
UMBRAL_M1_NEGATIVO = 0.10
UMBRAL_M3 = 0.95
FRONTERA_ANCHO_PX = 80.0  # referencia heredada de BIWI, NO congelada (Enmienda 2 §4bis.6)

N_CALIB = int(round(CALIB_SEG * FPS))     # 180 muestras
N_VENT = int(round(VENTANA_SEG * FPS))    # 300 muestras


def cargar(salida):
    """Un dict por video: metadatos + arrays de ear_avg, detección y ancho."""
    ruta_v = os.path.join(salida, "videos.csv")
    if not os.path.exists(ruta_v):
        sys.exit(f"ABORTA: falta {ruta_v}. Correr extraer_utarldd.py primero.")

    metas = list(csv.DictReader(io.open(ruta_v, encoding="utf-8")))
    videos = []
    for m in metas:
        # El nombre del CSV se LEE del indice, no se infiere de (fold, sujeto,
        # nivel): un sujeto puede tener mas de una grabacion en un mismo nivel
        # (ver Preregistro §7.bis.1), y la convencion no lo contempla.
        nombre = m.get("csv_cuadros") or f"f{m['fold']}_s{m['sujeto']}_n{m['nivel']}.csv"
        f = os.path.join(salida, "cuadros", nombre)
        if not os.path.exists(f):
            print(f"[!] falta {nombre} — se omite")
            continue
        filas = list(csv.DictReader(io.open(f, encoding="utf-8")))
        ear = np.array([float(r["ear_avg"]) if r["ear_avg"] else np.nan for r in filas])
        det = np.array([r["detectado"] == "1" for r in filas])
        anc = np.array([float(r["ancho_px"]) if r["ancho_px"] else np.nan for r in filas])
        videos.append(dict(
            fold=m["fold"], sujeto=m["sujeto"], nivel=m["nivel"],
            nivel_nombre=m["nivel_nombre"],
            ancho_cuadro=int(m["ancho_cuadro"]), alto_cuadro=int(m["alto_cuadro"]),
            tasa_deteccion=float(m["tasa_deteccion"]), dur_seg=float(m["dur_seg"]),
            ear=ear, det=det, ancho=anc))
    return videos


def linea_base(ear):
    """Mediana de `ear_avg` sobre los primeros 30 s. NaN si no es computable."""
    tramo = ear[:N_CALIB]
    ok = np.isfinite(tramo)
    if ok.sum() == 0:
        return float("nan")
    b = float(np.median(tramo[ok]))
    return b if np.isfinite(b) and b > 0 else float("nan")


def ventanas(v, base):
    """Ventanas de 50 s NO solapadas desde t = 30 s. Devuelve lista de dicts."""
    out = []
    if not np.isfinite(base):
        return out
    ear, det = v["ear"], v["det"]
    ini = N_CALIB
    while ini + N_VENT <= len(ear):
        sl = slice(ini, ini + N_VENT)
        frac_sin = 1.0 - det[sl].mean()
        if frac_sin <= MAX_SIN_ROSTRO:
            seq = ear[sl].reshape(-1, 1)
            disp, info = R.r2_ojos_cerrados(seq, ["ear_avg"], baseline_ear=base)
            out.append(dict(sujeto=v["sujeto"], nivel=v["nivel"], r2=bool(disp),
                            perclos=info["perclos"], micro=info["microsueno_seg"],
                            frac_sin_rostro=float(frac_sin)))
        ini += N_VENT
    return out


def tasa(vs):
    return (sum(w["r2"] for w in vs) / len(vs)) if vs else float("nan")


def boot_dif(vent_a, vent_b, sujetos, semilla=20260828):
    """IC 95 % de tasa(b) - tasa(a), remuestreando SUJETOS con reemplazo.

    Se remuestrean sujetos y no ventanas: las ventanas de un mismo sujeto no son
    independientes, y un bootstrap sobre ventanas daría un IC artificialmente
    angosto. Regla de método del proyecto: todo intervalo se clusteriza por sujeto.
    """
    rng = np.random.default_rng(semilla)
    por_suj_a, por_suj_b = {}, {}
    for w in vent_a:
        por_suj_a.setdefault(w["sujeto"], []).append(w["r2"])
    for w in vent_b:
        por_suj_b.setdefault(w["sujeto"], []).append(w["r2"])

    difs = []
    suj = list(sujetos)
    for _ in range(N_BOOT):
        pick = rng.choice(len(suj), size=len(suj), replace=True)
        a = [x for i in pick for x in por_suj_a.get(suj[i], [])]
        b = [x for i in pick for x in por_suj_b.get(suj[i], [])]
        if not a or not b:
            continue
        difs.append(np.mean(b) - np.mean(a))
    if not difs:
        return float("nan"), float("nan")
    return float(np.percentile(difs, 2.5)), float(np.percentile(difs, 97.5))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--salida", default=os.path.join(AQUI, "salida"))
    args = ap.parse_args()

    videos = cargar(args.salida)
    if not videos:
        sys.exit("ABORTA: no se cargó ningún video.")

    n_sujetos = len({v["sujeto"] for v in videos})
    print("=" * 74)
    print(f"UTA-RLDD — {len(videos)} videos · {n_sujetos} sujetos")
    print("=" * 74)
    if n_sujetos < 60:
        # No aborta: informa. Correr con folds incompletos es válido para
        # depurar, pero el resultado NO es el del pre-registro.
        print(f"[!] El pre-registro contempla 180 videos de 60 sujetos. Hay "
              f"{len(videos)} de {n_sujetos}.\n"
              f"    Estos números son PARCIALES y no deben reportarse como M1-M4.")

    # --- exclusión de videos por detección ------------------------------------
    excl = [v for v in videos if v["tasa_deteccion"] < MIN_DETECCION_VIDEO]
    usados = [v for v in videos if v["tasa_deteccion"] >= MIN_DETECCION_VIDEO]
    print(f"\nVideos excluidos por detección < {MIN_DETECCION_VIDEO:.0%}: "
          f"{len(excl)} de {len(videos)}")
    for v in excl:
        print(f"   sujeto {v['sujeto']} nivel {v['nivel']:>2} · "
              f"detección {100*v['tasa_deteccion']:5.1f} % · "
              f"{v['ancho_cuadro']}x{v['alto_cuadro']}")
    if excl:
        print("   >>> Es un RESULTADO, no una molestia (pre-registro §2.4). No se")
        print("       baja el umbral de exclusión para recuperarlos.")

    # --- línea base y ventanas -------------------------------------------------
    for v in usados:
        v["base"] = linea_base(v["ear"])
        v["vent"] = ventanas(v, v["base"])

    # --- M3 -------------------------------------------------------------------
    computables = [v for v in usados if np.isfinite(v["base"])]
    m3 = len(computables) / len(usados) if usados else float("nan")
    intra = []
    for s in sorted({v["sujeto"] for v in computables}):
        bs = [v["base"] for v in computables if v["sujeto"] == s]
        if len(bs) >= 2:
            intra.append(np.std(bs))
    inter = np.std([v["base"] for v in computables]) if computables else float("nan")

    print(f"\n{'-'*74}\nM3 — robustez de la línea base\n{'-'*74}")
    print(f"  computable en {len(computables)}/{len(usados)} videos = {m3:.4f}"
          f"   (criterio >= {UMBRAL_M3:.2f})   {'OK' if m3 >= UMBRAL_M3 else 'NO CUMPLE'}")
    if intra:
        print(f"  desvío intra-sujeto (medio) : {np.mean(intra):.4f}")
        print(f"  desvío entre sujetos        : {inter:.4f}")
        print(f"  cociente intra/entre        : {np.mean(intra)/inter:.3f}"
              f"   (descriptivo, sin umbral)")

    # --- M1 -------------------------------------------------------------------
    v0 = [v for v in usados if v["nivel"] == "0"]
    w0 = [w for v in v0 for w in v["vent"]]
    m1 = tasa(w0)
    suj_con = len({w["sujeto"] for w in w0 if w["r2"]})
    veredicto = ("EXITO" if m1 <= UMBRAL_M1_EXITO else
                 "NEGATIVO" if m1 > UMBRAL_M1_NEGATIVO else "ZONA INTERMEDIA")

    print(f"\n{'-'*74}\nM1 — especificidad de R2 sobre los videos «alerta»\n{'-'*74}")
    print(f"  videos            : {len(v0)}")
    print(f"  ventanas          : {len(w0)}   (referencia DAiSEE: 975)")
    print(f"  R2 se activa      : {sum(w['r2'] for w in w0)}")
    print(f"  TASA              : {m1:.4f}  ({100*m1:.2f} %)")
    print(f"  referencia DAiSEE : 0,00615  (0,615 %)")
    print(f"  VEREDICTO         : {veredicto}"
          f"   [exito <= {UMBRAL_M1_EXITO:.0%} · negativo > {UMBRAL_M1_NEGATIVO:.0%}]")
    print(f"  sujetos con >= 1 activación: {suj_con} de {len({w['sujeto'] for w in w0})}")
    if sum(w["r2"] for w in w0) and suj_con:
        print(f"  (concentración: {sum(w['r2'] for w in w0)/suj_con:.1f} activaciones "
              f"por sujeto afectado — repartidas y concentradas son resultados distintos)")

    # --- M2 + diagnóstico §4 ---------------------------------------------------
    v10 = [v for v in usados if v["nivel"] == "10"]
    v5 = [v for v in usados if v["nivel"] == "5"]
    w10 = [w for v in v10 for w in v["vent"]]
    w5 = [w for v in v5 for w in v["vent"]]
    t0, t5, t10 = tasa(w0), tasa(w5), tasa(w10)
    dif = t10 - t0
    sujetos = sorted({v["sujeto"] for v in usados})
    lo, hi = boot_dif(w0, w10, sujetos)
    cumple = np.isfinite(lo) and lo > 0

    print(f"\n{'-'*74}\nM2 — contraste somnoliento vs alerta\n{'-'*74}")
    print(f"  alerta (0)          : {t0:.4f}   ({len(w0)} ventanas)")
    print(f"  vigilancia baja (5) : {t5:.4f}   ({len(w5)} ventanas)")
    print(f"  somnoliento (10)    : {t10:.4f}   ({len(w10)} ventanas)")
    print(f"  diferencia 10 - 0   : {dif:+.4f}")
    print(f"  IC 95 % (bootstrap por sujeto, {N_BOOT} réplicas): [{lo:+.4f}, {hi:+.4f}]")
    print(f"  CRITERIO (dif > 0 y el IC excluye el 0): {'CUMPLE' if cumple else 'NO CUMPLE'}")
    mono = t0 < t5 < t10
    print(f"  monotonía 0 < 5 < 10: {'sí' if mono else 'no'}"
          f"   [descriptivo — al azar sale monótona 1 de cada 6 veces]")

    print(f"\n  >>> DIAGNÓSTICO OBLIGATORIO del confundidor (pre-registro §4.1)")
    bases = {}
    for niv, vs in (("0", v0), ("5", v5), ("10", v10)):
        b = [v["base"] for v in vs if np.isfinite(v["base"])]
        bases[niv] = float(np.median(b)) if b else float("nan")
        print(f"      mediana de la línea base, nivel {niv:>2} : {bases[niv]:.4f}")
    corrida = (np.isfinite(bases['0']) and np.isfinite(bases['10'])
               and bases["10"] < bases["0"])
    if corrida:
        print("      >>> LA LÍNEA BASE BAJA CON LA SOMNOLENCIA. El confundidor OPERA:")
        print("          empuja a R2 a activarse MENOS en los videos somnolientos, o sea")
        print("          EN CONTRA de M2. M2 se lee a través de esto.")
    else:
        print("      >>> La línea base no desciende con el nivel: el confundidor no")
        print("          explica el resultado de M2 por esta vía.")

    # --- §4.2 análisis secundario ---------------------------------------------
    base_alerta = {v["sujeto"]: v["base"] for v in v0 if np.isfinite(v["base"])}
    w0b, w10b = [], []
    for v in usados:
        b = base_alerta.get(v["sujeto"])
        if b is None or not np.isfinite(b):
            continue
        if v["nivel"] == "0":
            w0b += ventanas(v, b)
        elif v["nivel"] == "10":
            w10b += ventanas(v, b)
    t0b, t10b = tasa(w0b), tasa(w10b)
    lob, hib = boot_dif(w0b, w10b, sujetos)

    print(f"\n  >>> SECUNDARIO §4.2 — línea base del video «alerta» del propio sujeto")
    print(f"      alerta {t0b:.4f} · somnoliento {t10b:.4f} · "
          f"dif {t10b - t0b:+.4f}  IC [{lob:+.4f}, {hib:+.4f}]")
    print("      ⚠️ DIAGNÓSTICO, NO PRIMARIO. El producto no puede hacer esto: en")
    print("         despliegue no existe un video previo del alumno.")

    # --- M4 -------------------------------------------------------------------
    print(f"\n{'-'*74}\nM4 — ancho de rostro cerca de la frontera (descriptivo)\n{'-'*74}")
    anchos_med = [(v, float(np.nanmedian(v["ancho"]))) for v in videos
                  if np.isfinite(v["ancho"]).any()]
    todos = np.concatenate([v["ancho"][np.isfinite(v["ancho"])] for v in videos
                            if np.isfinite(v["ancho"]).any()])
    if todos.size:
        p5, p50, p95 = np.percentile(todos, [5, 50, 95])
        print(f"  por cuadro detectado — p5 {p5:.1f} px · p50 {p50:.1f} px · p95 {p95:.1f} px")
        print(f"  fracción de cuadros bajo {FRONTERA_ANCHO_PX:.0f} px: "
              f"{100*(todos < FRONTERA_ANCHO_PX).mean():.2f} %")
        print(f"  referencia EngageNet: p5 = 179,6 px · 0 % bajo 80 px")
    bajos = [(v, a) for v, a in anchos_med if a < FRONTERA_ANCHO_PX]
    print(f"\n  videos con ancho de rostro MEDIANO bajo {FRONTERA_ANCHO_PX:.0f} px: "
          f"{len(bajos)} de {len(anchos_med)}")
    for v, a in sorted(bajos, key=lambda x: x[1])[:15]:
        print(f"     sujeto {v['sujeto']} nivel {v['nivel']:>2} · ancho {a:6.1f} px · "
              f"detección {100*v['tasa_deteccion']:5.1f} % · "
              f"{v['ancho_cuadro']}x{v['alto_cuadro']}")
    print("\n  ⚠️ El ancho sólo se mide en los cuadros DETECTADOS. La detección de un")
    print("     video se relaciona con su ancho MEDIANO, no cuadro a cuadro: en los")
    print("     cuadros sin detección no hay malla y por lo tanto no hay ancho.")
    print("     Es la misma limitación que Enmienda 2 §4bis.6 declara.")
    print("  ⚠️ M4 NO congela ningún umbral. Congelarlo exige enmienda propia.")

    # --- salida ----------------------------------------------------------------
    res = dict(
        n_videos=len(videos), n_sujetos=n_sujetos, completo=(n_sujetos >= 60),
        excluidos_por_deteccion=[dict(sujeto=v["sujeto"], nivel=v["nivel"],
                                      deteccion=v["tasa_deteccion"],
                                      resolucion=f"{v['ancho_cuadro']}x{v['alto_cuadro']}")
                                 for v in excl],
        M1=dict(tasa=m1, n_ventanas=len(w0), n_videos=len(v0),
                activaciones=int(sum(w["r2"] for w in w0)), veredicto=veredicto,
                referencia_daisee=0.00615),
        M2=dict(tasa_0=t0, tasa_5=t5, tasa_10=t10, diferencia=dif,
                ic95=[lo, hi], cumple=bool(cumple), monotona=bool(mono)),
        diagnostico_confundidor=dict(mediana_base_por_nivel=bases,
                                     base_desciende_con_somnolencia=bool(corrida)),
        secundario_base_alerta=dict(tasa_0=t0b, tasa_10=t10b,
                                    diferencia=t10b - t0b, ic95=[lob, hib]),
        M3=dict(fraccion_computable=m3, cumple=bool(m3 >= UMBRAL_M3),
                desvio_intra_medio=float(np.mean(intra)) if intra else None,
                desvio_entre=float(inter) if computables else None),
        M4=dict(p5=float(p5) if todos.size else None,
                p50=float(p50) if todos.size else None,
                p95=float(p95) if todos.size else None,
                frac_bajo_80px=float((todos < FRONTERA_ANCHO_PX).mean()) if todos.size else None,
                videos_mediana_bajo_80px=len(bajos)),
    )
    destino = os.path.join(args.salida, "utarldd_resultado.json")
    with io.open(destino, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2, ensure_ascii=False)
    print(f"\nresumen -> {destino}")
    print("\nContador de evaluaciones sobre particiones de prueba: sigue en 0.")


if __name__ == "__main__":
    main()
