"""Port de referencia de la decisión por cuadro de `faceScore.js`.

Objeto: `Sparkle_V2/frontend/src/offscreen/faceScore.js` en `257d454` (v0.1.13).

No es una reimplementación "equivalente en espíritu": es una traducción línea
por línea, con el mismo orden de operaciones de punto flotante. Por eso
`medir_facescore_biwi.py` no mide nada hasta verificar, corriendo el JavaScript
original con Node, que la decisión coincide en el 100 % de una muestra de
cuadros reales (`Preregistro_FaceScore.md` §2).

Lo que NO porta: la agregación temporal (ventana de 10 s, mínimo de 30 cuadros,
cierre sostenido de 500 ms). En un cuadro estático no hay tiempo, así que el
cierre se toma como sostenido; la equivalencia con el JS lo verifica repitiendo
el cuadro 30 veces.
"""
import math

GAZE_DEGREES = 40.0
SIDE_LIMIT = 25.0
DOWN_LIMIT = -20.0
UP_LIMIT = 25.0
EYE_CLOSED_THRESHOLD = 0.5

NARIZ, MEJILLA_A, MEJILLA_B, FRENTE, MENTON = 1, 234, 454, 10, 152
LANDMARKS_USADOS = (NARIZ, MEJILLA_A, MEJILLA_B, FRENTE, MENTON)


def _deg(rad):
    # Mismo orden que `toDeg` del JS: (rad * 180) / Math.PI
    return (rad * 180.0) / math.pi


def angulos_cabeza(m_col, lm):
    """(yaw, pitch) en grados y con signo, como `headAngles()`.

    `m_col`: los 16 valores de la matriz en column-major, que es como MediaPipe
    Web entrega `data`. `lm`: indexable por número de landmark -> (x, y, z).

    La magnitud sale de la matriz y el SIGNO de la geometría de los puntos: es
    exactamente la parte que BIWI pone a prueba, porque el signo decide de qué
    lado cae el límite asimétrico del eje vertical (−20° / +25°).
    """
    r00, r10, r20, r21, r22 = m_col[0], m_col[1], m_col[2], m_col[6], m_col[10]
    yaw = abs(_deg(math.atan2(-r20, math.hypot(r00, r10))))
    pitch = abs(_deg(math.atan2(r21, r22)))

    centro_x = (lm[MEJILLA_A][0] + lm[MEJILLA_B][0]) / 2
    if lm[FRENTE][1] < lm[MENTON][1]:
        arriba, abajo = lm[FRENTE], lm[MENTON]
    else:
        arriba, abajo = lm[MENTON], lm[FRENTE]

    return (
        yaw if lm[NARIZ][0] < centro_x else -yaw,       # + = girado a su derecha
        -pitch if arriba[2] < abajo[2] else pitch,      # - = mirando abajo
    )


def mirada(bs):
    """(gazeX, gazeY) sin escalar, como las dos sumas del JS."""
    g = lambda nombre: bs.get(nombre, 0.0)
    gx = ((g("eyeLookInLeft") + g("eyeLookOutRight"))
          - (g("eyeLookOutLeft") + g("eyeLookInRight"))) / 2
    gy = ((g("eyeLookUpLeft") + g("eyeLookUpRight"))
          - (g("eyeLookDownLeft") + g("eyeLookDownRight"))) / 2
    return gx, gy


def parpadeo(bs):
    return (bs.get("eyeBlinkLeft", 0.0) + bs.get("eyeBlinkRight", 0.0)) / 2


