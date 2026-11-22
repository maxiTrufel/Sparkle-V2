"""Recall del criterio POR CUADRO de R1, contra el ground truth de sensor de BIWI.

QUE PREGUNTA CONTESTA, Y CUAL NO
---------------------------------
La afirmacion D del proyecto —«R1 dispara cuando la persona mira a otro lado»—
figura como bloqueada por el acceso a NTHU-DDD. Eso es cierto para la afirmacion
COMPLETA, pero no para todas sus partes, y la distincion importa.

R1 tiene dos niveles:

  1. POR CUADRO   : |yaw| > 20 grados
  2. POR VENTANA  : mas del 30 % de los cuadros de 50 s marcados en el nivel 1

El nivel 1 se puede medir con lo que ya hay: BIWI trae el yaw real de cada cuadro
medido por sensor, con 24 sujetos. El acuerdo global (0,9540) ya estaba reportado
en `Enmienda_2` §1.3, pero el acuerdo mezcla las dos direcciones del error. Este
script separa la que corresponde al recall: **de los cuadros que estaban de
verdad desviados, ¿cuantos marca R1?**

  NO contesta el nivel 2 (agregacion por ventana sobre conducta real).
  NO contesta el vinculo conductual (que la desatencion en clase se manifieste
  como desvio sostenido de cabeza).

Esas dos partes siguen necesitando un dataset de conducta anotada.

LAS DOS CIFRAS, Y POR QUE VAN LAS DOS
--------------------------------------
- **Condicionado a deteccion**: entre los cuadros desviados en los que MediaPipe
  encontro el rostro, cuantos marca. Mide el CRITERIO.
- **Extremo a extremo**: sobre todos los cuadros desviados, detectados o no.
  Mide el SISTEMA.

La diferencia entre las dos es el hueco estructural de `Enmienda_2` §2.1: por
encima de ~60 grados el rostro no se detecta, y un cuadro sin rostro no llega a
R1 como desviado — desaparece. Reportar solo la primera describiria un detector
que no es el que se despacha.

SALVEDAD DE DOMINIO
-------------------
BIWI son personas girando la cabeza en un laboratorio, no estudiantes
desatentos. Esto valida el INSTRUMENTO, no la conducta.

USO
---
    python recall_cuadro_R1_biwi.py
"""
import csv
import io
import os
import random

UMBRAL = 20.0
SEMILLA = 20260827
REPS = 2000

AQUI = os.path.dirname(os.path.abspath(__file__))
DET = os.path.join(AQUI, "biwi_yaw", "biwi_yaw.csv")
PER = os.path.join(AQUI, "biwi_yaw", "biwi_yaw_perdidos.csv")


def cargar():
    """Cuadros detectados y cuadros perdidos, con el signo de BIWI ya corregido.

    La convencion de la matriz de rotacion de BIWI tiene el yaw invertido
    respecto de la de MediaPipe (r = -0,9854, registrado en `Enmienda_2` §1.2).
    NO es un bug de la extension: es la convencion del dataset.
    """
    det = list(csv.DictReader(io.open(DET, encoding="utf-8")))
    per = list(csv.DictReader(io.open(PER, encoding="utf-8")))
    for r in det:
        r["gt"] = -float(r["yaw_gt"])
        r["mp"] = float(r["yaw_mp"])
    for r in per:
        r["gt"] = -float(r["yaw_gt"])
    return det, per


def ic_clusterizado(det, per, extremo_a_extremo):
    """Bootstrap por SUJETO, no por cuadro.

    Los cuadros de un sujeto son una secuencia de video: remuestrearlos como si
    fueran independientes daria un intervalo mucho mas angosto que el real.
    """
    sujetos = sorted({r["sujeto"] for r in det} | {r["sujeto"] for r in per})
    d_por = {s: [r for r in det if r["sujeto"] == s] for s in sujetos}
    p_por = {s: [r for r in per if r["sujeto"] == s] for s in sujetos}

    random.seed(SEMILLA)
    reps = []
    for _ in range(REPS):
        muestra = [random.choice(sujetos) for _ in sujetos]
        d = [r for s in muestra for r in d_por[s] if abs(r["gt"]) > UMBRAL]
        p = [r for s in muestra for r in p_por[s] if abs(r["gt"]) > UMBRAL]
        den = len(d) + len(p) if extremo_a_extremo else len(d)
        if den == 0:
            continue
        reps.append(sum(1 for r in d if abs(r["mp"]) > UMBRAL) / den)
    reps.sort()
    return reps[int(0.025 * len(reps))], reps[int(0.975 * len(reps))]


