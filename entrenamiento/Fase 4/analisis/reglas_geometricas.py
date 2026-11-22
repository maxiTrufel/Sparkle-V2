"""
Reglas geometricas de desatencion observable — implementacion de referencia.
Umbrales CONGELADOS en Protocolo_Reglas_Geometricas.md (2026-08-07).
Entrada: secuencia (T, F) de features CRUDAS + nombres. yaw/pitch en GRADOS, ear_avg adimensional.
"""
import numpy as np

FPS = 6.0                 # tasa de la rama geometrica (60 frames / clip de 10 s)
YAW_GRADOS   = 20.0       # primario; grilla de sensibilidad {15,20,25,30}
FRAC_VENTANA = 0.30       # derivado de MAX_SIN_ROSTRO = 0.30 de detector.js
PERCLOS_UMBRAL = 0.15     # Dinges & Grace (1998), FHWA-MCRT-98-006
EAR_FRAC_CIERRE = 0.30    # PERCLOS-70: parpado >=70% cerrado
MICROSUENO_SEG = 2.0

# --- R4: mirada fuera de pantalla (blendshapes) -----------------------------------
# NO introduce constantes nuevas: reusa el cono de 20 grados y la fraccion de 0,30 de R1.
# Lo unico nuevo es la CONVERSION blendshape -> grados, que es una MEDICION (MPIIGaze),
# no un parametro elegido. Hasta tenerla, GRADOS_POR_UNIDAD queda en None y R4 no opera.
GRADOS_POR_UNIDAD = None   # se completa con la calibracion de MPIIGaze

def _col(seq, names, n): return seq[:, names.index(n)].astype(float)

def racha_max(mask):
    """Longitud de la racha contigua mas larga de True, en frames."""
    m = np.asarray(mask, bool)
    if not m.any(): return 0
    d = np.diff(np.concatenate(([0], m.view(np.int8), [0])))
    return int((np.flatnonzero(d == -1) - np.flatnonzero(d == 1)).max())

def r1_mirada_fuera(seq, names, yaw_grados=YAW_GRADOS, frac=FRAC_VENTANA):
    """R1 — Mirada fuera de pantalla. Devuelve (dispara, detalle)."""
    yaw = _col(seq, names, "yaw")
    ok = np.isfinite(yaw)
    if ok.sum() == 0: return False, {"frac_desviado": np.nan, "racha_seg": np.nan}
    desv = np.zeros(len(yaw), bool); desv[ok] = np.abs(yaw[ok]) > yaw_grados
    f = desv[ok].mean()
    return bool(f > frac), {"frac_desviado": float(f),
                            "racha_seg": racha_max(desv) / FPS}

def r2_ojos_cerrados(seq, names, baseline_ear=None,
                     perclos_umbral=PERCLOS_UMBRAL, frac_cierre=EAR_FRAC_CIERRE):
    """R2 — Somnolencia por PERCLOS-70 con linea base propia del sujeto."""
    ear = _col(seq, names, "ear_avg"); ok = np.isfinite(ear)
    if ok.sum() == 0: return False, {"perclos": np.nan, "microsueno_seg": np.nan}
    base = baseline_ear if baseline_ear is not None else np.median(ear[ok])
    if not np.isfinite(base) or base <= 0:
        return False, {"perclos": np.nan, "microsueno_seg": np.nan}
    cerr = np.zeros(len(ear), bool); cerr[ok] = ear[ok] < frac_cierre * base
    perclos = cerr[ok].mean(); micro = racha_max(cerr) / FPS
    return bool(perclos > perclos_umbral or micro >= MICROSUENO_SEG), \
           {"perclos": float(perclos), "microsueno_seg": float(micro)}

def evaluar(seq, names, baseline_ear=None, **kw):
    d1, i1 = r1_mirada_fuera(seq, names, **{k: v for k, v in kw.items() if k in ("yaw_grados", "frac")})
    d2, i2 = r2_ojos_cerrados(seq, names, baseline_ear)
    return {"R1_mirada_fuera": d1, "R2_ojos_cerrados": d2,
            "alguna": bool(d1 or d2), **i1, **i2}


