#!/usr/bin/env python3
"""Writes the neutral default brand images (a play mark in a ring) over assets/images and assets/favicons.
Operators replace them from the operator panel; these only show until they do. Needs Pillow.
  python3 tools/branding/make-neutral-assets.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
IMG = os.path.join(ROOT, 'assets', 'images')
SS = 4  # supersampling for smooth edges
TOP, BOTTOM, DARK = (139, 108, 255), (84, 60, 214), (21, 18, 45)


def mark(size, ring_only_alpha=False):
    """Square RGBA image: gradient disc with a white play triangle (or, for monochrome icons, a white shape on transparent)."""
    n = size * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    disc = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    if ring_only_alpha:
        fill = Image.new('RGBA', (n, n), (255, 255, 255, 255))
    else:
        fill = Image.new('RGBA', (n, n))
        px = fill.load()
        for y in range(n):
            t = y / (n - 1)
            c = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
            for x in range(n):
                px[x, y] = c
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, n - 1, n - 1), fill=255)
    disc.paste(fill, (0, 0), mask)
    img = Image.alpha_composite(img, disc)
    d = ImageDraw.Draw(img)
    cx, cy, r = n / 2, n / 2, n * 0.22
    tri = [(cx - r * 0.7 + r * 0.25, cy - r), (cx - r * 0.7 + r * 0.25, cy + r), (cx + r * 1.0 + r * 0.25, cy)]
    if ring_only_alpha:
        d.polygon(tri, fill=(0, 0, 0, 0))  # cut-out triangle: reads as a shape on any colour
        img = Image.composite(Image.new('RGBA', (n, n), (0, 0, 0, 0)), img, Image.new('L', (n, n), 0)) if False else img
        a = img.split()[3]
        cut = Image.new('L', (n, n), 255)
        ImageDraw.Draw(cut).polygon(tri, fill=0)
        img.putalpha(Image.composite(a, Image.new('L', (n, n), 0), cut))
    else:
        d.polygon(tri, fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def on_square(size, mark_share, rounded=True):
    """Icon: dark square (rounded unless full-bleed for maskable) with the mark centred at mark_share of the width."""
    n = size * SS
    bg = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(bg).rounded_rectangle((0, 0, n - 1, n - 1), radius=int(n * 0.22), fill=DARK + (255,)) if rounded else ImageDraw.Draw(bg).rectangle((0, 0, n, n), fill=DARK + (255,))
    m = mark(int(size * mark_share)).resize((int(size * mark_share * SS),) * 2, Image.LANCZOS)
    bg.paste(m, ((n - m.width) // 2, (n - m.height) // 2), m)
    return bg.resize((size, size), Image.LANCZOS)


def save(img, name, folder=IMG):
    img.save(os.path.join(folder, name))
    print('wrote', name, img.size)


save(mark(256), 'stremio_symbol.png')  # file name kept: the client and the operator panel ask for this address
for size, name in ((512, 'icon.png'), (196, 'icon_196x196.png'), (512, 'icon_512x512.png')):
    save(on_square(size, 0.62), name)
for size, name in ((512, 'maskable_icon.png'), (196, 'maskable_icon_196x196.png'), (512, 'maskable_icon_512x512.png')):
    save(on_square(size, 0.5, rounded=False), name)
save(mark(512, ring_only_alpha=True), 'monochrome_icon_512x512.png')
wide = Image.new('RGBA', (670, 195), (0, 0, 0, 0))
m = mark(170)
wide.paste(m, ((670 - 170) // 2, (195 - 170) // 2), m)
save(wide, 'logo.png')
fav = on_square(64, 0.66)
fav.save(os.path.join(ROOT, 'assets', 'favicons', 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
print('wrote favicon.ico')
splash = os.path.join(IMG, 'splash')
for name in sorted(os.listdir(splash)):
    p = os.path.join(splash, name)
    w, h = Image.open(p).size
    canvas = Image.new('RGB', (w, h), DARK)
    s = int(min(w, h) * 0.2)
    m = mark(s)
    canvas.paste(m, ((w - s) // 2, (h - s) // 2), m)
    canvas.save(p, quality=90)
print('wrote', len(os.listdir(splash)), 'splash images')