def main():
    det, per = cargar()
    pos_d = [r for r in det if abs(r["gt"]) > UMBRAL]
    pos_p = [r for r in per if abs(r["gt"]) > UMBRAL]
    neg_d = [r for r in det if abs(r["gt"]) <= UMBRAL]
    marcados = sum(1 for r in pos_d if abs(r["mp"]) > UMBRAL)
    total = len(pos_d) + len(pos_p)

    print("=" * 68)
    print("RECALL POR CUADRO DEL CRITERIO DE R1  (|yaw| > %.0f grados)" % UMBRAL)
    print("BIWI · %d sujetos · ground truth de sensor" % len({r["sujeto"] for r in det}))
    print("=" * 68)
    print("\nCuadros con |yaw| REAL > %.0f grados" % UMBRAL)
    print("  con rostro detectado      : %5d" % len(pos_d))
    print("  SIN rostro detectado      : %5d" % len(pos_p))
    print("  total                     : %5d" % total)

    lo, hi = ic_clusterizado(det, per, extremo_a_extremo=False)
    print("\n  RECALL condicionado a deteccion : %.4f  [%.4f - %.4f]"
          % (marcados / len(pos_d), lo, hi))
    lo, hi = ic_clusterizado(det, per, extremo_a_extremo=True)
    print("  RECALL extremo a extremo        : %.4f  [%.4f - %.4f]"
          % (marcados / total, lo, hi))
    print("  (IC 95 %%, bootstrap de %d replicas, clusterizado por sujeto)" % REPS)

    fp = sum(1 for r in neg_d if abs(r["mp"]) > UMBRAL)
    print("\n  Falsos positivos por cuadro     : %.4f  (%d de %d cuadros no desviados)"
          % (fp / len(neg_d), fp, len(neg_d)))

    print("\nPor franja angular — extremo a extremo")
    print("  %-14s %8s %10s %10s" % ("franja", "recall", "detectados", "perdidos"))
    for lo_g, hi_g in [(20, 30), (30, 45), (45, 60), (60, 180)]:
        d = [r for r in det if lo_g < abs(r["gt"]) <= hi_g]
        p = [r for r in per if lo_g < abs(r["gt"]) <= hi_g]
        n = len(d) + len(p)
        if not n:
            continue
        t = sum(1 for r in d if abs(r["mp"]) > UMBRAL)
        etiqueta = ">%d" % lo_g if hi_g == 180 else "%d-%d" % (lo_g, hi_g)
        print("  %-14s %8.3f %10d %10d" % (etiqueta + " grados", t / n, len(d), len(p)))

    print("\n" + "=" * 68)
    print("LECTURA")
    print("=" * 68)
    print("""
  El criterio por cuadro de R1 es solido: cuando el rostro se detecta, marca
  casi todos los cuadros realmente desviados.

  El SISTEMA no lo es en el mismo grado, y la causa dominante no es medir mal
  el angulo sino NO MEDIRLO: un tercio de los cuadros desviados no llega a R1
  porque no se detecta el rostro. La caida se concentra por encima de 45
  grados y se derrumba por encima de 60.

  Es el hueco estructural de `Enmienda_2` §2.1, ahora cuantificado en la
  direccion del RECALL y no solo en la de la tasa de deteccion. Es tambien el
  argumento cuantitativo por el que R3 (ausencia de rostro) es requerida.

  ESTO NO CIERRA LA AFIRMACION D. Falta el nivel de VENTANA (fraccion > 0,30
  sobre 50 s) y falta el vinculo CONDUCTUAL. BIWI son personas girando la
  cabeza en un laboratorio, no estudiantes desatentos.

  Contador de evaluaciones sobre particiones de prueba reservadas: SIGUE EN 0.
  BIWI no tiene particion reservada; se usa entero como validacion externa.
""")


if __name__ == "__main__":
    main()
