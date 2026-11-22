import cv2, glob, os
raiz = os.environ.get("EYEBLINK8_RAIZ", os.path.join("datasets", "Eyeblink8"))
for d in sorted(os.listdir(raiz), key=int):
    for p in glob.glob(os.path.join(raiz, d, "*.avi")):
        c = cv2.VideoCapture(p)
        cc = int(c.get(cv2.CAP_PROP_FOURCC)).to_bytes(4, "little").decode(errors="replace")
        print(f"{d:>2} {os.path.basename(p)} | fps {c.get(cv2.CAP_PROP_FPS):.3f} | cuadros {int(c.get(cv2.CAP_PROP_FRAME_COUNT))} | "
              f"{int(c.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(c.get(cv2.CAP_PROP_FRAME_HEIGHT))} | fourcc {cc}")
        c.release()
