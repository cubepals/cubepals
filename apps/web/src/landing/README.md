# The landing page

All rights reserved, not AGPL: this directory, except the typeface in `type/` and `fonts.ts`, is
one of the Site Assets in [`brand/LICENSE.md`](../../../../brand/LICENSE.md).

The page says one thing and shows it: your friends join, and your server wakes up. It is one page
for every screen, and the browser scrolls it the way it scrolls any page. Nothing holds the
scroll, steers it or plays on a clock that runs ahead of the reader. No scroll bar is drawn beside
it (`landing.css`); every other page keeps its own.

Top to bottom: the first screen, with the island playing the sentence; how a server is made and
joined; what Cubepals does for it, as the parts under the island's world; what it costs; Cubepals'
own servers to try; the questions people ask; the button once more, beside the island asleep. It
starts at night and ends there.

## Where things are

| | |
|---|---|
| `app/page.tsx` | The page at `/` |
| `Page.tsx` | The sections, in order, under the public pages' own header (`app/(public)/header.tsx`) |
| `Landing.tsx` | What the page reads (who is signed in, where its buttons lead, the plans, Cubepals' own servers) and the frame it is set in |
| `landing.css` | The page's look: the two grounds, the sheet, the type, and how things arrive |
| `sections/` | One section to a file, each with its own CSS module: `Opening`, `Steps`, `Handled`, `Pricing` (with `Hours`), `Ours`, `Asked`, `Closing`, `Footer`; `Arcade` is the first screen's line about Cubepals' own Arcade, `said.ts` the plans in a few words, and `drawn.ts` the server the drawings show |
| `stack/` | The parts under the island's world, read one at a time: `geometry.ts` (where everything falls, through the island's own camera), `tops.ts` (what each plate's top shows), `dither.ts`, `Drawing.tsx` (the picture), `motion.ts` (how it moves), `Stack.tsx` (the window and the steps) |
| `island/` | The island: `scene.ts` (the drawing, from the engine), `island.worker.ts` (where it runs) with `serve.ts` (what it does there), `drawing.ts` (the page's side of the worker), `Island.tsx` (what is shown round it), `Card.tsx`, `Measures.tsx`, `Snore.tsx` |
| `engine/` | The voxel world and its one-bit print: `world.ts`, `chunk.ts`, `cast.ts` (the people on the grass), `models.ts`, `gl.ts` with `scene-pass.ts` and `print-pass.ts`, `light.ts`, `shadow.ts`, `camera.ts` |
| `start.ts` | What is counted when the island can't be drawn |

## The rules

**Ink and paper.** A section is on ink or on paper (`data-tone`), and draws only in that ground's
inks: `--on-ground`, `--on-ground-muted`, `--on-ground-faint` and `--rule`. Grey is never a tint
in a picture: where a picture needs one it is a dither of ink, as the island's print is, and as
the day strip and the hours bar are. The one accent is the beta tag's. The page starts on ink, at
night, and ends on ink. A section on ink is at least a screen tall, with what it says in the
middle, so whoever scrolls into the night sees nothing else.

**The sheet.** Everything sits on one measure between two hairlines that run the page's height,
with a printer's register mark wherever a section's edge crosses one (`.lp-sheet`). Cells share
their rules, as a drawing's title block does: nothing floats in a card of its own.

**Three voices.** Geologica, sharpened (`SHRP`), says what a person is told. Plex Mono is the
label and the machine: a section's name, an address, a measurement. Pixelify Sans is the game
talking: its server list. Corners are square, as the product's are.

**The product as it is.** A demonstration is drawn with the product's own pieces and words: the
design system's pills, cards, buttons and chips, the ways to play from `TEMPLATE_CARDS`, the
sizes from `PARTY_SIZES`, the loaders from `LOADERS`, the edge's own sleeping line, the plan cards
of the pricing page and its questions. Nothing on the page is a picture of the product that could
go stale on its own.

**Everything on it is true.** A number that belongs to a plan comes from `pricedPlans`
(`lib/plans.ts`), what a new subscriber is offered now. A drawing that could be taken for the real
thing says it is a drawing, in the line under it. Every address shown is one Cubepals keeps. No
other company is named. No timing is promised that isn't measured.

**Show what a choice does, where it is made.** The hours a plan gives depend on the size of the
server; `Hours.tsx` works them out as the size is picked, beside the cards.

## The island

The landing's chunk cut to a cube of world, sixteen blocks across and eleven deep, printed in the
site's one-bit dither, paper on ink, with its measurements set off it the way a spec sheet sets
them. It plays the page's one idea: a moment after it is seen, someone joins, the light comes up,
the windows and the chimney come on, and the friends walk in. The card beside it is the server's
own, in the product's words, and its one button lets the visitor join it or have everyone leave.

- **It never holds the page.** The drawing runs in a worker (`island.worker.ts`) on an
  `OffscreenCanvas`, so building the chunk and printing a frame never wait on the page's thread,
  nor it on them. The page only tells it what changed: its size, whether it is on the screen,
  how far the first screen has scrolled (the camera rises a little with it), where the mouse is.
- **It draws only when it has to.** Off the screen, in a hidden tab, or with nothing moving, it
  rests.
- **The first frame is a picture.** A still printed beforehand by the same scene
  (`public/imagery/island-asleep.png` and `island-awake.png`) is there with the first paint; the
  live print fades in over it once its lit look has compiled. Change the scene's camera or cut, and
  print the stills again.
- **Less motion** shows the server as it ends, everyone in, and nothing moves or snores.
- **Without it** (no worker, no `OffscreenCanvas`, no WebGL 2, or a device too slow to show it
  soon), the still stays and the card plays the server's states on its own.

**Working on it.** Try the island against a production build (`next build`, then `next start`):
`next dev` reloads the page over and over once the worker has been compiled for it, which reads
as the island never waking. The stills come from the scene itself, through a page that runs
`scene.ts` on a plain canvas at the box `stills.ts` names, once with two device pixels to a CSS
pixel and once with one; `island/stills.test.ts` fails until their sizes and marks match it. The
stack's smaller stills (`island-*-small.png`) are the same page's prints of `SMALL_BOX` with one
device pixel to a CSS pixel.

The people on the grass move as `engine/cast.ts` says, and `engine/cast.test.ts` holds them to it:
nobody within a block of anybody, nobody sliding, jumping, hurrying or spinning, joining and
leaving one at a time along the path.

## The parts under the world

What Cubepals does for a server (`Handled`, with `stack/`) is drawn as the parts under the island's
world, one plate each, seen through the island's own camera: the game, asleep or awake, the door,
the backups. A window holds the drawing on the screen while the steps beside it are scrolled past
(on a phone, under it), and the step across the reading line is the part the stack opens at: the
parts over it rise until its whole top shows, it rises a little and is pulled out toward its words,
and it comes in lit, in paper. The last step is a friend joining: the stack closes, their way is
drawn in at the door and up the stack, and the world wakes.

- **The island's print is the scene's own,** chosen for the screen's density and the room there is
  (`printFor`), so it is shown dot for dot; the plates' dither is drawn in the print's dots.
- **A move is eased in and out,** from wherever things stand, so a reader who scrolls on halfway
  through one is never jolted. It starts when a step crosses the reading line, never on its own.
- **A change of look is a dissolve through the dither** (`dither.ts`), never a fade: at every frame
  each dot is there or not, so nothing on the drawing is ever grey but the dither. The world is
  screened back to fewer of its dots while another part is read.
- **Less motion** shows each step's end at once.
- **Its tops are drawn with the landing's own server** (`sections/drawn.ts`) and the plans' own
  numbers, and every word on a plate is held to its plate by `stack/geometry.test.ts`.

## Motion

Things arrive as they are scrolled to, driven by the scroll itself (`.lp-arrive`, CSS
`animation-timeline: view()`), never on a clock that runs on without the reader (the stack's moves
start when a step is read, and the island's join a moment after it is seen): where the browser can't, or less motion is asked
for, they are simply there. What arrives eases out (out-quart); lines and moves ease in and out
(in-out cubic). Nothing loops to be noticed except a sleeping server's snore.
