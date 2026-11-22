# Exporta el modelo ensemble a JSON para la extensión + fixtures de fidelidad.
#
# Correr en Colab, en una celda, después de 3.6f (necesita modelo_final_ensemble.npz).
#
# POR QUÉ JSON Y NO TFLITE
# ------------------------
# La cabeza de decisión son 8 regresiones logísticas de 96 entradas = 776
# parámetros. En JSON queda auditable en texto plano y se elimina el riesgo del
# orden de entradas/salidas de TFLite, que en este proyecto ya causó dos errores
# silenciosos (§6.10 y §6.4 de la ficha técnica). El extractor CNN sigue en
# TFLite, que es donde está el costo real de cómputo.
#
# EL EXTRACTOR NO CAMBIA
# ----------------------
# Las 8 proyecciones son los bloques disjuntos de 16 columnas de la matriz de
# 128 ya desplegada, y el extractor calcula `raw1280 @ W + b`, o sea esas mismas
# 128 columnas. El bloque j es un SLICE de la salida existente: columnas
# 16j..16j+15. No hay que reexportar la CNN.
#
# PIPELINE EXACTO (importa el orden)
# ----------------------------------
#   geometría (60x32, ya estandarizada por geom_scaler)  -> media+desvío -> 64
#   extractor (16x128, CRUDA, sin emb_scaler) [bloque j] -> media+desvío -> 32
#   concat -> 96 -> scaler_j -> logreg_j -> sigmoide -> p_j
#   p = promedio de los 8 p_j
#
# ⚠️ El ensemble NO estandariza los embeddings con `emb_scaler` antes de
# resumir; estandariza el vector de resumen ya concatenado, con un escalador
# propio por cabeza. Usar `emb_scaler` acá daría un modelo distinto.

import json, os
import numpy as np

PROJECT_DIR = '/content/drive/MyDrive/SparkleV2'
ENS   = f'{PROJECT_DIR}/fase3_6_cierre/modelo_final_ensemble.npz'
OUT   = f'{PROJECT_DIR}/fase3_6_cierre'
N_PROY, D_PROJ, N_EMB_FRAMES, EMB_DIM, N_FRAMES, N_GEOM = 8, 16, 16, 128, 60, 32

z = np.load(ENS)
n_heads = sum(1 for k in z.files if k.startswith('lr') and k.endswith('_coef'))
assert n_heads == N_PROY, f'Se esperaban {N_PROY} cabezas, hay {n_heads}'

# ⚠️ EL PREPROCESAMIENTO GEOMÉTRICO VIAJA CON EL MODELO.
# Las cabezas se ajustaron en 3.6f sobre geometría estandarizada con estos
# estadísticos, calculados sobre el POOL COMPLETO. El `preprocesamiento.json`
# que usa el modelo A trae otros, ajustados sobre el primer pliegue de la
# validación cruzada en 3.3. Aplicar los del modelo A al ensemble lo alimenta
# con entradas desplazadas y las ocho cabezas saturan — error silencioso que
# ocurrió efectivamente el 2026-08-06. Exportarlos NO es opcional.
geom = {
    'medians': np.asarray(z['geom_medians']).ravel().tolist(),
    'scaler_mean': np.asarray(z['geom_scaler_mean']).ravel().tolist(),
    'scaler_scale': np.asarray(z['geom_scaler_scale']).ravel().tolist(),
}
assert len(geom['medians']) == 22, f"medianas: {len(geom['medians'])}, se esperaban 22"
assert len(geom['scaler_mean']) == 32, f"scaler: {len(geom['scaler_mean'])}, se esperaban 32"

# Índices de las 10 features sobre las que se calculan las derivadas. Viajan con
# el modelo para que el JSON sea autosuficiente: sin ellos, el consumidor tendría
# que reconstruir el orden por su cuenta y una discrepancia sería silenciosa.
FEATURE_NAMES = ['ear_avg', 'ear_left', 'ear_right', 'yaw', 'pitch', 'mar',
                 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight',
                 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeLookDownLeft',
                 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeLookDownRight',
                 'browDownLeft', 'browDownRight', 'browInnerUp', 'jawOpen']
DELTA_FEATURES = ['ear_avg', 'yaw', 'pitch', 'mar', 'jawOpen', 'eyeBlinkLeft',
                  'eyeBlinkRight', 'eyeLookInLeft', 'eyeLookOutLeft', 'browInnerUp']
geom['delta_idx'] = [FEATURE_NAMES.index(f) for f in DELTA_FEATURES]
geom['feature_names'] = FEATURE_NAMES
assert len(geom['delta_idx']) == 10

