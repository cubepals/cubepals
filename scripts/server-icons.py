#!/usr/bin/env python3

# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

"""
Draws Blockly's server icons: the picture an owner picks for their world, and Blockly's own,
which a server shows until they do.

One source, two outputs, so they can never drift:
  apps/web/public/server-icons/<key>.svg   what the pages show
  apps/control/assets/server-icons/<key>.png  64x64, what the game shows in the multiplayer list

The art is ours: sixteen-by-sixteen pixels in Blockly's palette, drawn here rather than taken
from Minecraft, whose textures belong to Mojang. Blockly's own picture is drawn on the full
64x64, since the mark's circles and curve need the finer grid: the mark alone, Ink on a square
of Paper, nearly filling it with a thin margin, drawn on a grid of two-pixel cells. It is the one
icon every Cubepals server shows until its owner picks another, Cubepals' own included, so it is
drawn once, here, and the PNG it writes is byte for byte the one Duels shows. Square, as the brand
draws a block, with no rounding. No word: the wordmark is only ever set as the brand draws it
(brand/README.md), and never the codename. Run after changing a map:

    python3 scripts/server-icons.py
"""

import math
import struct
import zlib
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SVG_DIR = ROOT / "apps/web/public/server-icons"
PNG_DIR = ROOT / "apps/control/assets/server-icons"

