"""Draw the app icon (a white basket on green) as PNG, no external libraries."""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GREEN, WHITE = (47, 125, 91), (255, 255, 255)


def inside(x, y):
    """Shape in unit coordinates (0..1). Icon is maskable: keep art in the centre 60%."""
    # handle: ring segment above the basket
    cx, cy, r, w = 0.5, 0.47, 0.17, 0.035
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    if y < cy and abs(d - r) < w:
        return True
    # basket body: trapezoid
    top, bot = 0.47, 0.72
    if top <= y <= bot:
        t = (y - top) / (bot - top)
        half = 0.25 - 0.06 * t
        if abs(x - 0.5) <= half:
            # three vertical slots
            for sx in (0.4, 0.5, 0.6):
                if abs(x - sx) < 0.022 and top + 0.06 < y < bot - 0.05:
                    return False
            return True
    # rim
    return 0.43 <= y < 0.47 and abs(x - 0.5) <= 0.28


def png(size, path):
    ss = 4  # supersampling for smooth edges
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            hits = sum(inside((px + (i + .5) / ss) / size, (py + (j + .5) / ss) / size)
                       for i in range(ss) for j in range(ss))
            a = hits / (ss * ss)
            row += bytes(round(GREEN[k] * (1 - a) + WHITE[k] * a) for k in range(3))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    open(path, "wb").write(data)


for n in (192, 512):
    png(n, os.path.join(ROOT, "app", "icons", f"icon-{n}.png"))
print("icons ok")