modelo = {
    'formato': 'sparkle-ensemble-v2',
    'geometria': geom,
    'descripcion': ('8 regresiones logisticas sobre [resumen geometrico (64) + '
                    'resumen del bloque j de la salida del extractor (32)]. '
                    'Se promedian las 8 probabilidades.'),
    'n_cabezas': N_PROY,
    'd_bloque': D_PROJ,
    'n_frames': N_FRAMES,
    'n_emb_frames': N_EMB_FRAMES,
    'emb_dim': EMB_DIM,
    'n_geom': N_GEOM,
    'usa_emb_scaler': False,   # explícito: la rama de apariencia va CRUDA
    'cabezas': [],
}
for j in range(N_PROY):
    coef = np.asarray(z[f'lr{j}_coef']).ravel()
    assert coef.size == 96, f'cabeza {j}: {coef.size} coeficientes, se esperaban 96'
    modelo['cabezas'].append({
        'bloque': [j * D_PROJ, (j + 1) * D_PROJ],       # slice sobre las 128 columnas
        'scaler_mean':  np.asarray(z[f'sc{j}_mean']).ravel().tolist(),
        'scaler_scale': np.asarray(z[f'sc{j}_scale']).ravel().tolist(),
        'coef': coef.tolist(),
        'intercept': float(np.asarray(z[f'lr{j}_int']).ravel()[0]),
    })

ruta = f'{OUT}/modelo_ensemble.json'
with open(ruta, 'w') as f:
    json.dump(modelo, f)
print(f'{ruta}  ({os.path.getsize(ruta)/1024:.1f} kB, '
      f'{N_PROY * 289} parametros)')

# ─────────────────────────────────────────────────────────────────────────────
# FIXTURES DE FIDELIDAD
# Entradas sinteticas + probabilidades esperadas. El test de JS tiene que
# reproducirlas. Es el mismo tipo de assert que en 3.5a (dio 2,4e-06) y el que
# evita que la migracion diverja del numero medido sin avisar.
# ─────────────────────────────────────────────────────────────────────────────
def resumir(X):
    X = np.nan_to_num(X)
    return np.hstack([X.mean(axis=0), X.std(axis=0)])

def preparar_geometria(raw22):
    """(60,22) CRUDA -> derivadas -> estandarización con los estadísticos del
    ensemble -> (60,32). Réplica exacta de `prepareGeometric()` del navegador."""
    T = raw22.shape[0]
    d = np.zeros((T, len(geom['delta_idx'])))
    d[1:, :] = np.diff(raw22[:, geom['delta_idx']], axis=0)
    x = np.hstack([raw22, d])
    return (x - np.array(geom['scaler_mean'])) / np.array(geom['scaler_scale'])

def predecir(raw22, emb_raw):
    """raw22: (60,22) CRUDA. emb_raw: (16,128) salida CRUDA del extractor.
    Cubre la CADENA COMPLETA, no solo la cabeza."""
    rg = resumir(preparar_geometria(raw22))
    ps = []
    for h in modelo['cabezas']:
        a, b = h['bloque']
        r = np.hstack([rg, resumir(emb_raw[:, a:b])])
        r = (r - np.array(h['scaler_mean'])) / np.array(h['scaler_scale'])
        logit = float(r @ np.array(h['coef']) + h['intercept'])
        ps.append(1.0 / (1.0 + np.exp(-logit)))
    return float(np.mean(ps)), ps

# ⚠️ LOS FIXTURES PARTEN DE LA GEOMETRÍA CRUDA, no de la ya estandarizada.
# La versión anterior alimentaba la cabeza con geometría estandarizada generada
# al azar, de modo que verificaba la aritmética de la cabeza y NADA de la cadena
# de preprocesamiento. Pasó con diferencia 1e-16 mientras el sistema desplegado
# estaba roto, porque el navegador aplicaba los estadísticos del modelo A.
rng = np.random.default_rng(12345)
casos = []
for i in range(5):
    # Redondear PRIMERO y calcular DESPUÉS: al revés los fixtures quedan
    # inconsistentes consigo mismos y el test falla por ~1e-8 sin que haya
    # ningún error en el JavaScript.
    g = rng.normal(loc=0.3, scale=0.2, size=(N_FRAMES, 22)).round(6).astype(np.float64)
    e = rng.normal(loc=3.0, scale=2.0, size=(N_EMB_FRAMES, EMB_DIM)).round(6).astype(np.float64)
    p, ps = predecir(g, e)
    casos.append({'geom_cruda': g.tolist(), 'emb': e.tolist(),
                  'p_esperada': p, 'p_por_cabeza': ps})
    print(f'caso {i}: p = {p:.12f}')

ruta_fx = f'{OUT}/fixtures_ensemble.json'
with open(ruta_fx, 'w') as f:
    json.dump({'casos': casos}, f)
print(f'\n{ruta_fx}  ({os.path.getsize(ruta_fx)/1024/1024:.1f} MB)')
print('\nCopiar AMBOS a frontend/public/models/ (el json del modelo) y a '
      'frontend/tests/fixtures/ (los fixtures).')