# Each icon is sixteen rows of sixteen characters; a dot is see-through.
ICONS: dict[str, tuple[dict[str, str], list[str]]] = {
    "grass": (
        {"L": "#8fd460", "g": "#6cc24a", "G": "#4f9c35", "d": "#9a6a44", "D": "#7a5134", "s": "#b98659"},
        [
            "gLgggLggggLggLgg",
            "gggGggggGgggGggg",
            "gGgggGggGgggGggg",
            "GDgGGDgGDGgGDGgG",
            "DdGDDdgDdDGDdDgD",
            "ddDdddGdddDdddGd",
            "ddddddDdddddddDd",
            "ddddsddddddsdddd",
            "dddddddddDdddddd",
            "dDDdddsddddddddd",
            "ddddddddddddDDdd",
            "dddsdddddsdddddd",
            "dddddDddddddddsd",
            "sdddddddddDDdddd",
            "ddDdddsddddddddd",
            "dddddddDddddsdDd",
        ],
    ),
    "stone": (
        {"s": "#9aa0a6", "S": "#7f868c", "l": "#b3b8bd"},
        [
            "ssslsssssSsssssl",
            "sSsssssslssssSss",
            "ssssSssssssslsss",
            "lssssssSssssssss",
            "sssslsssssSsssSs",
            "sSssssssslssssss",
            "sssssSsslsssssss",
            "slsssssssssSssss",
            "ssssSsslssssssls",
            "sssssssssSsssSss",
            "sSsslsssssssssss",
            "ssssssSsssslssss",
            "lsssSssssssssSss",
            "sssssssslsssssss",
            "ssSssslsssSsssss",
            "sssssssssssssSsl",
        ],
    ),
    "planks": (
        {"p": "#b07a46", "P": "#8d5f34", "l": "#c28f58"},
        [
            "pppppPppppppPppp",
            "plppppppplpppppp",
            "ppppPppppppppPpp",
            "PPPPPPPPPPPPPPPP",
            "ppPppppplppppppp",
            "pppppplppppPpppp",
            "plppppppppppplpp",
            "PPPPPPPPPPPPPPPP",
            "pppPppppppplpppp",
            "ppppppplpppppPpp",
            "pPpppppppppppppl",
            "PPPPPPPPPPPPPPPP",
            "pplpppppPppppppp",
            "ppppPppppppplppp",
            "plppppppPppppppp",
            "pppppPpppppppppP",
        ],
    ),
    "water": (
        {"w": "#3d7fd1", "W": "#2f66ab", "l": "#69a3e8"},
        [
            "wwwlwwwwwwwlwwww",
            "wWwwwwwlwwwwwWww",
            "wwwwwWwwwwwwwwlw",
            "lwwwwwwwwWwwwwww",
            "wwwWwwwlwwwwwwww",
            "wwwwwwwwwwWwwlww",
            "wlwwwWwwwwwwwwww",
            "wwwwwwwwlwwwWwww",
            "wwWwwlwwwwwwwwww",
            "wwwwwwwwwWwwwwlw",
            "lwwWwwwwwwwwwwww",
            "wwwwwwlwwwwWwwww",
            "wwwwWwwwwlwwwwww",
            "wlwwwwwwwwwwwWww",
            "wwwwwwWwwwwlwwww",
            "wwwlwwwwwWwwwwww",
        ],
    ),
    "diamond": (
        {"d": "#4fd6cf", "D": "#2fa9a3", "l": "#a7f0ec"},
        [
            "................",
            "................",
            "....DDDDDDDD....",
            "...DllddddllD...",
            "..DdlddddddldD..",
            ".DddldddddddddD.",
            "DdddddddddddddDD",
            ".DdddddddddddDD.",
            "..DdddddddddDD..",
            "...DddddddDDD...",
            "....DddddDDD....",
            ".....DddDDD.....",
            "......DdDD......",
            ".......DD.......",
            "................",
            "................",
        ],
    ),
    "redstone": (
        {"s": "#8f959b", "S": "#767c82", "t": "#a9aeb3", "r": "#e5463f", "R": "#a92c2c", "l": "#ffa196"},
        [
            "sssSssssstssssss",
            "sslrssssssssSsss",
            "slrrRsssssslssss",
            "srrRRsSssslrRsss",
            "ssRRsssssssRssst",
            "Ssssssssssstssss",
            "sssssssSssssssss",
            "sssstsssssssssSs",
            "ssssssssslrsssss",
            "sssssSsslrrRssss",
            "tsslssssrrRRssss",
            "sslrRssssRRsssss",
            "sssRssssssssslrt",
            "sssssstssssssrRs",
            "sSssssssssssssss",
            "ssstssssSssssSss",
        ],
    ),
    "torch": (
        {"f": "#ffd166", "F": "#f0932b", "w": "#8d5f34", "W": "#6f4a28"},
        [
            "................",
            "................",
            ".......FF.......",
            "......FffF......",
            "......fffF......",
            ".......ff.......",
            "......wWWw......",
            "......wWWw......",
            "......wWWw......",
            "......wWWw......",
            "......wWWw......",
            "......wWWw......",
            "......wWWw......",
            "......wWWw......",
            "................",
            "................",
        ],
    ),
    "chest": (
        {"c": "#b07a46", "C": "#8d5f34", "k": "#4a3520", "m": "#d9b25a"},
        [
            "................",
            "................",
            "..kkkkkkkkkkkk..",
            "..kcccccccccck..",
            "..kcCcccccCcck..",
            "..kccccmmcccck..",
            "..kkkkkmmkkkkk..",
            "..kccccmmcccck..",
            "..kcccccccccck..",
            "..kcCccccccCck..",
            "..kcccccccccck..",
            "..kcCcccccCcck..",
            "..kcccccccccck..",
            "..kkkkkkkkkkkk..",
            "................",
            "................",
        ],
    ),
    "heart": (
        {"r": "#e05260", "R": "#b23a46", "l": "#f58a94"},
        [
            "................",
            "................",
            "..rrrr....rrrr..",
            ".rllrrr..rrrrrr.",
            "rlrrrrrrrrrrrrrr",
            "rlrrrrrrrrrrrrrr",
            "rrrrrrrrrrrrrrrr",
            ".rrrrrrrrrrrrrr.",
            "..rrrrrrrrrrrr..",
            "...rrrrrrrrrr...",
            "....rrrrrrrr....",
            ".....rrrrrr.....",
            "......rrrr......",
            ".......rr.......",
            "................",
            "................",
        ],
    ),
    "blockly": (
        {"i": "#0d0d0d", "p": "#f8f7f5"},
        [
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "ppppppppppppppppppppppppppppppppppppppiiiiiiiiiiiipppppppppppppp",
            "ppppppppppppppppppppppppppppppppppppppiiiiiiiiiiiipppppppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppppiiiiiiiiiiiiiiiipppppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppppiiiiiiiiiiiiiiiipppppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiipppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiipppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiipppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiipppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppppiiiiiiiiiiiiiiiipppppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippppppiiiiiiiiiiiiiiiipppppppppppp",
            "ppppppppppppppppppppppppppppppppppppppppiiiiiiiipppppppppppppppp",
            "ppppppppppppppppppppppppppppppppppppppppiiiiiiiipppppppppppppppp",
            "ppppppppppppppppiiiiiiiippppppppppiipppppppppppppppppppppppppppp",
            "ppppppppppppppppiiiiiiiippppppppppiipppppppppppppppppppppppppppp",
            "ppppppppppppiiiiiiiiiiiiiiiippppiiiiiiiipppppppppppppppppppppppp",
            "ppppppppppppiiiiiiiiiiiiiiiippppiiiiiiiipppppppppppppppppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiipppppppppppppppppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiipppppppppppppppppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiipppppppppppppppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiipppppppppppppppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppiiiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppiiiiiiiiiiiiiiiiiiiippiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppppiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppppiiiiiiiiiiiiiiiippppiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppppppiiiiiiiiiiiippppppiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "ppppppppppppppiiiiiiiiiiiippppppiiiiiiiiiiiiiiiiiiiiiiiipppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
            "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
        ],
    ),
}


