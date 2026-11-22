"""EngageNet — tres mediciones que NO dependen de NTHU-DDD.

1. ESPECIFICIDAD DE R1 EN UN SEGUNDO DATASET (afirmación C del Anexo G).
   R1 se corre sobre clips cuya etiqueta humana dice que el sujeto SÍ estaba
   atendiendo (Engaged / Highly-Engaged). Cada disparo es un falso positivo.
   Hoy la afirmación C descansa en DAiSEE solamente (0/975 ventanas, 82
   sujetos); esto la extiende a una población independiente.

2. ANCHO DE ROSTRO EN UNA POBLACIÓN REAL DE E-LEARNING.
   La Enmienda 2 §4bis.6 NO congela el umbral de 80 px porque se derivó de
   forma indirecta de la óptica de BIWI (150·F/Z). EngageNet es webcam en
   contexto de e-learning: el ancho se mide DIRECTAMENTE sobre la malla.

3. TASA DE DETECCIÓN EN EL DOMINIO OBJETIVO.
   Qué fracción de un dataset real quedaría fuera de dominio — el costo de
   cobertura de la abstención, medido antes de embarcarla.

⚠️ EngageNet es 1280x720 y DAiSEE 640x480. El ancho en PÍXELES no es
comparable entre datasets a igual distancia física; se reporta también
normalizado por el ancho del cuadro.
"""
import os, glob, math, json, sys
import numpy as np
import pandas as pd
import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

AQUI = os.path.dirname(os.path.abspath(__file__))
# Los videos NO se versionan (32 GB, licencia sin redistribución): se toman de
# una ruta local, configurable por variable de entorno.
VIDEOS = os.environ.get(
    "ENGAGENET_VIDEOS", os.path.join("datasets", "EngageNet", "Validation"))

# Las etiquetas NO se versionan: son parte de la base de datos de EngageNet y
# su EULA prohíbe la redistribución en cualquier forma — un repositorio público
# cuenta como tal. Se leen desde una ruta local, fuera de todo repositorio,
# indicada con la variable ENGAGENET_ETIQUETAS.
ETIQUETAS = os.environ.get("ENGAGENET_ETIQUETAS", "validation_engagement_labels.xlsx")

# Se coloca con `analisis/preparar_entorno.py` (descarga fijada + SHA-256).
MODELO = os.path.join(AQUI, "fl_v1.task")

FPS_MUESTREO = 3          # 30 cuadros por clip de 10 s
UMBRAL_YAW = 20.0         # R1, congelado
UMBRAL_FRAC = 0.30        # R1, congelado
ATENTOS = {"Engaged", "Highly-Engaged"}

opts = vision.FaceLandmarkerOptions(
    base_options=mp_python.BaseOptions(model_asset_path=MODELO),
    output_facial_transformation_matrixes=True,
    num_faces=1)
lm = vision.FaceLandmarker.create_from_options(opts)


def euler_desde_R(R):
    """Misma convención que la validación contra BIWI."""
    sy = math.sqrt(R[0, 0] ** 2 + R[1, 0] ** 2)
    if sy > 1e-6:
        y = math.atan2(-R[2, 0], sy)
    else:
        y = math.atan2(-R[2, 0], sy)
    return math.degrees(y)


