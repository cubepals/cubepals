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
| `wordmark.py` | outlines the word and draws the lockups, their PNGs and the link preview |
| `figures/` | the landing's people as the emails show them: `bun brand/figures/figures.ts` writes them to `apps/web/public/email/` |

SVGs carry no font dependency — the wordmark is outlined.

## Where the product uses it

| place | what |
|---|---|
| `apps/web/src/ui/brand.tsx` | `Mark` and `Lockup`, drawn in `currentColor` so one mark serves ink-on-paper pages and the paper-on-ink app navigation |
| `apps/web/src/app/icon.svg` | the favicon, copied from `favicon.svg` |
| `apps/web/src/app/apple-icon.png` | the home-screen tile, copied from `png/app-icon.png` |
| `apps/web/src/app/opengraph-image.png` | the link preview: the horizontal lockup on paper, 1200×630, written by `wordmark.py` |
| `apps/web/public/email/lockup.png` | the emails' lockup: `lockup-horizontal-reversed.svg` on an Ink tile with 14 units of clear space, 320×88, shown at 160×44. It brings its own Ink, so a mail app that inverts the email can't lose it |
| `apps/web/public/email/` figures | Moss waving, the worker with a clipboard and Kai hanging from the card's edge, written by `figures/figures.ts` in one-bit dither, drawn at twice the size each email shows them |

The product's lockup sets the word as live Figtree 700 at the spec's tracking, lowercase, as it is
drawn here, whatever the page around it is set in. The name is still **Cubepals** wherever the
product says it in a sentence — a page title, a sign-in message — and that is the name a screen
reader is given, which is what these files do too (`aria-label="Cubepals"` over a lowercase
drawing). Blockly is the project's codename, used in the code and never shown as the name.

## Lockup specification

Mark 56 · word 66 · weight 700 · tracking −0.070em · gap 14 · mark nudged +1px.

The lockups, their PNGs and the link preview are all drawn by
`uv run brand/wordmark.py`, from Figtree 700 at this spec. Run it again rather than editing them.

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
| pictures | the world as the landing page prints it: voxels in one-bit dither, Ink on Paper. No photographs and no renders in colour. A print is never scaled, because a scaled dither shimmers |
| colour | none of its own. The only colours are the product's status colours where the product shows them (Online is amber, `#8A5A00` on `#FFE9BD`; a sleeping world is dusk, `#4D47B8`) and the small item icons. No coloured type, and no coloured or dark backgrounds |

The tokens are in `apps/web/src/ui/tokens.json`; the landing page (`apps/web/src/landing/`) is
where the look is at full strength.