def mirada_lateral(seq, names):
    """Senal lateral de mirada CONJUGADA. Positiva = mirada a la izquierda del sujeto.

    CORREGIDA 2026-08-07. La version anterior era
        (outL + outR) - (inL + inR)
    que mide VERGENCIA (converger/diverger) y se cancela exactamente para mirada
    conjugada: al mirar a la izquierda suben outL e inR, y la resta los anula.
    Eso produjo R^2 = -0,008 contra MPIIFaceGaze y r = -0,0001 contra yaw en DAiSEE.

    Correcta: ambos ojos rotan hacia el mismo lado del ESPACIO.
        mirada a la izquierda -> outL (temporal izq) + inR (nasal der)
        mirada a la derecha   -> inL  (nasal izq)    + outR (temporal der)
    """
    c = lambda n: seq[:, names.index(n)].astype(float)
    return (c("eyeLookOutLeft") + c("eyeLookInRight")) - (c("eyeLookInLeft") + c("eyeLookOutRight"))


def r4_mirada_fuera(seq, names, grados_por_unidad=None, base_lateral=None,
                    yaw_grados=YAW_GRADOS, frac=FRAC_VENTANA):
    """R4 - Mirada fuera del cono de pantalla, por blendshapes.

    Mismo cono (20 grados) y misma fraccion (0,30) que R1: la unica diferencia es el canal.
    `grados_por_unidad` viene de la calibracion contra MPIIGaze. Si es None, R4 no decide.
    `base_lateral` es la mirada en reposo del sujeto (mediana de su sesion), analoga a la
    linea base de R2.
    """
    g = GRADOS_POR_UNIDAD if grados_por_unidad is None else grados_por_unidad
    lat = mirada_lateral(seq, names)
    ok = np.isfinite(lat)
    if ok.sum() == 0:
        return None, {"frac_mirada_fuera": np.nan, "calibrado": g is not None}
    base = base_lateral if base_lateral is not None else np.median(lat[ok])
    desv_unid = np.abs(lat - base)
    if g is None:
        # sin calibracion solo se puede describir, no decidir
        return None, {"frac_mirada_fuera": np.nan, "desv_p90_unid": float(np.percentile(desv_unid[ok], 90)),
                      "calibrado": False}
    fuera = np.zeros(len(lat), bool)
    fuera[ok] = (desv_unid[ok] * g) > yaw_grados
    f = fuera[ok].mean()
    return bool(f > frac), {"frac_mirada_fuera": float(f),
                            "racha_seg": racha_max(fuera) / FPS, "calibrado": True}


# --- Tests de signo sobre casos sinteticos -------------------------------------------
# Criterio adoptado tras el bug de vergencia (2026-08-07): toda feature derivada se
# verifica contra un caso de signo CONOCIDO antes de usarse. `python3 reglas_geometricas.py`
def _test_signos():
    nm = ["eyeLookOutLeft","eyeLookInRight","eyeLookInLeft","eyeLookOutRight","yaw","ear_avg"]
    def seq(outL, inR, inL, outR):
        return np.array([[outL, inR, inL, outR, 0.0, 0.30]] * 10)

    izq = mirada_lateral(seq(0.8, 0.8, 0.0, 0.0), nm)[0]
    der = mirada_lateral(seq(0.0, 0.0, 0.8, 0.8), nm)[0]
    verg = mirada_lateral(seq(0.8, 0.0, 0.0, 0.8), nm)[0]   # ojos divergiendo
    assert izq > 0.5,  f"mirada a la izquierda deberia ser positiva, dio {izq}"
    assert der < -0.5, f"mirada a la derecha deberia ser negativa, dio {der}"
    assert abs(verg) < 1e-9, f"vergencia pura deberia dar 0, dio {verg}"

    d, _ = r1_mirada_fuera(np.column_stack([np.full(60, 25.0), np.full(60, 0.30)]), ["yaw","ear_avg"])
    assert d is True, "R1 deberia disparar con la cabeza a 25 grados"
    d, _ = r1_mirada_fuera(np.column_stack([np.zeros(60), np.full(60, 0.30)]), ["yaw","ear_avg"])
    assert d is False, "R1 no deberia disparar con la cabeza centrada"

    ear = np.concatenate([np.full(20, 0.05), np.full(40, 0.30)])
    d, _ = r2_ojos_cerrados(np.column_stack([np.zeros(60), ear]), ["yaw","ear_avg"])
    assert d is True, "R2 deberia disparar con un tercio de la ventana con el ojo cerrado"
    print("tests de signo: OK  (izquierda>0, derecha<0, vergencia=0, R1 y R2 correctas)")


if __name__ == "__main__":
    _test_signos()
