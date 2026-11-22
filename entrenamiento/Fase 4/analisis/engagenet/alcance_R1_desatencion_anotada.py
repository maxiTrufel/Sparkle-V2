"""Que fraccion de la desatencion ANOTADA POR HUMANOS se manifiesta como desvio de cabeza.

MOTIVO. La afirmacion D del Anexo G --"R1 se activa cuando el sujeto mira a otro lado"--
esta bloqueada en el acceso a NTHU-DDD. Esta medicion NO la reemplaza, y su alcance esta
acotado en el encabezado de resultados. Lo que si responde es una pregunta distinta y
util, con datos ya en poder del proyecto:

    De los clips que un anotador humano marco como NO comprometidos,
    ¿en cuantos se activa R1?

QUE PUEDE AFIRMARSE
  - Que la señal DISCRIMINA: `frac_desviado` es dos ordenes de magnitud mayor en
    desatencion anotada que en atencion anotada.
  - Que las reglas alcanzan el extremo SEVERO del fenomeno y no el leve.
  - Todo eso medido contra anotacion humana independiente, EN EL DOMINIO OBJETIVO
    (aula virtual), no en un simulador de manejo.

QUE NO PUEDE AFIRMARSE
  - NO es el recall de R1. El constructo de R1 es el desvio de cabeza; el de la
    etiqueta es el compromiso del estudiante. Un alumno desatento puede estarlo sin
    girar la cabeza, de modo que una tasa baja NO es un fallo de la regla.
  - NO cierra la afirmacion D ni autoriza a reportarla como cerrada.
  - 10 sujetos.

PARTICION. Solo VALIDACION, que ya estaba consumida por la medicion de especificidad
del 2026-08-15. El Test oficial NO se toca: el contador sigue en 0.

Reutiliza `engagenet_val.csv`, producido por `medir_engagenet.py`. No vuelve a correr
MediaPipe ni necesita los videos.
"""
import io
import json
import os

import pandas as pd

AQUI = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(AQUI, "engagenet_val.csv")

# Mapeo de H3 congelado en `Anexo_A` §2.2: la escala de EngageNet mide COMPROMISO y
# H3 mide DESCONEXION, de modo que la polaridad se invierte.
NO_COMPROMETIDOS = {"Not-Engaged", "Barely-engaged"}

d = pd.read_csv(CSV)
d["subj"] = d.chunk.str.extract(r"^(subject_\d+)")

# `assert` de polaridad, conforme al `Anexo_A`: si el mapeo se invirtiera por error,
# todo el resultado se leeria al reves sin dar ningun fallo.
assert d.label.isin(NO_COMPROMETIDOS | {"Engaged", "Highly-Engaged"}).all(), \
    "hay etiquetas fuera de las cuatro clases de compromiso (¿SNP?)"
assert d[d.label.isin(NO_COMPROMETIDOS)].frac_desviado.mean() > \
       d[~d.label.isin(NO_COMPROMETIDOS)].frac_desviado.mean(), \
    "POLARIDAD INVERTIDA: los 'atentos' se desvian mas que los 'desatentos'"

sub = d[d.label.isin(NO_COMPROMETIDOS)]
att = d[~d.label.isin(NO_COMPROMETIDOS)]

print(f"clips totales en validacion : {len(d)}  ({d.subj.nunique()} sujetos)")
print()
print(f"{'grupo':<22} {'n':>5} {'R1':>5} {'%':>7} {'frac_desv':>11} {'deteccion':>10}")
print("-" * 64)


def fila(nombre, x):
    print(f"{nombre:<22} {len(x):>5} {int(x.r1_dispara.sum()):>5} "
          f"{100 * x.r1_dispara.mean():>6.2f}% {x.frac_desviado.mean():>11.4f} "
          f"{x.tasa_deteccion.mean():>9.1%}")


fila("Atentos (control)", att)
fila("NO comprometidos", sub)
print("-" * 64)
for etiqueta in ("Barely-engaged", "Not-Engaged"):
    fila(f"  {etiqueta}", d[d.label == etiqueta])

razon = sub.frac_desviado.mean() / att.frac_desviado.mean()
print()
print(f"Razon de `frac_desviado` (desatentos / atentos): {razon:.1f}x")

res = {
    "particion": "validation",
    "n_clips": int(len(d)),
    "n_sujetos": int(d.subj.nunique()),
    "atentos": {
        "n": int(len(att)),
        "r1_dispara": int(att.r1_dispara.sum()),
        "frac_desviado_medio": float(att.frac_desviado.mean()),
    },
    "no_comprometidos": {
        "n": int(len(sub)),
        "n_sujetos": int(sub.subj.nunique()),
        "r1_dispara": int(sub.r1_dispara.sum()),
        "tasa": float(sub.r1_dispara.mean()),
        "frac_desviado_medio": float(sub.frac_desviado.mean()),
        "deteccion_media": float(sub.tasa_deteccion.mean()),
    },
    "por_etiqueta": {
        e: {
            "n": int((d.label == e).sum()),
            "r1_dispara": int(d[d.label == e].r1_dispara.sum()),
            "frac_desviado_medio": float(d[d.label == e].frac_desviado.mean()),
            "deteccion_media": float(d[d.label == e].tasa_deteccion.mean()),
        }
        for e in ("Barely-engaged", "Not-Engaged")
    },
    "razon_frac_desviado": float(razon),
}
with io.open(os.path.join(AQUI, "alcance_R1_resultado.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, indent=2, ensure_ascii=False)
print("\nescrito: alcance_R1_resultado.json")
