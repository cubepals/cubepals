# The landing page

All rights reserved, not AGPL: this directory, except the typeface in `type/` and `fonts.ts`, is
one of the Site Assets in [`brand/LICENSE.md`](../../../../brand/LICENSE.md).

The page is a film the scroll plays, on one Minecraft chunk. Its story in one sentence: your
friends type one address and a world wakes up for them; when they leave it goes back to sleep;
and you never see what it took, unless you dig.

It is one beat to a screen. The picture is the whole screen, framed close on what happens, and
each beat has one sentence, set in a caption. A beat's action plays once as the page comes to
rest on it, at its own pace, and scrolling is what moves it: while a beat is still playing the
page stays on it and the wheel moves its story along faster (the picture with it), a hairline at
the foot of the screen saying how far it has got. Scrolling back plays it backwards. When it has
finished, the same scroll rides on to the next beat and the camera flies there; back at its
start, the same scroll goes up to the one before, which is found as it ended. Nobody has to sit
through a beat, and nobody can scroll past one. Night; somebody types the address; under the grass the server wakes; day, and the
friends walk in; the two things it asks, and everything it didn't; everyone leaves and it sleeps;
then the dig, for the curious, through the rooms under the house; all the worlds under one night
sky; what it costs; the button.

The page sells; it does not prove. What a beat claims is demonstrated one layer down: "How it
works" opens that beat's section over the picture, with its demonstration, its facts and its
honest notes, and the picture steps aside and follows the demonstration. A player never has to
open one. That is Blockly's own rule applied to its page: the complexity is there, and it is not
in the way. (An earlier cut put every section and its control panel on the main line; it read as
a technical tour, which is why the page is cut this way.)

The chunk is drawn in one-bit dither, one drawn dot to a screen pixel, and stays on screen the
whole way; the camera flies it in three dimensions. A gauge reads the depth as Minecraft's own Y.

## Where things are

| | |
|---|---|
| `app/page.tsx` | The page: which beats, in which order, and each beat's proof |
| `landing/film/` | The film: `Beat` (a screen with a shot and a caption) and `useBeat` (its cues, played on arrival on a clock that scrolling hurries, `clock.ts`), `Proof` (the section opened over a beat), `Film.tsx` (every beat, and what each tells the stage) |
| `landing/landing.css` | The whole look: tones, type, frames, buttons, dither, the gauge, the cursor |
| `landing/kit.tsx` | `Section`, `Demo`, `Facts`, `Strata`: what a section is built from |
| `landing/stage.ts` | What the chunk is doing (asleep or awake, who is on the path, which room is lit, whether the pointer is on a block), shared between the canvas, the cursor and the demonstrations |
| `landing/Chunk.tsx` | The canvas and its director: the camera's shots read off the sections, night and day, the palette changing where the page does, the pointer's block, digging |
| `landing/Scroll.tsx` | The page's own scrolling (Lenis): free inside a section, a ride from one section to the next, and the cue at a section's foot |
| `landing/Type.tsx` | What the type does in time with the scroll (GSAP) |
| `landing/tour.tsx` | `useTour` and `TourBar`: a demonstration that plays itself, and the bar that says when its next step comes |
| `landing/Cursor.tsx`, `landing/Chat.tsx` | The crosshair that stands in for the arrow, and the line of chat the chunk answers with |
| `landing/names.ts` | What each room is called, wherever it is named |
| `landing/stops.ts` | Where the page rests on each section: the scrolling and the camera both read it |
| `landing/engine/` | `world.ts` the voxel grid, `chunk.ts` the chunk itself, block by block, `cast.ts` who moves on it, `models.ts` what they are built from, `fleet.ts` the other worlds, `camera.ts` the camera's arithmetic, `gl.ts` the renderer (only the layers in view are drawn; the far worlds are drawn without their undersides and only where they can be seen; a device that can't keep up gets a coarser print) |
| `landing/sections/` | The proofs: one section to a file, its demonstration beside it, its own CSS module. Rendered `bare` inside a beat's proof. Also the two scenes the film uses whole (the turn and all the worlds), the plans and the foot |

