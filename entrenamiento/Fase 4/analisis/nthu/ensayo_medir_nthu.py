"""Ensayo de `medir_nthu.py` sobre datos INVENTADOS (paso 3 de §5.1.9).

Arma un NTHU-DDD falso —40 videos de 8 sujetos, con etiquetas `head` y `eye`
construidas a propósito— en el formato exacto que deja `extraer_nthu.py`: el CSV
de muestras, los 40 tramos de fidelidad, las 40 secuencias completas del arnés y
el resumen de extracción. Después corre `medir_nthu.py` entero.

**No toca ningún dato de NTHU-DDD.**

Lo que tiene que dar, por construcción:
  · fidelidad 100 % en las tres pruebas;
  · N1 con sensibilidad alta: en los videos «girado» la cabeza pasa los 20° en más
    del 30 % de la ventana, que es lo que pide R1;
  · N2 alta en los videos «somnoliento», con EAR por debajo del 30 % de su base;
  · especificidad 1 en los videos «normales»;
  · V1 con parte de las ventanas indeterminadas y V2 sin ninguna.

Uso: python ensayo_medir_nthu.py <carpeta de trabajo fuera del repo>
"""
import csv
import json
import os
import random
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
AQUI = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(AQUI, "..", "..", ".."))

DESTINO = os.path.abspath(sys.argv[1])
if DESTINO.lower().startswith(REPO.lower()):
    raise SystemExit("🔴 El ensayo no escribe dentro del repositorio.")
os.environ["FACESCORE_SALIDA"] = DESTINO
os.environ["NTHU_ENSAYO"] = "1"

sys.path.insert(0, AQUI)
sys.path.insert(0, os.path.join(AQUI, "..", "facescore"))
import facescore_ref as fs  # noqa: E402
import medir_nthu as M  # noqa: E402  (lee FACESCORE_SALIDA al importarse)
import extraer_nthu as ex  # noqa: E402

N_VIDEOS, LARGO = 40, 480          # 480 muestras a 6 fps = 80 s, como los reales
MODOS = ("normal", "girado", "somnoliento", "mixto")


def video_sintetico(idx):
    """(clave, sujeto, modo, muestras) con etiquetas coherentes con lo que se simula."""
    sujeto = f"{(idx % 8) + 1:03d}"
    modo = MODOS[idx % len(MODOS)]
    clave = f"{sujeto}/noglasses/{modo}{idx}"
    rnd = random.Random(f"ensayo-{idx}")
    muestras = []
    for i in range(LARGO):
        t = i * 1000.0 / 6
        # La conducta arranca a los 20 s para que la primera ventana (50 s) la contenga.
        activo = i > 120
        girado = modo == "girado" and activo
        dormido = modo == "somnoliento" and activo
        mixto = modo == "mixto" and activo and (i // 60) % 2 == 0
        yaw = rnd.uniform(25, 35) if (girado or mixto) else rnd.uniform(-8, 8)
        ear = 0.05 if dormido else rnd.uniform(0.28, 0.32)
        blink = 0.9 if dormido else 0.05
        c = M._cuadro_sintetico(t, rnd, yaw_deg=yaw, pitch_deg=rnd.uniform(-8, 8), blink=blink, ear=ear)
        c["head"] = "2" if (girado or mixto) else "0"
        c["eye"] = "1" if dormido else "0"
        muestras.append(c)
    return clave, sujeto, modo, muestras


def main():
    os.makedirs(os.path.join(DESTINO, "muestra_nthu"), exist_ok=True)
    os.makedirs(os.path.join(DESTINO, "secuencias_veredicto"), exist_ok=True)
    filas, resumen_videos = [], {}

    for idx in range(N_VIDEOS):
        clave, sujeto, modo, muestras = video_sintetico(idx)
        _, escenario, situacion = clave.split("/")
        for cad, paso in (("6fps", 1), ("5fps", 6 / 5)):
            p, k_grilla = fs.PuntajeCara(), 0.0
            for i, c in enumerate(muestras):
                if cad == "5fps" and i < k_grilla:
                    continue
                if cad == "5fps":
                    k_grilla += paso
                lm = {int(k): v for k, v in c["lm"].items()} if c["lm"] else None
                causa = p.registrar(c["t"], c["rostro"], c["m_col"], lm, c["bs"])
                gx, gy = (fs.mirada(c["bs"]) if c["bs"] else (None, None))
                filas.append(dict(
                    video=clave, sujeto=sujeto, escenario=escenario, situacion=situacion,
                    cadencia=cad, k=i, t_ms=repr(c["t"]), head=c["head"], eye=c["eye"],
                    mouth="0", drowsiness="1" if modo == "somnoliento" else "0",
                    rostro=int(c["rostro"]), omitido=int(causa == "omitido"),
                    yaw_fs=ex.fmt(c["yaw"]),
                    pitch_fs=ex.fmt(fs.angulos_cabeza(c["m_col"], lm)[1] if c["m_col"] else None),
                    gaze_x=ex.fmt(gx), gaze_y=ex.fmt(gy),
                    blink=ex.fmt(fs.parpadeo(c["bs"]) if c["bs"] else None),
                    ear_avg=ex.fmt(c["ear"]), causa=causa or "", valor=ex.fmt(p.valor(c["t"]))))
        # Tramo de fidelidad (10 s) y secuencia completa para el arnés.
        crudos = [dict(k=i, **{k: v for k, v in c.items() if k in ("t", "rostro", "m_col", "bs", "lm")})
                  for i, c in enumerate(muestras)]
        with open(os.path.join(DESTINO, "muestra_nthu", clave.replace("/", "_") + ".json"),
                  "w", encoding="utf-8") as f:
            json.dump(dict(video=clave, tramos=[0.0], cuadros=crudos[:60]), f)
        with open(os.path.join(DESTINO, "secuencias_veredicto", clave.replace("/", "_") + ".json"),
                  "w", encoding="utf-8") as f:
            json.dump(dict(id=clave, muestras=[dict(c, lm=c["lm"]) for c in muestras]), f)
        resumen_videos[clave] = dict(cuadros=LARGO, tiempo_ok=True, sin_etiqueta=0,
                                     muestras={"6fps": LARGO}, rostro={"6fps": LARGO},
                                     omitidos={"6fps": 0})

    with open(os.path.join(DESTINO, "nthu_muestras.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ex.CAMPOS)
        w.writeheader()
        w.writerows(filas)
    with open(os.path.join(DESTINO, "nthu_extraccion.json"), "w", encoding="utf-8") as f:
        json.dump(dict(ensayo=True, modelo=dict(archivo="sintetico"), versiones=dict(nota="ensayo"),
                       cadencias=ex.CADENCIAS, excluidos={}, videos=resumen_videos), f, indent=1)

    print(f"conjunto inventado: {N_VIDEOS} videos, {len(filas)} filas -> {DESTINO}", flush=True)
    r = subprocess.run([sys.executable, os.path.join(AQUI, "medir_nthu.py")], env=dict(os.environ))
    raise SystemExit(r.returncode)


if __name__ == "__main__":
    main()
