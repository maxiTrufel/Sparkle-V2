"""Baja BIWI Kinect Head Pose desde el espejo de HF y lo descomprime.

El repo oficial de ETH (data.vision.ee.ethz.ch) devuelve 403 y el dataset ya no
está en Kaggle; el repo ETHZurich/biwi_kinect_head_pose de HF es solo un script
de carga que apunta a esa URL muerta. ZihanWang1029/BIWI tiene los datos reales
(verificado: females.txt trae rutas ./data/NN/frame_XXXXX_rgb.png).
"""
import os, sys, zipfile
from huggingface_hub import hf_hub_download

DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "biwi")
os.makedirs(DEST, exist_ok=True)

for z in ("BIWI/BK-1.zip", "BIWI/BK-2.zip"):
    print(f"[bajando] {z} ...", flush=True)
    p = hf_hub_download("ZihanWang1029/BIWI", z, repo_type="dataset")
    print(f"  ok -> {p} ({os.path.getsize(p)/1e6:.0f} MB)", flush=True)
    print(f"[descomprimiendo] {z} ...", flush=True)
    with zipfile.ZipFile(p) as zf:
        zf.extractall(DEST)
    print(f"  descomprimido en {DEST}", flush=True)

# Inventario
poses = []
for root, _, files in os.walk(DEST):
    for f in files:
        if f.endswith("_pose.txt"):
            poses.append(os.path.join(root, f))
print(f"\nTOTAL archivos _pose.txt: {len(poses)}")
sujetos = sorted({os.path.basename(os.path.dirname(p)) for p in poses})
print(f"sujetos: {len(sujetos)} -> {sujetos}")