def en_pantalla_desde_resumen(yaw_s, pitch_s, gx=0.0, gy=0.0, blink=0.0):
    """Decisión por cuadro a partir de los valores ya resumidos.

    Es el único camino de decisión del módulo: `en_pantalla()` lo llama, y
    `medir_facescore_biwi.py` lo usa sobre las columnas del CSV. Con gx = gy =
    blink = 0 es la variante «cabeza sola» (sumar 0,0 no altera un float).
    """
    cerrado = blink > EYE_CLOSED_THRESHOLD
    dir_x, dir_y = yaw_s, pitch_s
    # La mirada sólo con los ojos abiertos: al bajar los párpados MediaPipe
    # dispara eyeLookDown y ensuciaría la dirección (mismo criterio que el JS).
    if not cerrado:
        dir_x += gx * GAZE_DEGREES
        dir_y += gy * GAZE_DEGREES
    en_rango = abs(dir_x) <= SIDE_LIMIT and DOWN_LIMIT <= dir_y <= UP_LIMIT
    return en_rango and not cerrado


def en_pantalla(yaw_s, pitch_s, bs=None):
    """`bs=None` -> cabeza sola. Con blendshapes -> decisión completa."""
    if bs is None:
        return en_pantalla_desde_resumen(yaw_s, pitch_s)
    gx, gy = mirada(bs)
    return en_pantalla_desde_resumen(yaw_s, pitch_s, gx, gy, parpadeo(bs))


# ---------------------------------------------------------------------------
# Parte temporal — port de `createFaceScore()`, para EngageNet (Preregistro §4)
# ---------------------------------------------------------------------------
CLOSURE_MS = 500.0
WINDOW_MS = 10000.0
MIN_FRAMES = 30


class PuntajeCara:
    """Port de `createFaceScore()`: cierre sostenido, ventana de 10 s y mínimo de cuadros.

    A diferencia de `en_pantalla()`, acá el cierre NO se supone sostenido: se
    mide contra el reloj, igual que el JS. Un cuadro con los ojos cerrados hace
    menos de 500 ms cuenta como en pantalla si la cabeza lo está, y en ese caso
    la mirada no se suma. Se verifica contra el JS con clips reales enteros
    (`equivalencia_clips.mjs`), no con cuadros sueltos.
    """

    def __init__(self):
        self.cuadros = []          # (t, ok)
        self.cerrado_desde = None

    def registrar(self, t, rostro, m_col=None, lm=None, bs=None):
        """Registra un cuadro. Devuelve por qué quedó fuera, `None` si quedó en
        pantalla, u `"omitido"` si el JS no lo registraría.

        La causa es descriptiva (E3) y no afecta el valor. Si un cuadro cae
        fuera por más de un motivo se atribuye en este orden: sin rostro, ojos,
        lateral, vertical.
        """
        if not rostro:
            self.cerrado_desde = None
            self.cuadros.append((t, False))
            return "sin_rostro"
        if m_col is None or bs is None:
            return "omitido"                       # `if (!m || !bs) return;`

        yaw, pitch = angulos_cabeza(m_col, lm)
        cerrado = parpadeo(bs) > EYE_CLOSED_THRESHOLD
        if cerrado:
            if self.cerrado_desde is None:         # `closedSince ??= now`
                self.cerrado_desde = t
        else:
            self.cerrado_desde = None
        ojos = cerrado and t - self.cerrado_desde >= CLOSURE_MS

        dir_x, dir_y = yaw, pitch
        if not cerrado:
            gx, gy = mirada(bs)
            dir_x += gx * GAZE_DEGREES
            dir_y += gy * GAZE_DEGREES
        lateral = not abs(dir_x) <= SIDE_LIMIT
        vertical = not (dir_y >= DOWN_LIMIT and dir_y <= UP_LIMIT)
        ok = (not lateral and not vertical) and not ojos
        self.cuadros.append((t, ok))
        if ok:
            return None
        return "ojos" if ojos else ("lateral" if lateral else "vertical")

    def valor(self, t):
        """Porcentaje 0-100 de la ventana, o `None` si no alcanza el mínimo."""
        self.cuadros = [c for c in self.cuadros if c[0] > t - WINDOW_MS]
        if len(self.cuadros) < MIN_FRAMES:
            return None
        return (100 * sum(1 for c in self.cuadros if c[1])) / len(self.cuadros)
