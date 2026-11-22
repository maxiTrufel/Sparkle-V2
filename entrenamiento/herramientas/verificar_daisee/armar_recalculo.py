"""Arma recalcular_7613.py a partir de las celdas del notebook de cierre, sin cambiar su lógica.

Cambios respecto del notebook: rutas a la carpeta local; sin salvaguarda (no se escribe ningún
resultado); sin gráfico ni escritura del JSON o del modelo. Al final compara con lo guardado en la carpeta de proyecto.
"""
import json
from pathlib import Path

NB = Path(__file__).resolve().parents[2] / 'Fase 3' / 'Sparkle_V2_Fase3_6f_CIERRE_Test_Oficial.ipynb'
OUT = Path(__file__).with_name('recalcular_7613.py')

d = json.loads(NB.read_text(encoding='utf-8'))
cells = [''.join(c['source']) for c in d['cells'] if c['cell_type'] == 'code']
c1 = cells[0]
a = c1.index('# ---------------- SALVAGUARDA')
b = c1.index('import numpy as np, pandas as pd')
c1 = c1[:a] + c1[b:]
for sub in ('dataset_final_fase3/', 'checkpoints_fase3_2/'):
    c1 = c1.replace("{PROJECT_DIR}/" + sub, "{PROJECT_DIR}/")
c1 = c1.replace('os.makedirs(OUT_DIR, exist_ok=True)', '')
c1 = c1.replace('import matplotlib.pyplot as plt', '')

header = "import os\nos.environ.setdefault('SPARKLE_PROJECT_DIR', './SparkleV2')\n"

tail = r'''
import numpy as _np, sklearn, scipy, pandas as _pd
print('\nversiones: numpy', _np.__version__, '| sklearn', sklearn.__version__,
      '| scipy', scipy.__version__, '| pandas', _pd.__version__)
orig = json.load(open(os.path.join(PROJECT_DIR, 'TEST_OFICIAL_RESULTADO.json'), encoding='utf-8'))
def cmp(a, b, ruta=''):
    dif = []
    if isinstance(a, dict):
        for k in a:
            if k in b:
                dif += cmp(a[k], b[k], ruta + '/' + str(k))
    elif isinstance(a, (list, tuple)):
        for i, (x, y) in enumerate(zip(a, b)):
            dif += cmp(x, y, ruta + f'[{i}]')
    else:
        try:
            if abs(float(a) - float(b)) > 1e-9:
                dif.append((ruta, a, b))
        except (TypeError, ValueError):
            pass
    return dif
nuevo = {'destacados': destacados, 'curva_ventana': df_w.to_dict('records'), 'curva_clip': df_c.to_dict('records')}
nuevo = json.loads(json.dumps(nuevo, default=float))
dif = cmp({k: orig[k] for k in nuevo}, nuevo)
print('DIFERENCIAS con TEST_OFICIAL_RESULTADO.json:', len(dif))
for x in dif[:20]:
    print('  ', x)
M = _np.load(os.path.join(PROJECT_DIR, 'modelo_final_ensemble.npz'))
mx = 0.0
for j, (sc, lr) in enumerate(cabezas):
    mx = max(mx, abs(M[f'lr{j}_coef'] - lr.coef_).max(), abs(M[f'lr{j}_int'] - lr.intercept_).max(),
             abs(M[f'sc{j}_mean'] - sc.mean_).max())
mx = max(mx, abs(M['geom_medians'] - g_med).max(), abs(M['geom_scaler_mean'] - gsc.mean_).max())
print('Maxima diferencia contra modelo_final_ensemble.npz: %.3e' % mx)
print('Clips de test usados:', len(ids_c), '| ids unicos del test en el cache:', len(set(id_te)))
_np.savetxt(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ids_test_usados.txt'), ids_c, fmt='%s')
_np.savetxt(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ids_todos_fase3.txt'),
            _np.concatenate([ids_of(d32['id_tr']), ids_of(d32['id_va']), ids_of(d32['id_te'])]), fmt='%s')
'''

OUT.write_text(header + '\n\n'.join([c1] + cells[1:6]) + tail, encoding='utf-8')
print('escrito', OUT)
