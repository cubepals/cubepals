# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools", "brotli", "resvg-py", "pillow", "numpy"]
# ///
"""Draws the site's link preview, apps/web/src/app/opengraph-image.png.

    uv run brand/card.py

The card says what the landing's first screen says: "Minecraft server hosting for friends" over
"Send your friends / the address. / They’re in.", set on the hero's lines (landing/film/Film.tsx)
in Geologica 800 with its corners cut square, at the display type's tracking and leading
(landing.css). Beside it is the chunk by day as the site already prints it
(apps/web/public/imagery/chunk-awake.png), printed again at half its size in Ink on Paper. In the
top right, over the print's empty sky, is the lockup as wordmark.py draws it, with the address
under it. The bottom left holds nothing, since X lays the page's title over it.

The faces are fontsource's, fetched from jsDelivr and checked against their hashes, and set by
resvg from instances made here. Not for the lockups, which are wordmark.py's.
"""

import base64
import hashlib
import tempfile
import urllib.request
from io import BytesIO
from pathlib import Path

import numpy as np
import resvg_py
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image
from wordmark import BASELINE, BRAND, GAP, INK, MARK, PAPER, font, letters, mark, num

CARD = BRAND.parent / 'apps/web/src/app/opengraph-image.png'
SIZE = (1200, 630)  # what the site's metadata says the card is (apps/web/src/lib/site.ts)
STILL = BRAND.parent / 'apps/web/public/imagery/chunk-awake.png'

GEOLOGICA = (
    'https://cdn.jsdelivr.net/npm/@fontsource-variable/geologica@5.3.0/files/geologica-latin-full-normal.woff2',
    '94045871535a36295865420e2e8f23b11cbd11460fb817246ea58a0a7eff3a0e',
)
PLEX_MONO = (
    'https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.3.0/files/ibm-plex-mono-latin-500-normal.woff2',
    '01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22',
)

EYEBROW = 'Minecraft server hosting for friends'
HEADLINE = ('Send your friends', 'the address.', 'They’re in.')
ADDRESS = 'cubepals.com'

LEFT = 64  # the words' edge
TOP = 76  # the eyebrow's baseline
EYEBROW_SIZE = 27
HEAD_TOP = 165  # the headline's first baseline
HEAD_SIZE = 74  # "Send your friends" is about 8.1 of this wide: it ends before the house
HEAD_LEADING = 0.86  # .bl-display's line height
HEAD_TRACKING = -0.055  # em, .bl-display's
SCALE = 0.5  # the print's size on the card, against the site's
PRINT_AT = (420, -40)  # where its top-left corner lands, so it runs off the card's right and foot
LOCKUP_K = 0.62  # px per lockup unit: about 200 wide, past the lockup's 120 minimum
LOCKUP_RIGHT = 56  # from the card's right edge to the lockup's
LOCKUP_TOP = 44
ADDRESS_SIZE = 22
ADDRESS_DROP = 34  # from the lockup's baseline to the address's


def fetch(url: str, sha: str) -> TTFont:
    data = urllib.request.urlopen(url).read()
    if hashlib.sha256(data).hexdigest() != sha:
        raise SystemExit(f'{url} is not the face this was drawn from')
    return TTFont(BytesIO(data))


def instance(face: TTFont, family: str, axes: dict[str, float], to: Path) -> str:
    """One fixed instance of a variable face, under a family name of its own, written as a TTF."""
    fixed = instantiateVariableFont(face, axes) if axes else face
    for record in fixed['name'].names:
        if record.nameID in (1, 4, 16):
            record.string = family
    fixed.flavor = None
    path = to / f'{family}.ttf'
    fixed.save(path)
    return str(path)


def bayer() -> np.ndarray:
    """The 8 by 8 ordered dither of the landing's printer (engine/print-pass.ts), as thresholds."""
    m = np.zeros((1, 1))
    for _ in range(3):
        m = np.block([[4 * m, 4 * m + 2], [4 * m + 3, 4 * m + 1]])
    return (m + 0.5) / 64


def still() -> tuple[str, int, int]:
    """The day print at the card's scale, a dot to a pixel, as a data URL with its size.

    A scaled print shimmers, so it is printed again instead: its tones are taken back from the
    dots, resized as tones, and dithered again.
    """
    source = Image.open(STILL).convert('L').point(lambda v: 255 if v > 128 else 0)
    w, h = round(source.width * SCALE), round(source.height * SCALE)
    tone = np.asarray(source.resize((w, h), Image.BOX), dtype=float) / 255
    dots = tone > np.tile(bayer(), (h // 8 + 1, w // 8 + 1))[:h, :w]
    picture = Image.fromarray(dots.astype(np.uint8), 'P')
    picture.putpalette([int(c[i : i + 2], 16) for c in (INK, PAPER) for i in (1, 3, 5)])
    out = BytesIO()
    picture.save(out, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode(), w, h


def card(lockup: str, lockup_w: float) -> str:
    w, h = SIZE
    href, pw, ph = still()
    step = HEAD_SIZE * HEAD_LEADING
    lines = ''.join(
        f'<tspan x="{LEFT}" y="{num(HEAD_TOP + n * step)}">{line}</tspan>' for n, line in enumerate(HEADLINE)
    )
    lx = w - LOCKUP_RIGHT - lockup_w * LOCKUP_K
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f'<rect width="{w}" height="{h}" fill="{PAPER}"/>'
        f'<image x="{PRINT_AT[0]}" y="{PRINT_AT[1]}" width="{pw}" height="{ph}" '
        f'image-rendering="optimizeSpeed" href="{href}"/>'
        f'<g fill="{INK}">'
        f'<text x="{LEFT}" y="{TOP}" font-family="Card Text" font-size="{EYEBROW_SIZE}">{EYEBROW}</text>'
        f'<text font-family="Card Display" font-size="{HEAD_SIZE}" '
        f'letter-spacing="{num(HEAD_TRACKING * HEAD_SIZE)}">{lines}</text>'
        f'<g transform="translate({num(lx)} {LOCKUP_TOP}) scale({LOCKUP_K})">{lockup}</g>'
        f'<text x="{num(w - LOCKUP_RIGHT)}" y="{num(LOCKUP_TOP + BASELINE * LOCKUP_K + ADDRESS_DROP)}" '
        f'text-anchor="end" font-family="Card Mono" font-size="{ADDRESS_SIZE}">{ADDRESS}</text>'
        f'</g></svg>'
    )


def main() -> None:
    paths, (_, _, right, _) = letters(font())
    lockup = f'{mark(0, 0)}<path transform="translate({num(MARK + GAP)} {num(BASELINE)})" d="{"".join(paths)}"/>'
    geologica = fetch(*GEOLOGICA)
    with tempfile.TemporaryDirectory() as tmp:
        to = Path(tmp)
        faces = [
            instance(geologica, 'Card Display', {'wght': 800, 'SHRP': 100}, to),
            instance(geologica, 'Card Text', {'wght': 600, 'SHRP': 30}, to),
            instance(fetch(*PLEX_MONO), 'Card Mono', {}, to),
        ]
        svg = card(lockup, MARK + GAP + right)
        CARD.write_bytes(bytes(resvg_py.svg_to_bytes(svg_string=svg, width=SIZE[0], font_files=faces)))
    print(CARD.relative_to(BRAND.parent))


if __name__ == '__main__':
    main()