## The rules

**Three colours and a light.** Ink and paper are the brand's. The night field is the sky over a
sleeping server: the hero's, and the sky over all the worlds at the end. The torch is the only
warm colour and means one thing everywhere: this is on, awake, running, live. It is never
decoration.

**Tones.** A section's `tone` sets `--field`, `--fg`, `--line`, `--muted`, `--panel` and `--on-fg`.
Colour with those, never with literals, so a component reads on stone and on slate alike. The
chunk's print takes its palette from the tone behind it, row by row.

**One unit.** `--px` is one drawn pixel of the chunk. Lines are that thick, corners step by it
(`.bl-frame`), and nothing is rounded. Greys are dither (`.bl-dither`), not tints.

**Three voices.** Geologica says what a person is told. The pixel face is the game talking: the
server list, a chat line, a Y level. The mono face is the machine talking: a status name, a flag, a
log line, and only ever a real one from the code. Above ground there is no mono and there are no
machine words; below ground they are the point.

**Motion means something.** The camera moves because the reader moved: scrolling is travelling.
Anything else that moves is a state changing, a process the section is explaining, or simulated
time passing; water and leaves move because they do. All of it gives way to
`prefers-reduced-motion`: the camera cuts instead of flying, the page scrolls as the device
scrolls, nothing leans toward the pointer and nothing plays by itself.

**A beat plays once.** Nothing on the main line loops waiting to be noticed, and nothing waits to
be pressed: arriving at a beat is what plays it (`useBeat`), it holds on its result, and coming
back plays it again. One beat has something to press, the two questions, because that is the
product. Inside a proof the demonstrations still play themselves (`useTour`) until someone
touches them, and a paused one holds the chunk still too (`stage.held`).

**Chrome is a touch, never a fixture.** What the page needs to say about itself, it says in a few
pixels that take no room from the picture. A tour's countdown is a hairline on its demonstration's
own frame, and its pause button shows on hover or focus. The mark at a section's foot is a small
arrow that gives under the push. If something of this kind has a box, a label or a bar of its own,
it is too much.

**The picture over the technicality.** A detail that is accurate and reads as nonsense is changed
or left out: a sleeping server's row says 0 of 5, not the notice's own "0/0"; the pixel face's
digits are taken from another face, because its 5 reads as an S.

**It is a picture first.** A beat is its picture and one sentence. The sentence is set straight
on the picture, in the ground's own ink, where the picture leaves it open sky or bare wall, with
a hard edge in the ground's colour and nothing behind it. Nothing else is written on the main
line. If a beat needs a second sentence, it is two beats or it is proof.

**One idea to a beat, in a player's words.** Each sentence owns one idea and no other beat says
it again: starting on a join is the headline's, so no caption is about sleep for its own sake.
No machine words above the turn. The lines follow the project's copy rules (say the verb, no
claim that can't be shown, cut before adding).

**Everything on it is true.** A demonstration simulates, and says so in the one line under it. The
strings are the product's own. A number that belongs to a plan comes from the plan table through
`/api/public/plans`; any other is a constant with the file it came from beside it. No
timings as promises. No other company is named. What isn't live is marked as being built, and a
drawing that could be taken for a count says it is a drawing.

## Scrolling

On a wide screen, with a wheel or keys, the page goes beat to beat. A beat that is still playing
holds the page, and scrolling down hurries it (`film/clock.ts`: the beat's clock and the canvas
run at the same pace, up to eight times their own); scrolling up plays it backwards, each cue
saying again how things stood, and leaves it once it is back at its start. Once it has
finished a push rides to the next, the small arrow at the foot of the screen giving as the push
is given, and the camera flies with it. A section taller than the screen (the plans) scrolls freely inside itself first. What
scrolls by itself (an open proof) is left alone (`data-lenis-prevent`). A finger on a phone
scrolls as the phone does: there the picture is a band pinned to the top and each beat is a
screen under it.

## The camera

