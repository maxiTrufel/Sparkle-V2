"""Fase 4.0 — Validación del yaw de MediaPipe contra BIWI.

Ejecución local del notebook `Sparkle_V2_Fase4_0_Validacion_Yaw_BIWI.ipynb`
(escrito para Colab). Misma metodología, mismos criterios congelados:
  - convención de Euler idéntica para ambas fuentes (`euler_desde_R`)
  - verificación de signo ANTES de medir el error
  - umbral 20° de `Protocolo_Reglas_Geometricas.md` §2.1
  - regresión de escala yaw_mp = a + b*yaw_gt con IC bootstrap
  - IC clusterizado POR SUJETO (regla 3 del protocolo)

Valida la afirmación A del Anexo G: "el yaw que devuelve MediaPipe es preciso
en grados".
"""
import os, glob, math, json
import numpy as np
import pandas as pd
import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

AQUI = os.path.dirname(os.path.abspath(__file__))
BIWI = os.path.join(AQUI, "biwi")
MODELO = os.path.join(AQUI, "fl_v1.task")   # idéntico al que despacha la extensión (SHA-256 verificado)
UMBRAL = 20.0                                # congelado en Protocolo_Reglas_Geometricas.md §2.1
SALIDA = os.path.join(AQUI, "biwi_yaw.csv")


def euler_desde_R(R):
    """(yaw, pitch, roll) en grados. Convención fija para ambas fuentes."""
    sy = math.sqrt(R[0, 0] ** 2 + R[1, 0] ** 2)
    if sy > 1e-6:
        x = math.atan2(R[2, 1], R[2, 2])   # pitch
        y = math.atan2(-R[2, 0], sy)       # yaw
        z = math.atan2(R[1, 0], R[0, 0])   # roll
    else:
        x = math.atan2(-R[1, 2], R[1, 1]); y = math.atan2(-R[2, 0], sy); z = 0.0
    return math.degrees(y), math.degrees(x), math.degrees(z)


def leer_pose_biwi(path):
    v = np.loadtxt(path)
    R = v[:3, :3] if v.shape[0] >= 3 else np.array(v[:9]).reshape(3, 3)
    return euler_desde_R(R)


def armar_pares():
    pares = []
    for pz in glob.glob(os.path.join(BIWI, "**", "*_pose.txt"), recursive=True):
        for ext in ("_rgb.png", "_rgb.jpg"):
            img = pz.replace("_pose.txt", ext)
            if os.path.exists(img):
                pares.append((img, pz, os.path.basename(os.path.dirname(img))))
                break
    return sorted(pares)


def extraer(pares):
    opts = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODELO),
        output_facial_transformation_matrixes=True,   # la vía que usa la extensión
        num_faces=1)
    landmarker = vision.FaceLandmarker.create_from_options(opts)

    filas, perdidos, sin_rostro = [], [], 0
    for k, (img_p, pose_p, sujeto) in enumerate(pares):
        bgr = cv2.imread(img_p)
        if bgr is None:
            continue
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB,
                          data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        res = landmarker.detect(mp_img)
        if not res.facial_transformation_matrixes:
            # Registrar el yaw REAL de los cuadros donde MediaPipe no ve cara.
            # Sin esto no se puede saber SI la detección falla justo en el
            # régimen donde R1 debería disparar (giros grandes).
            yaw_gt_perdido, _, _ = leer_pose_biwi(pose_p)
            perdidos.append(dict(sujeto=sujeto, yaw_gt=yaw_gt_perdido))
            sin_rostro += 1
            continue
        M = np.array(res.facial_transformation_matrixes[0]).reshape(4, 4)
        yaw_mp, pitch_mp, roll_mp = euler_desde_R(M[:3, :3])
        yaw_gt, pitch_gt, roll_gt = leer_pose_biwi(pose_p)
        filas.append(dict(sujeto=sujeto, yaw_mp=yaw_mp, yaw_gt=yaw_gt,
                          pitch_mp=pitch_mp, pitch_gt=pitch_gt))
        if (k + 1) % 2000 == 0:
            print(f"  {k+1}/{len(pares)} procesadas ({sin_rostro} sin rostro)", flush=True)

    print(f"\nprocesadas: {len(filas)} | sin rostro: {sin_rostro} "
          f"({sin_rostro/max(1,len(pares)):.2%} del total)")
    return pd.DataFrame(filas), pd.DataFrame(perdidos), sin_rostro


