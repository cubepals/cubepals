#!/usr/bin/env python3

# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

"""
Draws the icons for the ways to play, as the create page shows them: Survival, Creative, Hardcore,
Smoother survival, Create, Lifesteal, Manhunt, Skyblock, OneBlock, RPG survival, Duels, a modpack
and a pack you have.

The same art as scripts/server-icons.py draws for servers: sixteen-by-sixteen pixels in Blockly's
palette, our own rather than Minecraft's, whose textures belong to Mojang. These are items, as the
game draws items: flat, outlined, lit from the upper left, with air around them, so they read as a
set of things to pick up rather than as a server's own picture. Run after changing a map:

    python3 scripts/play-icons.py
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SVG_DIR = ROOT / "apps/web/public/play-icons"

# Each icon is its name, a palette, and sixteen rows of sixteen characters; a dot is see-through.
ICONS: dict[str, tuple[str, dict[str, str], list[str]]] = {
    # Survival: an iron sword, tip up and to the right as items are held.
    "survival": (
        "Survival",
        {"o": "#2b3136", "w": "#f1f4f6", "b": "#b9c1c7", "k": "#7a5134", "h": "#a06d3f", "H": "#6f4a28"},
        [
            ".............oo.",
            "............owbo",
            "...........owwbo",
            "..........owwbo.",
            ".........owwbo..",
            "........owwbo...",
            "...o...owwbo....",
            "..oko.owwbo.....",
            "...okowwbo......",
            "....okooo.......",
            "...ohoko........",
            "..oho.oko.......",
            ".oHo...o........",
            "oko.............",
            ".o..............",
            "................",
        ],
    ),
    # Creative: blocks to build with, three of them stacked.
    "creative": (
        "Creative",
        {
            "o": "#2b3136",
            "g": "#6cc24a", "G": "#4f9c35", "L": "#8fd460", "d": "#9a6a44", "D": "#7a5134",
            "p": "#c8955a", "P": "#a3743f", "q": "#dcae74",
            "s": "#9aa0a6", "S": "#7f868c", "t": "#b3b8bd",
        },
        [
            "................",
            "................",
            "....oooooooo....",
            "....oLgLggGo....",
            "....ogGgLgGo....",
            "....oddDdddo....",
            "....odDddDdo....",
            "....oddddDdo....",
            "oooooooooooooooo",
            "oqqpqpqooqtsstso",
            "oppPppPoosSssSso",
            "opPpppPoossstsso",
            "oqqpqqpoossSsSso",
            "oppPppPoosssssso",
            "opppPppostsSssso",
            "oooooooooooooooo",
        ],
    ),
    # Hardcore: a heart, as players know hardcore from the game's own hearts; ours, lit from the
    # upper left, deeper than the server icons' heart so the two don't read as one.
    "hardcore": (
        "Hardcore",
        {"o": "#2b3136", "r": "#e0404f", "R": "#a82838", "l": "#ff8f99", "w": "#ffffff"},
        [
            "................",
            "................",
            "...ooo....ooo...",
            "..orrro..orrro..",
            ".orllrroorrrrRo.",
            ".olrwrrrrrrrrRo.",
            ".olrrrrrrrrrrRo.",
            ".orrrrrrrrrrrRo.",
            "..orrrrrrrrrRo..",
            "...orrrrrrrRo...",
            "....orrrrrRo....",
            ".....orrrRo.....",
            "......oRRo......",
            ".......oo.......",
            "................",
            "................",
        ],
    ),
    # Smoother survival: a potion of swiftness, a quick blue.
    "smooth": (
        "Smoother survival",
        {"o": "#2b3136", "c": "#a06d3f", "C": "#6f4a28", "g": "#d8eef7", "l": "#8fd3f4", "m": "#4aa8de", "M": "#2f78b3", "w": "#ffffff"},
        [
            "................",
            "......oooo......",
            "......occo......",
            "......oCCo......",
            ".......oo.......",
            "......ogwo......",
            "......oggo......",
            ".....oogggoo....",
            "....ogwllllgo...",
            "...ogwlllmmmgo..",
            "...ogllmmmmmgo..",
            "...oglmmmmmMgo..",
            "...ogmmmmmMMgo..",
            "....ogmmMMMgo...",
            ".....oggggggo...",
            "......oooooo....",
        ],
    ),
    # Create: a brass cogwheel, the mod's own sign.
    "create": (
        "Create",
        {"o": "#2b3136", "y": "#e2b857", "Y": "#f3d98a", "D": "#a57b28", "h": "#6b5320"},
        [
            "................",
            "................",
            "......oooo......",
            "...oo.oYYo.oo...",
            "...oYooYyooyo...",
            "....oYyyyyyo....",
            "..oooyyooyyooo..",
            "..oYyyohhoyyyo..",
            "..oYyyohhoyyDo..",
            "..oooyyooyyooo..",
            "....oyyyyyDo....",
            "...oyooyDooDo...",
            "...oo.oDDo.oo...",
            "......oooo......",
            "................",
            "................",
        ],
    ),
    # Lifesteal: a heart cracked in two, one half taken; brighter than Hardcore's whole heart, so
    # the two don't read as one.
    "lifesteal": (
        "Lifesteal",
        {"o": "#2b3136", "r": "#f05a66", "l": "#ffa3ab", "w": "#ffffff", "R": "#a82838", "D": "#7d1c2a"},
        [
            "................",
            "................",
            "...ooo....ooo...",
            "..orrro..oRRRo..",
            ".orllrrooRRRRDo.",
            ".olrwrroRRRRRDo.",
            ".olrrrrroRRRRDo.",
            ".orrrrroRRRRRDo.",
            "..orrrrroRRRDo..",
            "...orrroRRRDo...",
            "....orrroRDo....",
            ".....oroRRo.....",
            "......orDo......",
            ".......oo.......",
            "................",
            "................",
        ],
    ),
    # Manhunt: a compass, the hunters' own, its needle turned toward whoever runs.
    "manhunt": (
        "Manhunt",
        {"o": "#2b3136", "s": "#b9c1c7", "S": "#7f868c", "t": "#e3e7ea", "w": "#f6f1e4", "r": "#e0404f", "R": "#a82838", "n": "#7f868c"},
        [
            "................",
            "................",
            ".....oooooo.....",
            "...oottttssoo...",
            "..otswwwwwwsSo..",
            "..otwwwwwwrrSo..",
            ".otwwwwwwrRwwSo.",
            ".otwwwwwrRwwwSo.",
            ".oswwwwooowwwSo.",
            ".oswwwnnowwwwSo.",
            ".oswwnnwwwwwwSo.",
            "..oswnwwwwwwSo..",
            "..osswwwwwwSSo..",
            "...ooSSSSSSoo...",
            ".....oooooo.....",
            "................",
        ],
    ),
    # Skyblock: a small island over nothing, a tree on its grass and stone tapering below.
    "skyblock": (
        "Skyblock",
        {
            "o": "#2b3136",
            "L": "#8fd460", "l": "#6cc24a", "G": "#4f9c35",
            "k": "#a06d3f", "K": "#6f4a28",
            "g": "#6cc24a", "d": "#9a6a44", "D": "#7a5134",
            "s": "#9aa0a6", "S": "#7f868c",
        },
        [
            "................",
            ".....oooo.......",
            "....oLLllo......",
            "...oLllllGo.....",
            "...olllllGo.....",
            "....oGlGGo......",
            ".....okKo.......",
            ".....okKo.......",
            "ooooooooooooooo.",
            "oglgggglgggglgo.",
            "oddDddddDdddddo.",
            ".odddDdddddDdo..",
            "..osSsssSssso...",
            "...osssSssoo....",
            ".....ossSo......",
            "......ooo.......",
        ],
    ),
    # OneBlock: the one block, grass on dirt, floating over its own shadow with nothing else around.
    "oneblock": (
        "OneBlock",
        {
            "o": "#2b3136",
            "L": "#8fd460", "l": "#7cc852", "g": "#5aa83c", "G": "#3f7f2a",
            "d": "#9a6a44", "D": "#6f4a28", "K": "#5a3a20",
            "s": "#9aa7b1",
        },
        [
            "......oooo......",
            "....ooLLLLoo....",
            "..ooLLLLlLLLoo..",
            ".oLLlLLLLLLLLLo.",
            ".oggLLLLLLLlGGo.",
            ".oggggLLLLGGGGo.",
            ".ogggggGGGGGGGo.",
            ".odgddgdDDGDDDo.",
            ".oddddddDDDDDDo.",
            ".odDdddddDDKDDo.",
            "..oodddddDDDoo..",
            "....ooddDDoo....",
            "......oooo......",
            "................",
            "....ssssssss....",
            "................",
        ],
    ),
    # RPG survival: a book of skills, bound in purple with a gold mark, a spark beside it as it
    # glows.
    "rpg": (
        "RPG survival",
        {"o": "#2b3136", "p": "#7a4fc4", "P": "#4f2f8f", "l": "#a07ae0", "y": "#e2b857", "w": "#f6f1e4", "W": "#cfc6b3", "s": "#f3d98a"},
        [
            "................",
            "..............s.",
            "..oooooooooo.sws",
            "..oPllllllwo..s.",
            "..oylpppppwo....",
            "..oPlpppppwo....",
            "..oPlppyppwo....",
            "..oPlpyyypwo....",
            "..oPlppyppwo....",
            "..oPlpppppwo....",
            "..oPlpppppwo....",
            "..oylppppPwo....",
            "..oPPPPPPPWo....",
            "..oooooooooo....",
            "................",
            "................",
        ],
    ),
    # Duels: two swords crossed, iron over gold, one for each side.
    "duels": (
        "Duels",
        {
            "o": "#2b3136",
            "w": "#f1f4f6", "b": "#b9c1c7",
            "y": "#f3d36b", "Y": "#c9962e",
            "k": "#7a5134", "h": "#a06d3f", "H": "#6f4a28",
        },
        [
            ".oo..........oo.",
            "oyYo........owbo",
            "oyYYo......owwbo",
            ".oyYYo....owwbo.",
            "..oyYYo..owwbo..",
            "...oyYYoowwbo...",
            "...ooyYYwwboo...",
            "..okooywwbooko..",
            "...okowwbYoko...",
            "....okooooko....",
            "...ohokookoho...",
            "..oho.okko.oho..",
            ".oHo...oo...oHo.",
            "oko..........oko",
            ".o............o.",
            "................",
        ],
    ),
    # A modpack: a bundle, many things carried as one.
    "modpack": (
        "A modpack",
        {"o": "#2b3136", "l": "#c8915a", "L": "#e0ae78", "b": "#a06d3f", "B": "#7a5134", "s": "#d9b25a", "S": "#a57b28"},
        [
            "................",
            "................",
            "......oooo......",
            ".....osSSso.....",
            "......oSSo......",
            ".....oLlllo.....",
            "....oLllllbo....",
            "...oLllllllbo...",
            "...oLllllllbo...",
            "...olllllllbo...",
            "...olllllllBo...",
            "...obllllllBo...",
            "....obbbbbBo....",
            ".....oooooo.....",
            "................",
            "................",
        ],
    ),
    # A pack you have: a chest, where what's yours is kept, its latch on the front.
    "ownpack": (
        "A pack you have",
        {"o": "#2b3136", "l": "#c8915a", "L": "#e0ae78", "b": "#a06d3f", "B": "#7a5134", "s": "#d9b25a", "S": "#a57b28"},
        [
            "................",
            "................",
            "..oooooooooooo..",
            ".oLLLLLLLLLLLbo.",
            ".oLllllllllllbo.",
            ".oLllllllllllbo.",
            ".oooooossoooooo.",
            ".oLllloSSolllbo.",
            ".oLlllloollllbo.",
            ".oLllllllllllbo.",
            ".oLllllllllllbo.",
            ".obllllllllllBo.",
            ".obbbbbbbbbbBBo.",
            "..oooooooooooo..",
            "................",
            "................",
        ],
    ),
}


def rows_of(key: str) -> tuple[dict[str, str], list[str]]:
    _, palette, rows = ICONS[key]
    if len(rows) != 16 or any(len(row) != 16 for row in rows):
        raise SystemExit(f"{key}: an icon is sixteen rows of sixteen")
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != "." and ch not in palette:
                raise SystemExit(f"{key} ({x},{y}): {ch!r} has no colour")
    return palette, rows


def svg(key: str) -> str:
    """One rect per run of a colour along a row, drawn on the 16-unit grid with hard edges."""
    palette, rows = rows_of(key)
    parts = []
    for y, row in enumerate(rows):
        x = 0
        while x < 16:
            ch = row[x]
            run = 1
            while x + run < 16 and row[x + run] == ch:
                run += 1
            if ch != ".":
                parts.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="{palette[ch]}"/>')
            x += run
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">'
        + "".join(parts)
        + "</svg>\n"
    )


def main() -> None:
    SVG_DIR.mkdir(parents=True, exist_ok=True)
    for key in ICONS:
        (SVG_DIR / f"{key}.svg").write_text(svg(key))
    print(f"drew {len(ICONS)} icons into {SVG_DIR.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