A section steers the camera with attributes, so a section needs no code to bring the camera to
it. `Section` sets them: `data-room` or `data-y` (what to look at), `data-side` (where across the
screen to hold it; the words take the other side), `data-zoom` (how close), and from its `shot`
prop, when there is more to say, `data-az`, `data-el`, `data-span`, `data-fov`, `data-drop`,
`data-turn` and `data-crowd` (`Pose` in `engine/camera.ts` says what each is). A room is looked
into through its open wall. A section holds its shot for as long as the page rests on it, and
walks a few degrees round its subject as the section is scrolled; between one section's end and
the next one's beginning (`stops.ts`, the same two places the scrolling rides between) the camera
flies, stepping back a little on the way. It follows its goal through a spring with just enough
drag never to overshoot, so it gathers speed and sheds it and never starts or stops in one frame.

On a wide screen the words sit on a plate of the ground's own colour (`.bl-col`), so the drawing
can fill the screen and run behind them. An element with `data-scene` lets the pointer through to
the blocks behind it; an element with `data-pin="<room>"` is moved to where that room's opening is
drawn, which is how the names sit on the column in the overview.

## Who is in the picture

There are few of them and each has room (`engine/cast.ts`), and everybody is a model
(`engine/models.ts`): a head with eyes and hair, a body, two arms and two legs, built from boxes
to the game's own proportions and moved by their parts, square to the grid as everything in the
game is.

**How they move.** A figure this small is unsettling the moment it hurries, slides or pops, so
these hold everywhere:

- Everyone walks along the grid, the way they face, never across it. A route is a few straight
  legs with a turn between them, taken from a standstill.
- A walk gathers pace and slows to a stop. Nobody starts, halts or turns round in one frame, and
  the legs turn with the ground covered, so feet don't skate.
- Nobody comes within a block of anybody. Routes are laid out by hand so that no two cross while
  both are walked, and the path is walked one at a time.
- People and things come out of scattered dots where they arrive and thin back into them as they
  go, in the print's own grain; nothing is there and then not. One way to play gives way to the
  next the same way, the two crossing.
- A blow is drawn back slowly, brought down, and rested after. A job has pauses in it.
- A scene is one small story that can be taken in at a glance, and it opens in the middle of
  things, so what it is shows at once.

`engine/cast.test.ts` runs every scene for five minutes without a browser and holds it to the
first three.

**On the grass.** Friends who join walk in along the path, one at a time, turn off it to a place
of their own and get on with something: one fells the tree, one builds a tower that stays when
they have gone, one fishes. The first screen has two of them, and a day long enough to see them
at it. Two sheep graze, each on its own patch. The chimney smokes while anyone is in. A section
with `act="play"` (the two questions) has the grass play out the way to play that is chosen, each
in its own light: one person with a torch that lights the grass round them, meeting one of the
dead at dusk for survival, and two of them by night for hardcore; three people and no dead, in a
plainer, flatter print, for the smoother kind; a pyramid, a gate and a winding stair built block
by block by someone flying, each finished with a block of gold, for creative; a water wheel and a
hammer for the Create mod. `act="friends"` (the closing, and the two scenes before it, so the change happens while the grass
is off the screen) has all three already at their places.

**Under it.** Every room is about the same thing, a server, and shows the one thing its section
says about it. The server is one machine built from the game's own parts (`engine/server.ts`), the
same wherever it stands: a rack of trays with four small lamps on each tray's face. It is the idea
of a server and not a diagram of one. Round it, from the same kit: chests for what is kept,
furnaces for cores, redstone on the floor with a pulse on its way along it, a door, a lever, a
board that takes slips of paper, and the small block of world a server runs. Three rules hold in
every room, so that seven rooms scrolled past in a row read as one place:

- **Its lamps say what it is doing, and only its lamps.** Off, every lamp is dark. Booting, they
  come on tray by tray from the bottom and are held lit. On, each blinks in its own time and there
  is warm light on the floor in front. At a fault they all flash together three times and stay
  dark, with one puff of smoke. A tray moves only when the machine itself is made, resized or let
  go.
