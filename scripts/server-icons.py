#!/usr/bin/env python3
"""
Draws Blockly's server icons: the picture an owner picks for their world, and Blockly's own,
which a server shows until they do.

One source, two outputs, so they can never drift:
  apps/web/public/server-icons/<key>.svg   what the pages show
  apps/control/assets/server-icons/<key>.png  64x64, what the game shows in the multiplayer list

The art is ours: sixteen-by-sixteen pixels in Blockly's palette, drawn here rather than taken
from Minecraft, whose textures belong to Mojang. Blockly's own picture is drawn on the full
64x64, since the mark's circles and curve need the finer grid: the mark over the word, in the
brand's Ink and Paper, square like every picture in the game's list. Run after changing a map:

    python3 scripts/server-icons.py
"""

import struct
import zlib
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
        {"i": "#181818", "p": "#f8f7f5"},
        [
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppiiiipppppppppiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppiiipppppppppppiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppiipppppppppppppiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppiipppppppppppppiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppiipppppppppppppiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppiipppppppppppppiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppiiipppppppppppiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppiiiipppppppppiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiipppppiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiipppppiiiiipppiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiipppppppppiiippppiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiipppppppppppiipppppiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppippppppiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppippppppiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiippppppppppppppipppppppppppppiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiippppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiippppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiippppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiippppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiipppppppppppppipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiipppppppppppiipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiipppppppppiiipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiipppppiiiiipppppppppppppppiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiippiiiiiiiippiiiiiiiiiiiiiiiiiiiiiippiiiiiiiippiiiiiiiiiiiiii",
            "iiiippiiiiiiiippiiiiiiiiiiiiiiiiiiiiiippiiiiiiiippiiiiiiiiiiiiii",
            "iiiippiiiiiiiippiiiiiiiiiiiiiiiiiiiiiippiiiiiiiippiiiiiiiiiiiiii",
            "iiiippiiiiiiiippiiiiiiiiiiiiiiiiiiiiiippiiiiiiiippiiiiiiiiiiiiii",
            "iiiippppppiiiippiiiippppiiiiiippppppiippiiiippiippiippiiiippiiii",
            "iiiippppppiiiippiiiippppiiiiiippppppiippiiiippiippiippiiiippiiii",
            "iiiippiiiippiippiippiiiippiippiiiiiiiippiippiiiippiippiiiippiiii",
            "iiiippiiiippiippiippiiiippiippiiiiiiiippiippiiiippiippiiiippiiii",
            "iiiippiiiippiippiippiiiippiippiiiiiiiippppiiiiiippiippiiiippiiii",
            "iiiippiiiippiippiippiiiippiippiiiiiiiippppiiiiiippiippiiiippiiii",
            "iiiippiiiippiippiippiiiippiippiiiiiiiippiippiiiippiiiippppppiiii",
            "iiiippiiiippiippiippiiiippiippiiiiiiiippiippiiiippiiiippppppiiii",
            "iiiippppppiiiippiiiippppiiiiiippppppiippiiiippiippiiiiiiiippiiii",
            "iiiippppppiiiippiiiippppiiiiiippppppiippiiiippiippiiiiiiiippiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiippppppiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiippppppiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
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


def png(key: str) -> bytes:
    """A 64x64 PNG: the size Minecraft wants for a server icon, drawn pixel for pixel."""
    palette, rows = rows_of(key)
    side = 64
    scale = side // len(rows)
    raw = bytearray()
    for y in range(side):
        raw.append(0)  # no filter for this row
        row = rows[y // scale]
        for x in range(side):
            ch = row[x // scale]
            if ch == ".":
                raw.extend((0, 0, 0, 0))
            else:
                colour = palette[ch].lstrip("#")
                raw.extend((int(colour[0:2], 16), int(colour[2:4], 16), int(colour[4:6], 16), 255))

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
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
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
