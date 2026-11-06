"""Draw the app icon (a white house with a heart, on green) as PNG, no external libraries."""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GREEN, WHITE = (47, 125, 91), (255, 255, 255)


def heart(x, y, cx=0.5, cy=0.605, s=0.098):
    X, Y = (x - cx) / s, -(y - cy) / s
    return (X * X + Y * Y - 1) ** 3 - X * X * Y ** 3 <= 0


def inside(x, y):
    """Shape in unit coordinates (0..1). Icon is maskable: keep art in the centre 60%."""
    if heart(x, y):
        return False  # heart cut out of the house
    # roof: triangle from the apex down to the eaves
    apex, eaves = 0.23, 0.49
    if apex <= y <= eaves and abs(x - 0.5) <= 0.30 * (y - apex) / (eaves - apex):
        return True
    # chimney
    if 0.62 <= x <= 0.68 and 0.29 <= y <= 0.42:
        return True
    # walls
    return 0.29 <= x <= 0.71 and 0.48 <= y <= 0.77


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
