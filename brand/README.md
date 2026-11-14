# Cubepals brand

> **These files are not covered by the repository's AGPL licence.**
> See [`LICENSE.md`](LICENSE.md) before using anything here. If you forked Cubepals, you
> must replace this branding.

## The mark

Four shapes on a 2×2 grid: a square, two circles, and a square with an S-curve bitten out
of its top-right corner.

All four are sized to the **same optical weight** rather than the same dimension. A circle
of the same width as a square reads noticeably lighter, so each shape is scaled to an equal
area — convex hull area for the notched shape, since its concavity does not subtract from
perceived mass. On a 300-unit cell:

| shape   | size        | area   |
|---------|-------------|--------|
| square  | 268.3 side  | 72 000 |
| circles | 302.8 across| 72 000 |
| notched | 297.3 box   | 72 000 (hull) |

Sizing them all to 300 instead makes the square 27% heavier than everything else, and it
visibly dominates. The circle-to-square ratio is √(4/π) ≈ 1.1284.

## Files

| file | use |
|---|---|
| `mark.svg` / `mark-reversed.svg` | the mark alone, ink / paper |
| `lockup-horizontal.svg` + `-reversed` | primary lockup |
| `lockup-stacked.svg` + `-reversed` | when width is tight |
| `app-icon.svg` | rounded tile, mark at 58%, radius 22.37% |
| `avatar.svg` | the profile picture on every platform (GitHub, Polar, socials): the app icon's mark on a square of Ink, with no rounding, since each platform crops its own shape. `png/avatar.png` is it at 1024px |
| `favicon.svg` | mark, ink |
| `png/` | raster versions, 1024–2000px |
| `wordmark.py` | outlines the word and draws the lockups and their PNGs |
| `card.py` | draws the link preview from the lockup, the landing's words and a print the site ships |
| `figures/` | the landing's people as the emails show them: `bun brand/figures/figures.ts` writes them to `apps/web/public/email/` |

SVGs carry no font dependency — the wordmark is outlined.

## Where the product uses it

| place | what |
|---|---|
| `apps/web/src/ui/brand.tsx` | `Mark` and `Lockup`, drawn in `currentColor` so one mark serves ink-on-paper pages and the paper-on-ink app navigation |
| `apps/web/src/app/icon.svg` | the favicon, copied from `favicon.svg` |
| `apps/web/src/app/apple-icon.png` | the home-screen tile, copied from `png/app-icon.png` |
| `apps/web/src/app/opengraph-image.png` | the link preview, 1200×630: the landing's headline under its eyebrow, the chunk by day from `public/imagery/chunk-awake.png` printed again at half size, and the lockup small over `cubepals.com` in the top right. The bottom left stays empty, where X lays the page's title. Written by `card.py` |
| `apps/web/public/email/lockup.png` | the emails' lockup: `lockup-horizontal-reversed.svg` on an Ink tile with 14 units of clear space, 320×88, shown at 160×44. It brings its own Ink, so a mail app that inverts the email can't lose it |
| `apps/web/public/email/` figures | Moss waving, the worker with a clipboard and Kai hanging from the card's edge, written by `figures/figures.ts` in one-bit dither, drawn at twice the size each email shows them |

The product's lockup sets the word as live Figtree 700 at the spec's tracking, lowercase, as it is
drawn here, whatever the page around it is set in. The name is still **Cubepals** wherever the
product says it in a sentence — a page title, a sign-in message — and that is the name a screen
reader is given, which is what these files do too (`aria-label="Cubepals"` over a lowercase
drawing). Blockly is the project's codename, used in the code and never shown as the name.

## Lockup specification

Mark 56 · word 66 · weight 700 · tracking −0.070em · gap 14 · mark nudged +1px.

The lockups and their PNGs are drawn by `uv run brand/wordmark.py`, from Figtree 700 at this
spec, and the link preview by `uv run brand/card.py`. Run them again rather than editing what they
write.

The mark is **85% of the word's size**, not 100%. A solid square carries far more ink per
unit of height than letterforms, so matching the mark to cap height over-weights it and the
two elements fight. Keep the ratio if you rebuild the lockup at another size.

## Colour

| name | hex | use |
|---|---|---|
| Ink | `#0D0D0D` | the mark, type, edges, shadows and every dark ground |
| Paper | `#F8F7F5` | background, and the mark reversed |

