"""Port de referencia del veredicto del producto, en sus dos versiones.

- **V1**: el desplegado en la v0.1.13 (`257d454`), promedio `0,9 · cara + 0,1 · modelo`
  (`Preregistro_FaceScore.md` §5.1.6). Sobre infrarrojo el ensemble no se corre
  (`Protocolo_Fase4.md` §3.6), así que queda una franja **indeterminada**.
- **V2**: el veredicto de **tres estados** decidido el 16/09
  (`Especificacion_Veredicto_Tres_Estados.md`, adenda §5.3). Su eje atento/desatento
  **no depende del modelo**, así que se computa entero.

Es una traducción del orden de ramas de `predict()` en `detector.js` (líneas
588–797 de `257d454`), que no se puede ejecutar fuera del navegador: se porta por
lectura, y así está declarado en §5.1.3.

Constantes, leídas del producto:
  MAX_SIN_ROSTRO = 0.30   `detector.js` MAX_NO_FACE_FRACTION
  VENTANA_ROSTRO = 60     `cfg.nFrames`, las últimas 60 muestras
  VENTANA_REGLAS = 300    5 × 60 = 50 s a 6 fps
  UMBRAL = 0.50           Y por defecto; "atento" exige SUPERARLO (`<=` es desatento)
"""
MAX_SIN_ROSTRO = 0.30
VENTANA_ROSTRO = 60
VENTANA_REGLAS = 300
UMBRAL = 0.50
BANDA_BAJA = 400.0 / 9      # 44,4: desatento sea cual sea el modelo
BANDA_ALTA = 500.0 / 9      # 55,6: atento sea cual sea el modelo

SIN_VEREDICTO = "sin_veredicto"
DESATENTO = "desatento"
ATENTO = "atento"
INDETERMINADO = "indeterminado"


def combinar(cara, modelo):
    """`combineScores` de `faceScore.js`: si falta uno, queda el otro."""
    if cara is None:
        return modelo
    if modelo is None:
        return cara
    return 0.9 * cara + 0.1 * modelo


def v1(cara, r1, r2, frac_sin_rostro):
    """Veredicto desplegado (§5.1.6), sin ensemble. Devuelve (estado, fuente)."""
    if frac_sin_rostro > MAX_SIN_ROSTRO:
        return SIN_VEREDICTO, "no_face"
    if r1 or r2:
        # Del lado del modelo la regla vale 0 %: el veredicto sale del promedio.
        valor = combinar(cara, 0.0)
        return (DESATENTO if valor / 100 <= UMBRAL else ATENTO), ("R1" if r1 else "R2")
    if cara is None:
        return INDETERMINADO, "modelo"
    if cara <= BANDA_BAJA:
        return DESATENTO, "cara"
    if cara > BANDA_ALTA:
        return ATENTO, "cara"
    return INDETERMINADO, "modelo"


def v2(cara, r1, r2, frac_sin_rostro):
    """Veredicto de tres estados, eje atento/desatento (adenda §5.3).

    El tercer estado (`atento_aburrimiento`) necesita el modelo y NO se computa acá:
    sobre infrarrojo el ensemble no se corre.
    """
    if frac_sin_rostro > MAX_SIN_ROSTRO:
        return SIN_VEREDICTO, "no_face"
    if r1 or r2:
        return DESATENTO, ("R1" if r1 else "R2")
    if cara is None:
        return SIN_VEREDICTO, "cara_sin_valor"
    return (DESATENTO if cara / 100 <= UMBRAL else ATENTO), "cara"
