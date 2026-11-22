"""Paso V3 de NTHU-DDD, parte 1: inventario y anotaciones. NO decodifica video.

`Preregistro_FaceScore.md` §5.1.2 permite en este paso: el árbol de carpetas y los
nombres de archivo, el formato de los archivos de anotación, su longitud y cuántos
cuadros hay de cada valor por video. **No corre MediaPipe ni mira ningún cuadro.**

Escribe un JSON con agregados por video (sin nada por cuadro) para el §5.2.

Uso: python 1_inventario_anotaciones.py [carpeta] [salida.json]
"""
import collections
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RAIZ = sys.argv[1] if len(sys.argv) > 1 else os.path.join("datasets", "NTHU-DDD")
SALIDA = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "salida", "nthu_v3_inventario.json")

SITUACIONES = ("yawning", "slowBlinkWithNodding", "sleepyCombination", "nonsleepyCombination")
TIPOS = ("head", "eye", "mouth", "drowsiness")
# Escenarios tal como aparecen en el Drive (ojo: `nightglasses` sin guion bajo).
ESCENARIOS = ("noglasses", "glasses", "night_noglasses", "nightglasses", "sunglasses")
VALORES = {"head": {"0", "1", "2"}, "eye": {"0", "1"}, "mouth": {"0", "1", "2"}, "drowsiness": {"0", "1"}}


def clave(ruta):
    """(sujeto, escenario, situación) desde la ruta, o None si no encaja."""
    partes = ruta.replace("\\", "/").split("/")
    nombre = partes[-1]
    situacion = os.path.splitext(nombre)[0]
    if situacion not in SITUACIONES or len(partes) < 3:
        return None
    escenario, sujeto = partes[-2], partes[-3]
    if escenario not in ESCENARIOS or not re.fullmatch(r"\d{3}", sujeto):
        return None
    return sujeto, escenario, situacion


def main():
    videos, repetidos, raros = {}, [], []
    for d, _, archivos in os.walk(RAIZ):
        for a in archivos:
            ruta = os.path.join(d, a)
            if a.lower().endswith(".avi"):
                k = clave(ruta)
                if k is None:
                    raros.append(ruta)
                elif k in videos:
                    repetidos.append((k, videos[k], ruta))
                else:
                    videos[k] = ruta
            elif not a.lower().endswith(".txt"):
                raros.append(ruta)

    print(f"videos: {len(videos)} · repetidos: {len(repetidos)} · archivos raros: {len(raros)}")
    if raros[:5]:
        print("  raros (muestra):", raros[:5])
    if repetidos[:3]:
        print("  repetidos (muestra):", repetidos[:3])

    sujetos = sorted({k[0] for k in videos})
    faltantes = [(s, e, si) for s in sujetos for e in ESCENARIOS for si in SITUACIONES
                 if (s, e, si) not in videos]
    print(f"sujetos: {len(sujetos)} {sujetos}")
    print(f"combinaciones faltantes: {len(faltantes)} -> {sorted({(s, e) for s, e, _ in faltantes})}")

    filas, problemas = {}, []
    for (sujeto, escenario, situacion), ruta in sorted(videos.items()):
        carpeta = os.path.dirname(ruta)
        fila = dict(sujeto=sujeto, escenario=escenario, situacion=situacion,
                    bytes_video=os.path.getsize(ruta), anotaciones={})
        for tipo in TIPOS:
            nombre = f"{sujeto}_{situacion}_{tipo}.txt"
            p = os.path.join(carpeta, nombre)
            if not os.path.exists(p):
                fila["anotaciones"][tipo] = None
                problemas.append(f"falta {nombre} en {sujeto}/{escenario}")
                continue
            texto = open(p, encoding="utf-8", errors="replace").read()
            cuerpo = texto.strip()
            cuenta = collections.Counter(cuerpo)
            desconocidos = {c: n for c, n in cuenta.items() if c not in VALORES[tipo]}
            if desconocidos:
                problemas.append(f"{nombre}: valores fuera del esquema {desconocidos}")
            fila["anotaciones"][tipo] = dict(
                n=len(cuerpo), bytes=len(texto), lineas=texto.count("\n"),
                cuenta={c: n for c, n in sorted(cuenta.items())})
        largos = {t: v["n"] for t, v in fila["anotaciones"].items() if v}
        fila["anotacion_n"] = largos
        fila["anotaciones_coinciden_entre_si"] = len(set(largos.values())) <= 1
        if not fila["anotaciones_coinciden_entre_si"]:
            problemas.append(f"{sujeto}/{escenario}/{situacion}: longitudes distintas entre tipos {largos}")
        filas[f"{sujeto}/{escenario}/{situacion}"] = fila

    print(f"\nproblemas detectados: {len(problemas)}")
    for p in problemas[:10]:
        print("  ·", p)

    res = dict(
        paso="V3 parte 1 — inventario y anotaciones (Preregistro_FaceScore.md §5.1.2)",
        raiz=RAIZ, videos=len(videos), sujetos=sujetos, faltantes=[list(f) for f in faltantes],
        repetidos=[[list(k), a, b] for k, a, b in repetidos], archivos_raros=raros,
        problemas=problemas, por_video=filas)
    os.makedirs(os.path.dirname(os.path.abspath(SALIDA)), exist_ok=True)
    with open(os.path.abspath(SALIDA), "w", encoding="utf-8") as f:
        json.dump(res, f, indent=1, ensure_ascii=False)
    print(f"\nguardado -> {os.path.abspath(SALIDA)}")
    print("No se decodificó ningún video. Sigue 2_metadatos_video.py.")


if __name__ == "__main__":
    main()