- **Where the small world is says the rest.** Riding over the rack on its spring, turning: the
  server is running, and its chest stands open and empty. Shut in a chest that breathes: asleep.
  Shut in a chest that does not: a kept copy. A lit latch says one thing wherever it is lit, that
  a world is in this chest. Going down, a server puts its world away before its lamps go out;
  coming up, its lamps are on before the world springs out.
- **One worker, a different job in each room, and the head goes before the hand.** In pale
  overalls with a lamp on the helmet, the worker has one place in each room and stands in it:
  doorkeeper at the gate, shutting the lid where the server sleeps, at the lever where one is
  built, sorting jars where a pack is fitted, catching the copy where backups are kept, writing
  the slip where servers are sent to their machines, keeping the ledger between Blockly's own
  machines. The worker looks at what just happened and only then
  acts, so every act has its cause in the picture just before it and its effect just after. The
  worker is the page's argument as a character: somebody does all of this, and it isn't you.
  Players appear only in the two rooms about somebody arriving.

A room's scene is a class in `engine/scenes/`, played by `engine/rooms.ts`. It follows its
section's demonstration, which says what it is showing in a few plain values (`stage.show`), and
every part's state follows from those values, so a scene can be joined at any moment and only
changes are acted out. Out of sight of its demonstration it gives itself the same values on a
clock of its own, and it opens in the middle of its own verb, never on a still room.

A section with `act="ledger"` lights the vault under the house, where the server the visitor
chose stands, from the same kit: it grows and shrinks with the answers (a tray is pushed home for
a bigger group, a chest comes down onto the stack, one small world is swapped for the next), and
the parts the last choice changed are lit.

All of it is drawn as loose boxes each frame, so none of it can be dug. With less motion asked for,
everyone is in place and nothing moves.

The night sky has a moon that sets behind the house as the day comes and rises again from behind
it, and stars that go out one at a time. Nothing in the sky fades. Day has no sun: it is the plain
page.

## The pointer

With a mouse, the arrow is the game's crosshair (`Cursor.tsx`), which closes round anything that
can be pressed. Moving it leans the camera a little. Over the chunk, the ground and the leaves can
be dug: the block under the crosshair is marked the way the game marks one, a click digs it out,
and after a few seconds it is put back and grows into its place ("Put back from a backup."). What
was built is kept, because the page's story is told with it: the house, the lamps, the path,
whatever stands in a room. A click on one of those only gets a line of chat in the game's voice.
Water splashes and stays; bedrock is bedrock. What somebody or something is standing on is kept
as well, with the ring of blocks round it (`engine/ground.ts`): a click there says so, and a hole
already dug comes back at once as someone comes to it, so nobody walks on nothing. A finger gets
none of this, and a field you type in keeps the device's own cursor.

## Adding a beat

1. If it is a new room, give it one in `engine/chunk.ts` (a line in `ROOMS` and a function that
   carves it; only what never moves is a world block) and write its scene in `engine/scenes/`
   from the kit, named in `engine/scenes/index.ts`: the server in it, what the worker does for
   it, one small story that follows a few plain values (`stage.show`).
2. Write the beat in `film/Film.tsx`: where the camera stands, its one sentence, and its cues:
   what it tells the stage, and when, as the page comes to rest on it. Say how its room stands
   before anyone arrives (`useBeat`'s second argument).
3. If it claims something, write its proof in `sections/` (a heading, a sentence or two, a `Demo`
   and `Facts`, in a `Section`) and hand it to the beat from `app/page.tsx`, rendered `bare`.
4. Put the beat in its place in `app/page.tsx`, with a `Strata` where the ground changes.

## Without the drawing

With no WebGL 2 the canvas and the gauge are gone and the page is the same page: the words, the
demonstrations and the sky that turns from night to day when someone joins. The scenes that hold
the screen for the drawing become plain sections, and the one that is nothing without it (the
other worlds) is left out. On a narrow screen the chunk is a band pinned to the top, the camera
works inside the band, and the page scrolls under it.
