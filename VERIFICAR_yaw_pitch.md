# Verificación del layout de la matriz de transformación facial (yaw / pitch)

**Por qué importa.** `yaw` y `pitch` son 2 de las 22 features geométricas. Si el port a
JavaScript usa una convención de matriz distinta a la de Python, esas dos features están mal en
producción **sin dar ninguna señal de error**, y el número reportado en la tesis no es el que
corre en la máquina del alumno.

**El criterio no es la corrección geométrica sino la consistencia.** El modelo se entrenó con los
valores que produjo Python. El JavaScript tiene que **reproducir la convención de Python**, sea
cual sea — incluso si Python usó la transpuesta.

---

## Paso 1 — Determinar el layout en Python (Colab)

En una matriz de transformación 4×4, la **traslación** son valores grandes (decenas) y la
**rotación** valores ≤ 1. Se identifica el layout viendo dónde caen los números grandes.

```python
import numpy as np, math, cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

det = create_face_landmarker()          # el mismo del notebook de extracción
cap = cv2.VideoCapture(video_index[list(video_index)[0]])   # cualquier clip
ok, frame = cap.read(); cap.release()
res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                          data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
M = np.array(res.facial_transformation_matrixes[0])
det.close()

np.set_printoptions(precision=4, suppress=True)
print('Matriz tal como la ve Python:\n', M, '\n')
ult_fila    = M[3, :3]      # (3,0) (3,1) (3,2)
ult_columna = M[:3, 3]      # (0,3) (1,3) (2,3)
print('Última FILA    [3, :3] =', ult_fila,    ' |máx| =', np.abs(ult_fila).max())
print('Última COLUMNA [:3, 3] =', ult_columna, ' |máx| =', np.abs(ult_columna).max())

if np.abs(ult_columna).max() > np.abs(ult_fila).max():
    print('\n→ La traslación está en la última COLUMNA: el array es una matriz ESTÁNDAR.')
    print('  Python indexa [fila][columna] correctamente.  LAYOUT_PY = "row-major"')
else:
    print('\n→ La traslación está en la última FILA: el array está TRANSPUESTO')
    print('  (datos column-major leídos con reshape row-major).  LAYOUT_PY = "transpuesta"')

yaw_py, pitch_py = euler_from_transformation_matrix(M)   # la función del notebook
print(f'\nyaw = {yaw_py:.4f}°   pitch = {pitch_py:.4f}°')
print('Elementos usados: rot[2,0]=%.4f rot[2,1]=%.4f rot[2,2]=%.4f'
      % (M[2,0], M[2,1], M[2,2]))
```

## Paso 2 — El mismo chequeo en el navegador

`chrome://extensions` → tarjeta de Sparkle → **Vistas inspeccionadas: offscreen.html** → consola.
Con la detección andando, pegar:

```js
// Requiere exponer temporalmente el último resultado, o pegarlo dentro del bucle
// de detección justo después de obtener `result`:
const m = result.facialTransformationMatrixes?.[0]?.data;
console.log('data (16):', Array.from(m).map(v => +v.toFixed(4)));
// Column-major: la traslación ocupa data[12], data[13], data[14]
console.log('data[12..14] =', m[12].toFixed(3), m[13].toFixed(3), m[14].toFixed(3));
// Row-major: ocuparía data[3], data[7], data[11]
console.log('data[3,7,11] =', m[3].toFixed(3), m[7].toFixed(3), m[11].toFixed(3));
```

En MediaPipe Web `data` viene **column-major**, así que se espera que los valores grandes estén
en `data[12..14]`. Conviene confirmarlo igual.

## Paso 3 — Decidir el arreglo

Sea `LAYOUT_PY` el resultado del paso 1 y asumiendo que en JS `data` es column-major:

| LAYOUT_PY | Qué hizo Python | Qué debe hacer el JS | Acción |
| :--- | :--- | :--- | :--- |
| `row-major` (traslación en la última columna) | Leyó la matriz real | Leer la matriz real | `at(r,c) = data[c*4 + r]` — **el código actual ya está bien**, no tocar |
| `transpuesta` (traslación en la última fila) | Leyó la **transpuesta** | Reproducir la transpuesta | `at(r,c) = data[r*4 + c]` — **hay que invertir el acceso** |

El cambio, de ser necesario, es de un carácter en `frontend/src/offscreen/features.js`:

```js
// function eulerFromMatrix(matrixData)
const at = (row, col) => matrixData[col * 4 + row];   // actual (column-major)
const at = (row, col) => matrixData[row * 4 + col];   // si Python usó la transpuesta
```

## Paso 4 — Prueba funcional, independiente del análisis anterior

Sirve como control cruzado y detecta el caso grave (yaw y pitch intercambiados):

1. Mirar de frente a la cámara. Anotar `yaw` y `pitch`.
2. **Girar la cabeza a la derecha** manteniendo la altura. `yaw` debe moverse de forma marcada y
   `pitch` casi nada.
3. **Mirar hacia arriba** sin girar. `pitch` debe moverse y `yaw` casi nada.

Si al girar horizontalmente se mueve `pitch`, están intercambiados y el paso 3 no alcanza:
revisar también qué índices usa cada uno.

## Paso 5 — Dejarlo verificado para siempre

Una vez determinado el layout, agregar a `features.js` un assert que corra una sola vez:

```js
let layoutVerificado = false;
function verificarLayoutUnaVez(matrixData) {
  if (layoutVerificado) return;
  layoutVerificado = true;
  const tras = Math.max(Math.abs(matrixData[12]), Math.abs(matrixData[13]),
                        Math.abs(matrixData[14]));
  const alt  = Math.max(Math.abs(matrixData[3]), Math.abs(matrixData[7]),
                        Math.abs(matrixData[11]));
  if (alt > tras) {
    console.error('[Sparkle][IA] La matriz facial NO viene column-major como se asumió. ' +
                  'yaw/pitch pueden estar mal. Ver VERIFICAR_yaw_pitch.md');
  } else {
    console.log('[Sparkle][IA] Layout de la matriz facial verificado: column-major.');
  }
}
```

Sin este assert el error es silencioso, que es exactamente la clase de fallo que este proyecto ya
encontró tres veces (orden de salidas en TFLite, copia de pesos por nombre, arquitectura del
modelo de export).