def medir_clip(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    paso = max(1, int(round(fps / FPS_MUESTREO)))
    i, n_tot, n_det = 0, 0, 0
    yaws, anchos, anchos_rel = [], [], []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % paso == 0:
            n_tot += 1
            h, w = frame.shape[:2]
            img = mp.Image(image_format=mp.ImageFormat.SRGB,
                           data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            r = lm.detect(img)
            if r.facial_transformation_matrixes and r.face_landmarks:
                n_det += 1
                M = np.array(r.facial_transformation_matrixes[0].data).reshape(4, 4)
                yaws.append(abs(euler_desde_R(M[:3, :3])))
                xs = [p.x for p in r.face_landmarks[0]]
                ancho_px = (max(xs) - min(xs)) * w
                anchos.append(ancho_px)
                anchos_rel.append(max(xs) - min(xs))
        i += 1
    cap.release()
    if n_tot == 0:
        return None
    # frac_desviado se calcula sobre los cuadros DETECTADOS: si no hay rostro
    # no hay ángulo que medir. La tasa de detección se reporta aparte — es
    # justamente el hueco estructural que documenta la Enmienda 2 §2.1.
    frac = (np.mean([y > UMBRAL_YAW for y in yaws]) if yaws else 0.0)
    return dict(
        n_muestreados=n_tot, n_detectados=n_det,
        tasa_deteccion=n_det / n_tot,
        frac_desviado=float(frac),
        r1_dispara=bool(frac > UMBRAL_FRAC),
        yaw_medio=float(np.mean(yaws)) if yaws else np.nan,
        yaw_p95=float(np.percentile(yaws, 95)) if yaws else np.nan,
        ancho_px_medio=float(np.mean(anchos)) if anchos else np.nan,
        ancho_rel_medio=float(np.mean(anchos_rel)) if anchos_rel else np.nan,
    )


et = pd.read_excel(ETIQUETAS)[["chunk", "label"]]
clips = sorted(glob.glob(os.path.join(VIDEOS, "*.mp4")))
LIMITE = int(os.environ.get("LIMITE", "0"))
if LIMITE:
    clips = clips[:LIMITE]
    print(f"[MODO PRUEBA] limitado a {LIMITE} clips")
print(f"clips en disco: {len(clips)} | etiquetas: {len(et)}")

filas = []
for k, p in enumerate(clips, 1):
    m = medir_clip(p)
    if m is None:
        continue
    m["chunk"] = os.path.basename(p)
    filas.append(m)
    if k % 100 == 0:
        print(f"  {k}/{len(clips)}", flush=True)

df = pd.DataFrame(filas).merge(et, on="chunk", how="left")
df["sujeto"] = df.chunk.str.extract(r"^(subject_\d+)")
df.to_csv(os.path.join(AQUI, "engagenet_val.csv"), index=False)
print(f"\nguardado -> engagenet_val.csv  ({len(df)} clips)\n")

print("=" * 66)
print("1. ESPECIFICIDAD DE R1 SOBRE SUJETOS QUE SÍ ATENDÍAN")
at = df[df.label.isin(ATENTOS)]
print(f"  clips atentos (Engaged / Highly-Engaged) : {len(at)}")
print(f"  sujetos                                  : {at.sujeto.nunique()}")
fp = int(at.r1_dispara.sum())
print(f"  >>> R1 dispara (FALSOS POSITIVOS)        : {fp}  ({fp/len(at):.3%})")
print(f"  frac_desviado medio                      : {at.frac_desviado.mean():.4f}")
print(f"  frac_desviado p95                        : {at.frac_desviado.quantile(.95):.4f}")
print()
print("  por sujeto:")
for s, g in at.groupby("sujeto"):
    print(f"    {s:14s} n={len(g):4d}  FP={int(g.r1_dispara.sum()):3d}  "
          f"frac_medio={g.frac_desviado.mean():.4f}")

print()
print("=" * 66)
print("2. ANCHO DE ROSTRO EN E-LEARNING REAL (1280x720)")
a = df.ancho_px_medio.dropna()
for q in [5, 25, 50, 75, 95]:
    print(f"  p{q:<3d} : {np.percentile(a, q):7.1f} px   "
          f"({np.percentile(df.ancho_rel_medio.dropna(), q)*100:5.1f}% del ancho del cuadro)")
print(f"  media : {a.mean():7.1f} px")
print(f"  clips bajo 80 px : {(a < 80).mean():.2%}")
print(f"  clips bajo 70 px : {(a < 70).mean():.2%}")

print()
print("=" * 66)
print("3. TASA DE DETECCIÓN EN EL DOMINIO OBJETIVO")
print(f"  media por clip : {df.tasa_deteccion.mean():.2%}")
print(f"  clips con deteccion < 70% : {(df.tasa_deteccion < .70).mean():.2%}")
print(f"  clips con deteccion = 0   : {(df.tasa_deteccion == 0).mean():.2%}")

res = dict(
    n_clips=len(df), n_sujetos=int(df.sujeto.nunique()),
    especificidad=dict(n_atentos=len(at), n_sujetos=int(at.sujeto.nunique()),
                       falsos_positivos=fp, tasa_fp=float(fp / len(at)),
                       frac_medio=float(at.frac_desviado.mean())),
    ancho_rostro=dict(media_px=float(a.mean()),
                      p5=float(np.percentile(a, 5)), p50=float(np.percentile(a, 50)),
                      p95=float(np.percentile(a, 95)),
                      bajo_80px=float((a < 80).mean()), bajo_70px=float((a < 70).mean())),
    deteccion=dict(media=float(df.tasa_deteccion.mean()),
                   bajo_70=float((df.tasa_deteccion < .70).mean())),
)
with open(os.path.join(AQUI, "engagenet_resultado.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, indent=2, ensure_ascii=False)
print("\nresumen -> engagenet_resultado.json")
