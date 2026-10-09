# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools", "brotli", "resvg-py"]
# ///
"""Draws the wordmark and the lockups made from it.

    uv run brand/wordmark.py

The wordmark is "cubepals" outlined from Figtree 700, lowercase, at the spec in brand/README.md:
word 66, tracking −0.070em, the mark at 56 (85% of the word), a gap of 14 from the mark's box to
the word, the baseline at 50.1. The face is fontsource's Figtree 5.3.0, the same one the product's
live lockup loads from Google Fonts, fetched from jsDelivr and checked against its hash.

It writes the four lockup SVGs and their PNGs in brand/, and the web app's link preview
(apps/web/src/app/opengraph-image.png). The mark is copied from brand/mark.svg and never redrawn
here, so mark.svg, favicon.svg and app-icon.svg are not this script's to write.
"""

import hashlib
import re
import urllib.request
from io import BytesIO
from pathlib import Path

import resvg_py
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

WORD = 'cubepals'
NAME = 'Cubepals'
FONT_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/figtree@5.3.0/files/figtree-latin-700-normal.woff2'
FONT_SHA256 = '7ec4f08d09f91d349917dd6592f6aaae66d8fe1bbd58fa24707961e79236616e'

SIZE = 66  # the word
TRACKING = -0.070  # em, between letters
MARK = 56  # 85% of the word
GAP = 14  # from the mark's box to the word's origin
BASELINE = 50.1  # in the horizontal lockup
STACK_BASELINE = 126.1  # in the stacked one

INK = '#181818'
PAPER = '#F8F7F5'
BRAND = Path(__file__).parent
NO_PNG = {'lockup-stacked-reversed'}  # brand/png has never held one
PREVIEW = BRAND.parent / 'apps/web/src/app/opengraph-image.png'
PREVIEW_SIZE = (1200, 630)  # the lockup centred on Paper
PREVIEW_K = 2.36  # px per lockup unit, the size the preview has always drawn it at


def font() -> TTFont:
    data = urllib.request.urlopen(FONT_URL).read()
    if hashlib.sha256(data).hexdigest() != FONT_SHA256:
        raise SystemExit(f'{FONT_URL} is not the Figtree this was drawn from')
    return TTFont(BytesIO(data))


def num(v: float) -> str:
    s = f'{v:.3f}'.rstrip('0').rstrip('.')
    return '0' if s == '-0' else s


def letters(face: TTFont) -> tuple[list[str], tuple[float, float, float, float]]:
    """Each letter's path, at its place in the word, with the word's ink bounds."""
    glyphs, cmap, hmtx = face.getGlyphSet(), face.getBestCmap(), face['hmtx']
    scale = SIZE / face['head'].unitsPerEm
    bounds, paths, x = BoundsPen(glyphs), [], 0.0
    for ch in WORD:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs, ntos=num)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
        glyphs[name].draw(TransformPen(bounds, (scale, 0, 0, -scale, x, 0)))
        paths.append(pen.getCommands())
        x += hmtx[name][0] * scale + TRACKING * SIZE
    return paths, bounds.bounds


def mark(x: float, y: float) -> str:
    """The mark as brand/mark.svg draws it, placed; it takes the lockup's fill."""
    source = (BRAND / 'mark.svg').read_text()
    view = re.search(r'viewBox="([^"]+)"', source).group(1)
    body = re.search(r'<svg[^>]*>(.*)</svg>', source, re.S).group(1)
    return f'<svg x="{num(x)}" y="{num(y)}" width="{MARK}" height="{MARK}" viewBox="{view}">{body}</svg>'


def lockup(d: str, w: float, h: float, fill: str, mx: float, my: float, wx: float, wy: float) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(w)} {num(h)}" width="{num(w)}" '
        f'height="{num(h)}" fill="{fill}" role="img" aria-label="{NAME}">{mark(mx, my)}'
        f'<path transform="translate({num(wx)} {num(wy)})" d="{d}"/></svg>\n'
    )


def main() -> None:
    paths, (_, _, right, bottom) = letters(font())
    d = ''.join(paths)
    # The word's box runs from its origin to the edge of its ink, as it always has.
    horizontal = (MARK + GAP + right, BASELINE + bottom)
    stacked = (right, STACK_BASELINE + bottom)
    for suffix, fill in (('', INK), ('-reversed', PAPER)):
        files = {
            f'lockup-horizontal{suffix}': (
                lockup(d, *horizontal, fill, 0, 0, MARK + GAP, BASELINE),
                2000,
            ),
            f'lockup-stacked{suffix}': (
                lockup(d, *stacked, fill, (right - MARK) / 2, 0, 0, STACK_BASELINE),
                1400,
            ),
        }
        for name, (svg, width) in files.items():
            (BRAND / f'{name}.svg').write_text(svg)
            png = BRAND / 'png' / f'{name}.png'
            if name not in NO_PNG:
                png.write_bytes(bytes(resvg_py.svg_to_bytes(svg_string=svg, width=width)))
            print(name, num(width))
    w, h = PREVIEW_SIZE
    (lw, lh), k = horizontal, PREVIEW_K
    preview = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f'<rect width="{w}" height="{h}" fill="{PAPER}"/>'
        f'<g fill="{INK}" transform="translate({num((w - lw * k) / 2)} {num((h - lh * k) / 2)}) scale({k})">'
        f'{mark(0, 0)}<path transform="translate({num(MARK + GAP)} {num(BASELINE)})" d="{d}"/></g></svg>'
    )
    PREVIEW.write_bytes(bytes(resvg_py.svg_to_bytes(svg_string=preview, width=w)))
    print(PREVIEW.relative_to(BRAND.parent))


if __name__ == '__main__':
    main()
