"""Deja el entorno listo para reejecutar las mediciones de la Enmienda 2.

POR QUÉ EXISTE
--------------
Los tres scripts de medición (`biwi_yaw/validar_yaw_biwi.py`,
`biwi_yaw/v5_nir.py` y `engagenet/medir_engagenet.py`) cargan el detector
facial desde un archivo `fl_v1.task` ubicado en su propio directorio. Ese
archivo es un binario de 3,6 MB que NO está versionado, de modo que un
checkout limpio del repositorio no puede reproducir ninguno de los tres
resultados centrales de la Enmienda 2 (U4 = 2,86°, V5 = 100 %,
0/842 falsos positivos).

Este script cierra ese hueco: descarga el modelo desde la URL **fijada** de
MediaPipe y verifica su SHA-256 contra el valor registrado.

POR QUÉ LA VERSIÓN VA FIJADA Y NO EN "latest"
---------------------------------------------
`float16/latest/` puede cambiar de contenido sin aviso, lo que rompería la
reproducibilidad de una medición fechada. Se usa `float16/1/`, verificado
byte-idéntico al archivo que despacha la extensión (mismo SHA-256).

USO
---
    python preparar_entorno.py
"""
import hashlib
import os
import sys
import urllib.request

AQUI = os.path.dirname(os.path.abspath(__file__))

# URL FIJADA. No cambiar a `latest` — ver el encabezado.
URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/"
       "face_landmarker/float16/1/face_landmarker.task")

# SHA-256 del artefacto que despacha la extensión en
# `Sparkle_V2/frontend/public/models/face_landmarker.task`, verificado
# idéntico al que devuelve la URL fijada de arriba.
SHA_ESPERADO = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"

# Copia de respaldo local, por si no hay red (opcional; también se verifica su SHA-256).
RESPALDO = os.environ.get("FACE_LANDMARKER_LOCAL", "")

DESTINOS = [os.path.join(AQUI, "utarldd", "fl_v1.task"),
            os.path.join(AQUI, "biwi_yaw", "fl_v1.task"),
            os.path.join(AQUI, "engagenet", "fl_v1.task")]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def obtener():
    """Devuelve los bytes del modelo: del respaldo local si está, si no de la red."""
    if RESPALDO and os.path.exists(RESPALDO):
        print(f"[1/2] usando el respaldo local: {RESPALDO}")
        with open(RESPALDO, "rb") as f:
            return f.read()
    print(f"[1/2] descargando de la URL fijada...")
    with urllib.request.urlopen(URL, timeout=120) as r:
        return r.read()


def main():
    datos = obtener()
    tmp = os.path.join(AQUI, ".fl_v1.tmp")
    with open(tmp, "wb") as f:
        f.write(datos)

    real = sha256(tmp)
    if real != SHA_ESPERADO:
        os.remove(tmp)
        print("\n  ✗ SHA-256 NO COINCIDE — el entorno NO queda preparado.")
        print(f"    esperado : {SHA_ESPERADO}")
        print(f"    obtenido : {real}")
        print("\n  Un modelo distinto invalidaría la comparación con las mediciones")
        print("  ya registradas. Resolver antes de reejecutar nada.")
        sys.exit(1)

    print(f"      SHA-256 verificado: {real[:16]}...")
    print("[2/2] copiando junto a cada script:")
    for d in DESTINOS:
        os.makedirs(os.path.dirname(d), exist_ok=True)
        with open(d, "wb") as f:
            f.write(datos)
        print(f"      {os.path.relpath(d, AQUI)}")
    os.remove(tmp)
    print("\n  ✓ Entorno listo. Los tres scripts de medición ya pueden ejecutarse.")


if __name__ == "__main__":
    main()
