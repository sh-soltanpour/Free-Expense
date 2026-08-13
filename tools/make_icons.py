#!/usr/bin/env python3
"""Generate the extension's PNG icons. No third-party deps.

    python3 tools/make_icons.py

Draws a rounded green tile with a white dollar sign at 4x supersampling, then
box-filters down to each required size. The "$" is built from two circular
arcs (the S) plus a vertical bar, so it needs no font.
"""
import math
import struct
import zlib
from pathlib import Path

SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor
OUT = Path(__file__).resolve().parent.parent / "icons"

TOP = (0x34, 0xD3, 0x99)     # emerald, light at the top
BOTTOM = (0x05, 0x96, 0x69)  # deeper emerald at the bottom
GLYPH = (0xFF, 0xFF, 0xFF)


def rounded_rect_alpha(x, y, w, h, radius):
    """Coverage of a rounded rectangle at point (x, y), 0.0-1.0."""
    if x < radius:
        cx = radius
    elif x > w - radius:
        cx = w - radius
    else:
        cx = x
    if y < radius:
        cy = radius
    elif y > h - radius:
        cy = h - radius
    else:
        cy = y
    dx, dy = x - cx, y - cy
    dist = (dx * dx + dy * dy) ** 0.5
    return 1.0 if dist <= radius else 0.0


def on_arc(x, y, cx, cy, radius, width, omit):
    """True inside a circular stroke, skipping the `omit` angle range.

    Angles are degrees measured with y pointing down: 0 right, 90 below,
    180 left, 270 above.
    """
    dx, dy = x - cx, y - cy
    if abs(math.hypot(dx, dy) - radius) > width / 2:
        return False
    angle = math.degrees(math.atan2(dy, dx)) % 360
    lo, hi = omit
    return not (lo <= angle <= hi)


def dollar_alpha(x, y, size):
    """A dollar sign: an S from two arcs, with a bar through it."""
    cx, cy = size * 0.5, size * 0.5
    radius = size * 0.15
    width = size * 0.10

    # The vertical stroke, poking out past both bowls.
    if abs(x - cx) <= width * 0.40 and size * 0.17 <= y <= size * 0.83:
        return 1.0

    # Upper bowl: opens toward the bottom-right, so omit that quadrant.
    if on_arc(x, y, cx, cy - radius, radius, width, (0, 90)):
        return 1.0

    # Lower bowl: opens toward the top-left.
    if on_arc(x, y, cx, cy + radius, radius, width, (180, 270)):
        return 1.0

    return 0.0


def render(size):
    """Render one RGBA image at `size`, supersampled then averaged."""
    big = size * SS
    radius = big * 0.22
    rows = []

    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = px * SS + sx + 0.5
                    y = py * SS + sy + 0.5
                    tile = rounded_rect_alpha(x, y, big, big, radius)
                    if not tile:
                        continue
                    t = y / big
                    br = TOP[0] + (BOTTOM[0] - TOP[0]) * t
                    bg = TOP[1] + (BOTTOM[1] - TOP[1]) * t
                    bb = TOP[2] + (BOTTOM[2] - TOP[2]) * t
                    glyph = dollar_alpha(x, y, big)
                    r += br + (GLYPH[0] - br) * glyph
                    g += bg + (GLYPH[1] - bg) * glyph
                    b += bb + (GLYPH[2] - bb) * glyph
                    a += 1.0
            n = SS * SS
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((
                    round(r / a), round(g / a), round(b / a), round(255 * a / n)
                ))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        write_png(path, size, render(size))
        print(f"wrote {path.relative_to(OUT.parent)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