Ink on Paper, or Paper on Ink. No other colourways are approved. Ink is one black everywhere: the
same on the site, the icons, the avatar and the emails. It was `#181818` until October 2026, which
read as grey beside the dark themes other platforms set it in (GitHub's is `#0D1117`).

## Clear space and minimum size

Clear space on all four sides = **25% of the mark's height**. Nothing enters it.

Minimum sizes: mark alone **20px** (below that the four shapes merge); horizontal lockup
**120px** wide; app icon **32px**.

## Don't

Recolour it · add a gradient, stroke or shadow · rotate or skew it · stretch it off-ratio ·
redraw the S-curve · change the spacing inside the mark · set the wordmark in another
typeface · put it on a busy photo · box it in a shape that isn't the approved app-icon tile.

## Typeface

The wordmark is **Figtree** 700 ([SIL OFL 1.1](https://openfontlicense.org/)), outlined. It is the
only thing set in Figtree: the wordmark is a drawing, and it did not change when the site did.

## The look around the mark

Since October 2026 the site and the product are drawn one way. Anything made for
Cubepals follows it:

| | |
|---|---|
| ground | Ink on Paper. Paper on Ink only for the landing page's night and the product's own navigation, never as a page's ground. Stone `#E6E3DC` for what is set down on Paper |
| type | **Geologica** ([SIL OFL 1.1](https://openfontlicense.org/)). Headings and buttons at weight 700–800 with its sharpness axis at 100, so corners are cut square; running text at sharpness 30. Addresses in IBM Plex Mono. The game's own voice (a chat line, the server list) in Pixelify Sans |
| shape | square. A block is a fill with a 2px Ink edge; a floating one throws a hard Ink shadow down and to the right; a button stands 3px proud of its edge and goes down onto it when pressed. No rounded corners, no blurred shadows, no gradients |
| pictures | the world as the landing page prints it: voxels lit and then printed in one-bit dither, Ink on Paper. A dot is a whole number of device pixels: two on a screen at one device pixel to a pixel, three at two and on a phone, so it reads as a print and not as grey; lines where planes meet are one dot thick. No photographs and no renders in colour. A print is never scaled, because a scaled dither shimmers |
| colour | none of its own. The only colours are the product's status colours where the product shows them (Online is amber, `#8A5A00` on `#FFE9BD`; a sleeping world is dusk, `#4D47B8`) and the small item icons. No coloured type, and no coloured or dark backgrounds |

The tokens are in `apps/web/src/ui/tokens.json`; the landing page (`apps/web/src/landing/`) is
where the look is at full strength.

## Drawing and motion

How Cubepals draws what it does, and how a drawing moves, wherever it appears: on the site, in the
product and in a film. Anything new that is drawn or moves follows it. The landing's stack
(`apps/web/src/landing/stack/`) is the reference.

**A technical drawing, not an illustration.** What Cubepals runs is drawn the way a machine is drawn
in its manual: an exploded drawing of its parts, in Ink, Paper and the print's dither, seen through
the island's one camera, a long lens with the near corner toward the eye. The camera never moves
round what it draws. Depth is the air between the parts and their dithered sides, never a gradient
or a blur.

- **Parts, one over the next.** A thing made of parts is drawn as those parts, stacked on one axis
  with air between them, each a plate the size of the whole. Each part shows one thing on its top,
  its own, so no two parts look alike.
- **Construction shows, and follows.** Parts are tied by their construction: dashed rails from
  corner to corner, and a trace from each player to the door they come in at. Every line is worked
  out from where its two ends are, on every frame, so it follows what it joins: as a part rises or
  slides out, its rails lean and stretch with it, and a player's trace goes with the door. Nothing
  on a drawing stands still while what it belongs to moves.
- **Numbered as a drawing is.** Each part carries its number and name at its corner, in mono
  capitals on a short leader (`03 THE DOOR`), and while it is read, a line under them saying what
  its top shows. No boxes round labels.
- **At rest, lines; read, paper.** Parts at rest are faint lines. The part being read is a solid
  plate of Paper with its sides in dither, and the rest steps back: a print that isn't being read is
  screened to fewer of its dots, never greyed.
- **Open where it is read.** The part being read is shown whole: what is over it rises until its top
  is clear, and it lifts off what is under it and is pulled out toward the words that tell it. The
  parts further off close up, so the drawing keeps its height.
- **The product's own content, and true.** A part's top shows the product itself: its ways to play,
  an address Cubepals keeps, an example day of a server's hours, the plans' own numbers, each read
  from where the product keeps it. Words are set to the measure of their plate and never run past
  its edge, and a test measures every one.
- **Said in words as well.** The page says in words what the drawing shows, and the drawing is
  hidden from screen readers, so nobody who can't see it misses anything.

**Motion: one clock, and each thing follows the one before.**

- **The reader drives.** A drawing moves because it is read: it opens when it is first seen, and
  each step plays as it crosses the reading line. It never plays by itself, and nothing holds or
  steers the scroll; the page scrolls as the browser scrolls it.
- **One clock.** The parts, their rails, the traces and the labels are placed together on each
  frame, so nothing lags what it belongs to.
- **A move is one eased gesture,** in and out (cubic), from wherever things stand, so a reader who
  changes their mind halfway is never jolted. What arrives eases out (quart).
- **Cause, then effect.** In a sequence each thing waits for what causes it: a player comes along
  their trace to the door, the door lights, the way climbs the stack lighting each part as it gets
  there, and the world wakes last. A product's state is shown the same way, through each state the
  product passes, in its own words: when the last player leaves, a server's card says it sleeps
  soon if nobody joins, then that it is stopping, and only then that it is asleep. It never jumps
  from the first to the last.
- **Fills and prints change through the dither,** a dot at a time in the dither's own order, never
  by fading, so at every frame each dot is there or not and a print never turns grey. Words change
  as calmly: the old ones lift away as the new ones settle (`SaidLine`).
- **What opens grows alone.** Opening one card's details grows that card; the cards beside it keep
  their height, with their rows still level.
- **Whole pixels.** Whatever moves is placed on whole device pixels on every frame, so its dither
  never shimmers.
- **Less motion** shows each step's end at once.
- **On a phone the drawing follows.** It holds the top of the screen and pans to the part being
  read. What has no room there, the names and the players, is left out rather than drawn smaller,
  and the island takes a smaller print of its own, never a scaled one.
