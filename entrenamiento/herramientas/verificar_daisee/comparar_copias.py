"""Compara la copia de DAiSEE usada en el proyecto con la distribución oficial.

Contexto: el modelo se entrenó y evaluó sobre la copia de Kaggle `olgaparfenova/daisee`,
a la que le faltaban 652 de los 9.068 clips (146 del test). El acceso oficial se pidió el
2026-09-29. Este script responde una sola pregunta: ¿los clips y las etiquetas que usamos
son idénticos a los oficiales?

Dos modos:
  etiquetas  compara los CSV de etiquetas de la copia (carpeta DAISEE_ETIQUETAS_COPIA) con los
             oficiales. No necesita videos.
  videos     compara, clip por clip, el SHA-256 de cada video de la copia con el oficial.

No abre ni decodifica ningún video y no escribe nada por cuadro: sólo nombres de clip,
hashes y conteos. Uso:

  python comparar_copias.py etiquetas --oficial RUTA_DAiSEE_OFICIAL
  python comparar_copias.py videos --oficial RUTA_DAiSEE_OFICIAL --copia RUTA_COPIA_KAGGLE
         [--lista archivo.npz|archivo.txt]   (clips efectivamente usados; si falta, todos)
"""
import argparse
import csv
import hashlib
import json
import os
import sys
from pathlib import Path

ETIQUETAS_COPIA = Path(os.environ.get('DAISEE_ETIQUETAS_COPIA', os.path.join('SparkleV2', 'labels')))
CSVS = ['AllLabels.csv', 'TrainLabels.csv', 'ValidationLabels.csv', 'TestLabels.csv']
EXT_VIDEO = {'.avi', '.mp4'}


def clip_id(nombre):
    """'1100011002.avi' -> '1100011002'. Las etiquetas de DAiSEE mezclan ambas formas."""
    return Path(nombre.strip()).stem


def leer_etiquetas(ruta):
    with open(ruta, newline='', encoding='utf-8-sig') as f:
        filas = list(csv.reader(f))
    encabezado = [c.strip() for c in filas[0]]
    datos = {}
    duplicados = 0
    for fila in filas[1:]:
        if not fila or not fila[0].strip():
            continue
        cid = clip_id(fila[0])
        if cid in datos:
            duplicados += 1
        datos[cid] = tuple(c.strip() for c in fila[1:])
    return encabezado, datos, duplicados


def buscar_csv(raiz, nombre):
    hallados = [p for p in Path(raiz).rglob(nombre) if p.is_file()]
    if len(hallados) != 1:
        sys.exit(f'Se esperaba exactamente un {nombre} bajo {raiz} y hay {len(hallados)}: {hallados}')
    return hallados[0]


def modo_etiquetas(args):
    resultado = {}
    for nombre in CSVS:
        enc_c, copia, dup_c = leer_etiquetas(ETIQUETAS_COPIA / nombre)
        enc_o, oficial, dup_o = leer_etiquetas(buscar_csv(args.oficial, nombre))
        comunes = copia.keys() & oficial.keys()
        distintas = sorted(c for c in comunes if copia[c] != oficial[c])
        resultado[nombre] = {
            'encabezado_igual': enc_c == enc_o,
            'filas_copia': len(copia),
            'filas_oficial': len(oficial),
            'duplicados_copia': dup_c,
            'duplicados_oficial': dup_o,
            'solo_en_copia': sorted(copia.keys() - oficial.keys()),
            'solo_en_oficial': sorted(oficial.keys() - copia.keys()),
            'etiqueta_distinta': distintas,
        }
    return resultado


def indexar_videos(raiz):
    indice = {}
    repetidos = []
    for p in Path(raiz).rglob('*'):
        if p.is_file() and p.suffix.lower() in EXT_VIDEO:
            cid = p.stem
            if cid in indice:
                repetidos.append(cid)
            indice[cid] = p
    return indice, sorted(set(repetidos))


def sha256(ruta, bloque=1 << 20):
    h = hashlib.sha256()
    with open(ruta, 'rb') as f:
        while chunk := f.read(bloque):
            h.update(chunk)
    return h.hexdigest()


def leer_lista(ruta):
    ruta = Path(ruta)
    if ruta.suffix == '.npz':
        import numpy as np
        return {str(c) for c in np.load(ruta, allow_pickle=True)['clip_ids']}
    return {clip_id(l) for l in ruta.read_text(encoding='utf-8').splitlines() if l.strip()}


def modo_videos(args):
    oficial, rep_o = indexar_videos(args.oficial)
    copia, rep_c = indexar_videos(args.copia)
    universo = leer_lista(args.lista) if args.lista else set(copia)
    iguales, distintos, falta_oficial, falta_copia = [], [], [], []
    for n, cid in enumerate(sorted(universo), 1):
        if cid not in copia:
            falta_copia.append(cid)
        elif cid not in oficial:
            falta_oficial.append(cid)
        elif sha256(copia[cid]) == sha256(oficial[cid]):
            iguales.append(cid)
        else:
            distintos.append(cid)
        if n % 500 == 0:
            print(f'  {n}/{len(universo)} clips comparados', file=sys.stderr)
    return {
        'videos_oficial': len(oficial),
        'videos_copia': len(copia),
        'repetidos_oficial': rep_o,
        'repetidos_copia': rep_c,
        'clips_comparados': len(universo),
        'identicos': len(iguales),
        'distintos': distintos,
        'ausentes_en_oficial': falta_oficial,
        'ausentes_en_copia': falta_copia,
        'faltan_en_copia_respecto_de_oficial': len(set(oficial) - set(copia)),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('modo', choices=['etiquetas', 'videos'])
    ap.add_argument('--oficial', required=True)
    ap.add_argument('--copia')
    ap.add_argument('--lista')
    ap.add_argument('--salida', default=None, help='JSON de salida (por defecto, junto al script)')
    args = ap.parse_args()
    if args.modo == 'videos' and not args.copia:
        ap.error('el modo videos necesita --copia')
    res = modo_etiquetas(args) if args.modo == 'etiquetas' else modo_videos(args)
    salida = Path(args.salida or Path(__file__).with_name(f'resultado_{args.modo}.json'))
    salida.write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(res, indent=2, ensure_ascii=False)[:4000])
    print(f'\nGuardado en {salida}')


if __name__ == '__main__':
    main()