def rows_of(key: str) -> tuple[dict[str, str], list[str]]:
    palette, rows = ICONS[key]
    side = len(rows)
    if side not in (16, 64) or any(len(row) != side for row in rows):
        raise SystemExit(f"{key}: an icon is 16 rows of 16 characters, or 64 of 64")
    for row in rows:
        for ch in row:
            if ch != "." and ch not in palette:
                raise SystemExit(f"{key}: no colour for {ch!r}")
    return palette, rows


def svg(key: str) -> str:
    palette, rows = rows_of(key)
    side = len(rows)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}" shape-rendering="crispEdges" role="img">'
    ]
    for y, row in enumerate(rows):
        x = 0
        while x < side:
            ch = row[x]
            if ch == ".":
                x += 1
                continue
            run = 1
            while x + run < side and row[x + run] == ch:
                run += 1
            parts.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="{palette[ch]}"/>')
            x += run
    parts.append("</svg>")
    return "".join(parts) + "\n"


def filtered(kind: int, line: bytes, above: bytes) -> bytes:
    """A row under one of PNG's five filters, four bytes a pixel."""
    out = bytearray(len(line))
    for i, value in enumerate(line):
        a = line[i - 4] if i >= 4 else 0
        b = above[i]
        c = above[i - 4] if i >= 4 else 0
        if kind == 0:
            guess = 0
        elif kind == 1:
            guess = a
        elif kind == 2:
            guess = b
        elif kind == 3:
            guess = (a + b) // 2
        else:
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            guess = a if pa <= pb and pa <= pc else b if pb <= pc else c
        out[i] = (value - guess) & 0xFF
    return bytes(out)


def entropy(data: bytes) -> float:
    counts = Counter(data)
    return -sum(n / len(data) * math.log2(n / len(data)) for n in counts.values())


def deflated(data: bytes) -> bytes:
    """zlib at its smallest, run-length only: what every icon's IDAT holds."""
    packer = zlib.compressobj(9, zlib.DEFLATED, 15, 9, zlib.Z_RLE)
    return packer.compress(data) + packer.flush()


def png(key: str) -> bytes:
    """A 64x64 PNG: the size Minecraft wants for a server icon, drawn pixel for pixel."""
    palette, rows = rows_of(key)
    side = 64
    scale = side // len(rows)
    raw = bytearray()
    above = bytes(side * 4)
    for y in range(side):
        line = bytearray()
        row = rows[y // scale]
        for x in range(side):
            ch = row[x // scale]
            if ch == ".":
                line.extend((0, 0, 0, 0))
            else:
                colour = palette[ch].lstrip("#")
                line.extend((int(colour[0:2], 16), int(colour[2:4], 16), int(colour[4:6], 16), 255))
        # Each row takes the filter whose bytes vary least, the lowest first on a tie: with the
        # compression below, the same pixels always give the same file.
        kind, body = min(
            ((kind, filtered(kind, bytes(line), above)) for kind in range(5)),
            key=lambda pair: (entropy(pair[1]), pair[0]),
        )
        raw.append(kind)
        raw.extend(body)
        above = bytes(line)

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", side, side, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", deflated(bytes(raw)))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    SVG_DIR.mkdir(parents=True, exist_ok=True)
    PNG_DIR.mkdir(parents=True, exist_ok=True)
    for key in ICONS:
        (SVG_DIR / f"{key}.svg").write_text(svg(key))
        (PNG_DIR / f"{key}.png").write_bytes(png(key))
    print(f"{len(ICONS)} icons → {SVG_DIR.relative_to(ROOT)} and {PNG_DIR.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