def tasa_deteccion_por_angulo(df, dfp):
    """Tasa de detección de rostro por franja de |yaw| real.

    Es la medición que decide si R1 es aplicable en el régimen que le
    importa: si MediaPipe pierde la cara justo cuando el sujeto gira mucho,
    esos cuadros no llegan a la regla como 'desviados' sino como ausentes.
    """
    print("\n--- Tasa de detección de rostro por |yaw| real ---")
    print("  franja        detectados   perdidos   tasa")
    bordes = [(0, 10), (10, 20), (20, 30), (30, 45), (45, 60), (60, 200)]
    filas = []
    for lo, hi in bordes:
        det = ((df.yaw_gt.abs() >= lo) & (df.yaw_gt.abs() < hi)).sum()
        per = ((dfp.yaw_gt.abs() >= lo) & (dfp.yaw_gt.abs() < hi)).sum() if len(dfp) else 0
        tot = det + per
        tasa = det / tot if tot else float("nan")
        etiqueta = f"{lo}-{hi}°" if hi < 200 else f">{lo}°"
        print(f"  {etiqueta:12s} {det:10d} {per:10d}   {tasa:6.1%}")
        filas.append(dict(franja=etiqueta, detectados=int(det),
                          perdidos=int(per), tasa=float(tasa)))
    return filas


def reporte(d, nombre):
    if len(d) == 0:
        print(f"{nombre}: sin datos"); return None
    err = d.yaw_mp - d.yaw_gt
    mae, bias = err.abs().mean(), err.mean()
    fuera_gt, fuera_mp = d.yaw_gt.abs() > UMBRAL, d.yaw_mp.abs() > UMBRAL
    acc = (fuera_gt == fuera_mp).mean()
    fp = ((~fuera_gt) & fuera_mp).sum() / max(1, (~fuera_gt).sum())
    fn = (fuera_gt & (~fuera_mp)).sum() / max(1, fuera_gt.sum())
    print(f"\n--- {nombre}  (n={len(d)}) ---")
    print(f"  MAE          : {mae:6.2f}°     sesgo: {bias:+.2f}°")
    print(f"  p90 |error|  : {err.abs().quantile(.90):6.2f}°")
    print(f"  ACUERDO de la decisión |yaw|>{UMBRAL:.0f}° : {acc:.4f}")
    print(f"    falsos positivos (GT dentro, MP fuera) : {fp:.4f}")
    print(f"    falsos negativos (GT fuera, MP dentro) : {fn:.4f}")
    return dict(n=int(len(d)), mae=float(mae), sesgo=float(bias),
                p90=float(err.abs().quantile(.90)), acuerdo=float(acc),
                fp=float(fp), fn=float(fn))


def main():
    pares = armar_pares()
    print(f"pares (imagen, pose) encontrados: {len(pares)}")
    sujetos = sorted({s for _, _, s in pares})
    print(f"sujetos: {len(sujetos)} -> {sujetos}\n")
    if not pares:
        raise SystemExit("No se encontraron pares. ¿Terminó la descarga?")

    df, dfp, sin_rostro = extraer(pares)
    df.to_csv(SALIDA, index=False)
    dfp.to_csv(SALIDA.replace(".csv", "_perdidos.csv"), index=False)
    print(f"guardado -> {SALIDA}")

    # --- Verificación de signo (ANTES de medir el error) ---
    r = np.corrcoef(df.yaw_mp, df.yaw_gt)[0, 1]
    print(f"\ncorrelación yaw MediaPipe vs BIWI: {r:+.4f}")
    invertido = False
    if r < -0.5:
        print(">>> SIGNO INVERTIDO. Se invierte yaw_mp y queda REGISTRADO.")
        df["yaw_mp"] = -df["yaw_mp"]; invertido = True
    elif r < 0.5:
        print(">>> ATENCIÓN: correlación baja. Revisar la convención antes de seguir.")
    else:
        print(">>> Convención coincidente.")

    print("\n" + "=" * 62)
    res_full = reporte(df, "RANGO COMPLETO")
    d45 = df[df.yaw_gt.abs() <= 45]
    res_45 = reporte(d45, "|yaw_gt| <= 45°  (rango de uso realista)")

    # --- Regresión de escala ---
    b, a = np.polyfit(d45.yaw_gt, d45.yaw_mp, 1)
    r2 = np.corrcoef(d45.yaw_gt, d45.yaw_mp)[0, 1] ** 2
    rng = np.random.default_rng(42)
    bs = []
    gt, mpv = d45.yaw_gt.values, d45.yaw_mp.values
    for _ in range(2000):
        i = rng.integers(0, len(d45), len(d45))
        bs.append(np.polyfit(gt[i], mpv[i], 1)[0])
    lo, hi = np.percentile(bs, [2.5, 97.5])
    print(f"\nyaw_mp = {a:+.3f} + {b:.4f} * yaw_gt     R² = {r2:.4f}   n = {len(d45)}")
    print(f"pendiente b = {b:.4f}   IC 95% [{lo:.4f} - {hi:.4f}]")
    if lo <= 1.0 <= hi:
        print("  -> b = 1 está DENTRO del IC: no hay error de escala detectable.")
    else:
        tipo = "ENCOGE" if b < 1 else "EXAGERA"
        print(f"  -> b = 1 QUEDA FUERA del IC: MediaPipe {tipo} el ángulo sistemáticamente.")
        print(f"     A 20° de giro real mide {20*b:.1f}° -> R1 dispararía "
              f"{'de menos' if b < 1 else 'de más'} cerca del umbral.")

    # --- IC clusterizado POR SUJETO (regla 3 del protocolo) ---
    acierto = ((d45.yaw_gt.abs() > UMBRAL) == (d45.yaw_mp.abs() > UMBRAL)).values
    sujs = d45.sujeto.unique()
    grupos = [acierto[(d45.sujeto == s).values] for s in sujs]
    rng = np.random.default_rng(42)
    boot = [np.concatenate([grupos[i] for i in rng.integers(0, len(grupos), len(grupos))]).mean()
            for _ in range(2000)]
    blo, bhi = np.percentile(boot, [2.5, 97.5])
    print(f"\nbootstrap CLUSTERIZADO por sujeto (n sujetos = {len(sujs)})")
    print(f"  acuerdo = {acierto.mean():.4f}   IC 95% [{blo:.4f} - {bhi:.4f}]")

    deteccion = tasa_deteccion_por_angulo(df, dfp)

    resumen = dict(
        fuente="BIWI (espejo HF ZihanWang1029/BIWI)",
        deteccion_por_angulo=deteccion,
        n_pares=len(pares), n_sujetos=len(sujetos), sin_rostro=int(sin_rostro),
        correlacion_signo=float(r), signo_invertido=invertido,
        rango_completo=res_full, rango_45=res_45,
        escala=dict(a=float(a), b=float(b), r2=float(r2), ic=[float(lo), float(hi)]),
        acuerdo_ic_clusterizado=[float(blo), float(bhi)],
        umbral=UMBRAL)
    with open(os.path.join(AQUI, "biwi_resultado.json"), "w", encoding="utf-8") as f:
        json.dump(resumen, f, indent=2, ensure_ascii=False)
    print("\nresumen -> biwi_resultado.json")


if __name__ == "__main__":
    main()
