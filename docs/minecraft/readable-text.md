# Words players can read

Where Cubepals puts words in its own worlds, such as a game's name and what to do there, and how large it makes them, so that a player can read them and they stay out of the way. Every number below comes either from a source or from a real client. The code holds every arrival's and pad's words to these rules (`apps/control/src/minecraft/readable.ts`, tested in `readable.test.ts`).

Sources were read on 2026-10-17. "The client" means Mojang's client jar for Java Edition 26.2 (SHA-1 `2dc72797acbc1b63fc16a11c4ac393605f453754`, as the launcher's version manifest lists it), the release every shot and test here used, read with its own class names (decompiled with Vineflower 1.11.1); each fact from it names the class.

## The player

| What | Value | Where from |
| --- | --- | --- |
| Eye height, standing | 1.62 blocks over the feet | [Minecraft Wiki, Player](https://minecraft.wiki/w/Player); `Avatar.DEFAULT_EYE_HEIGHT` |
| Eye height, sneaking | 1.27 | same; `Avatar` crouching pose |
| Eye height, swimming or crawling | 0.4 | same |
| Body | 0.6 wide, 1.8 tall | same; `EntityDimensions.scalable(0.6F, 1.8F)` |
| Highest a jump lifts the feet | 1.2522 blocks | Minecraft Wiki, Player |

A player is read from where they stand, eye 1.62 over their feet. Sneaking lowers the eye by 0.35. That moves a label a few pixels on the screen, which the rules leave room for.

## The screen

| What | Value | Where from |
| --- | --- | --- |
| Field of view, default | 70, vertical | [Minecraft Wiki, Options](https://minecraft.wiki/w/Options); `Options.fov` |
| Field of view, range | 30 to 110 ("Quake Pro") | same |
| Horizontal view at 70 | 102.4° on 16:9, 86.1° on 4:3 | Minecraft Wiki, Options |
| Sprinting | widens the view about 15% (FOV effects at 100%) | `AbstractClientPlayer.getFieldOfViewModifier`, `Camera.tickFov` |
| Flying | widens it 10% | same |
| GUI scale "Auto" | the largest whole scale that leaves the screen at least 320×240 GUI pixels: 3 at 1280×720, 4 at 1920×1080, 6 at 2560×1440 | Minecraft Wiki, Options; `Window.calculateScale` |
| A letter in the game's font | 8 font pixels tall, lines 9 apart | [Minecraft Wiki, Font](https://minecraft.wiki/w/Font); `Font.lineHeight` |
| Chat at GUI scale 3 / 4 | letters 24 / 32 screen pixels tall | from the two rows above |
| Title, subtitle | 4× and 2× the GUI scale, the title's top 40 GUI pixels over the middle | `Hud` |
| Most common screens | 1920×1080 48%, 2560×1440 27%; 16:9 about 83% of all, 16:10 about 10% | [Steam Hardware Survey](https://store.steampowered.com/hwsurvey/Steam-Hardware-Software-Survey-Welcome-to-Steam), September 2026 |

Minecraft Java isn't sold on Steam, so the survey stands in for PC players in general. No survey of the field of view players actually choose turned up, so the rules hold at both the default (70) and the widest (110).

## How the game draws a label

A label is a text display, and the game draws its text in the world at 1/40 of a block to a font pixel (`DisplayRenderer.TextDisplayRenderer`; Minecraft Wiki, [Display](https://minecraft.wiki/w/Display)), the same size as a name tag (`EntityRenderer.NAMETAG_SCALE`). Lines are 10 font pixels apart. The background runs one pixel round the words on the left and top; with the trailing pixel of the last letter, that is one each side. The game moves the words one pixel right of centre (`TextDisplayRenderer` translates by 1 − width/2), so a plate drawn behind them is centred on that, not on the display: a plate centred on the display, measured in the client, left three pixels on the words' left and one on their right. The text stands up from the entity's position. Its defaults are a line width of 200, a 25% black background, no shadow, centred, and billboard `fixed`; `vertical` turns it about the vertical axis to the player. It is drawn within 64 blocks at the defaults (`Display.shouldRenderAtSqrDistance`).

For comparison, a sign's words are drawn at 1/96 of a block to a pixel, four lines of at most 90 pixels (`StandingSignRenderer`, `SignBlockEntity`), and a map in an item frame at 1/128 of a block to a pixel.

## What guidance says

- **Size.** The Xbox Accessibility Guidelines' least text height on PC is 18 pixels at 1080p; on a console it's 26 ([XAG 101](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/101)). The Game Accessibility Guidelines treat 28 pixels at 1080p as a floor for TV play ([GAG](https://gameaccessibilityguidelines.com/use-an-easily-readable-default-font-size/)).
- **Up or down.** CCOHS gives a preferable zone of 15° over to 15° under a level look, and says looking up is tiring ([CCOHS](https://ccohs.ca/oshanswers/ergonomics/office/monitor_positioning.html)). OSHA puts a screen's middle 15 to 20° under eye level ([OSHA](https://www.osha.gov/etools/computer-workstations/components/monitors)).
- **Breadth.** Android XR keeps primary content within a 41° wide middle of the view ([Android XR visual design](https://developer.android.com/design/ui/xr/guides/visual-design)).
- **Line length.** XAG 101 sets at most 80 characters to a line. That is about how long a line is, not how many there are; the longest line here is 28 characters. No guideline found gives a count of lines.

## What servers do

None of the big servers (Hypixel, Mineplex, CubeCraft, Wynncraft, The Hive and others) publish where or how large they put words at arrivals or in lobbies. The hologram plugins most of them build on publish only their defaults:

- [DecentHolograms](https://wiki.decentholograms.eu/configuration/config/): 0.3 blocks a line, shown within 48 blocks.
- HolographicDisplays: 0.25 blocks a line, within 48 blocks.
- FancyHolograms: text displays at scale 1, turning to the player, within 20 blocks.

Those are the same scale as a label here: about a quarter of a block to a line.

## Measured

A real 26.2 client (vanilla jar, software rendering under Xvfb), on a local Paper 26.2 server with the Arcade's world and this datapack. Each label's background was turned magenta for the shot, and the magenta's box was measured in the picture. The player stood on a block, so no speed widened the view.

**The model, first.** Twelve M's on one line, eight blocks away at field of view 70 on 1920×1080, were drawn 176×24 pixels. Two lines were 48 tall and three lines 73. So a line is 10 font pixels tall, its foot is where the display stands, and it is 1/40 of a block to a font pixel. `sight.ts` projects a label the way the game does, and `sight.test.ts` holds it to these shots, to within three pixels.

**Every arrival's and pad's words**, from where each is first read, as the client drew them:

| Words | Screen, field of view | Predicted box | Drawn box |
| --- | --- | --- | --- |
| Parkour / Stand here to play | 1920×1080, 70 | 808 334 – 1112 397 | 811 334 – 1111 396 |
| | 1920×1080, 110 | 886 439 – 1034 470 | 887 439 – 1033 469 |
| | 1920×1200, 70 | 791 372 – 1129 441 | 795 372 – 1128 440 |
| | 1920×1200, 110 | 877 488 – 1043 522 | 879 488 – 1042 521 |
| The pit / Stand here to play (scale 2.2) | 1920×1080, 70 | 807 334 – 1113 397 | 810 334 – 1112 396 |
| | 1920×1080, 110 | 885 439 – 1035 470 | 886 439 – 1034 469 |
| | 1920×1200, 70 | 790 371 – 1130 441 | 793 371 – 1129 440 |
| | 1920×1200, 110 | 876 488 – 1044 522 | 878 488 – 1042 521 |
| Parkour / Step off to start the clock | 1920×1080, 70 | 752 312 – 1168 372 | 755 312 – 1167 371 |
| | 1920×1080, 110 | 858 428 – 1062 458 | 860 428 – 1061 457 |
| | 1920×1200, 70 | 729 346 – 1191 413 | 732 346 – 1190 412 |
| | 1920×1200, 110 | 847 476 – 1073 508 | 848 476 – 1072 507 |
| Wait here for the next round | 1920×1080, 70 | 721 323 – 1199 355 | 724 323 – 1198 354 |
| | 1920×1080, 110 | 843 433 – 1077 449 | 844 434 – 1076 448 |
| | 1920×1200, 70 | 694 359 – 1226 394 | 698 359 – 1225 393 |
| | 1920×1200, 110 | 830 482 – 1090 499 | 831 482 – 1089 498 |

The falling floor's pad has the same words and places as the parkour's, mirrored, and drew the same.

**The parkour's words moved twice.** The first time they stood a block lower, and the top step of the first stairs hid the bottom of their second line: the drawn box was 5 pixels short at its foot, and the sight lines found 7 of 21 rays blocked. Raised over the stairs, they were whole, but the arrival's title, "Parkour" for its first four seconds, covered them. They stand over the title now, with no ray blocked.

**What a player sees**, from the model the shots confirm. The letter height is on 1920×1080; on 2560×1440, every pixel figure is a third larger.

| Words | Distance | Scale | Middle, over a level look | Breadth | Letters at 70 | Letters at 110 |
| --- | --- | --- | --- | --- | --- | --- |
| Parkour / Stand here to play | 8.0 | 1.3 | 12.7° | 22.3° | 25.1 px | 12.3 px |
| The pit / Stand here to play | 13.4 | 2.2 | 12.7° | 22.5° | 25.3 px | 12.4 px |
| Falling floor / Stand here to play | 8.0 | 1.3 | 12.7° | 22.3° | 25.1 px | 12.3 px |
| Parkour / Step off to start the clock | 32.0 | 5 | 14.4° | 30.2° | 24.1 px | 11.8 px |
| Wait here for the next round | 6.0 | 1 | 14.6° | 34.5° | 25.7 px | 12.6 px |

## The rules

Each rule is a number in `readable.ts`, checked for every arrival's and pad's words from where a player first reads them:

1. **Where it's read from.** At an arrival, the arrival point, facing the way the game turns the player, looking level. At a pad, a place on the way to it, a player standing, facing it.
2. **Large enough.** A letter is at least 18 pixels tall on 1920×1080 at field of view 70 (XAG's least, for PC). At the widest view, 110, every letter comes out at about half its size at 70 (the view's focal length halves: tan 35° / tan 55° = 0.49), so 11.8 to 12.6 pixels here, under the 18 the guideline asks at its default. The guideline is for the game's default, and no place within the other rules reaches 18 at 110: it would take letters twice as tall, and so words twice as wide on the screen, 45° to 69°, past rule 4's 41°, whether the words grow or the reader comes closer. What holds at 110 is that every set of words reads in the client, shot from its reading place (the PR's screenshots): about 1.5 screen pixels to a pixel of the game's font, with every letter whole. The pit's pad words were at 9.6 pixels at 110 with scale 1.7, about 1.2 screen pixels to a font pixel, and didn't read plainly in the shot; they are at scale 2.2 now, as large as the other pads' words look from their places.
3. **Level enough.** The middle of the words is within 15° over or under a level look (CCOHS).
4. **Narrow enough.** The words are at most 41° wide (Android XR's primary zone), well inside the 102° a 16:9 screen shows at 70. So they're never edge to edge, and never in a player's face.
5. **All on the screen** at 16:9 and 16:10, at fields of view 70 and 110.
6. **Short.** At most two lines: the game's name, and one line of what to do. No source gives this number; it is our choice. Each place has one thing to say, and each line more adds a quarter of a block at the game's size, more at the larger scales (1.25 blocks for the parkour's words, at scale 5): at an arrival that pushes the words into the title or past the 15° of rule 3, and at a pad past the room the other rules leave.
7. **Nothing in front.** No block a player can't see through stands between the eye and the words, measured in the world (`scripts/arcade-clearance.ts`).
8. **Nothing beside.** From where they're read, the words are at least 8 pixels clear on the screen of every other label, sign and marker. No source gives this number either; it is a margin we chose from the measurements above. The model and the client differed by up to 4 pixels on an edge, so two things the model keeps 8 apart are still apart as the client draws them.
9. **Over the title.** At an arrival, the words stand clear over the title the game shows there for its first four seconds (`title @s times 5 60 15`): their foot at least 8 pixels over the title's top (the same chosen margin as rule 8, for the same reason), 40 GUI pixels over the middle at the GUI scale Auto picks on 1920×1080 (4), so at field of view 70 they read through it. At 110, no place within 15° clears it, and the title covers the words until it fades.
10. **Out of play.** No label stands where players walk, jump or fall (`scripts/play-space.test.ts`). So words over a pad start just over the reach of a player on it, 1.8 tall plus a 1.2522 jump.

## Boards

The leaderboards hang on the domes' flat glass faces over the balcony's ledge, so they're read looking up, 45° to 50° from where a player walking out from the hub first reads them (`BOARD_READS` in `apps/control/src/minecraft/arcade/boards.ts`, tested in `readable.test.ts`). From there, all of each board is on the screen, no block stands in front of any of it (rule 7; at first the ledge's quartz hid the foot of each board, 6 or 7 of 21 sight lines), and nothing else shown is beside it (rule 8).

They break three rules, and moving them within the balcony doesn't mend it:

- **Too small.** A board is as wide as a dome's flat face, five blocks, so its text can be no larger than 1.1 times the game's. Its letters come out about 9 pixels tall on 1920×1080 at field of view 70, from its reading place and from anywhere on the balcony (9.3 at most): half of rule 2's 18. The client drew them at about that size.
- **Too high and too wide** for rules 3 and 4, since the faces start six blocks over the balcony.
- Right behind the parkour's and the falling floor's pads, two blocks under the pad's words, those words stand in front of the board behind them.

Boards that read at 18 pixels need a wider wall nearer eye level than the domes give.

## What couldn't be found

- What field of view players use.
- Screen sizes for Minecraft players in particular.
- Any server's published layout for words at an arrival.
- A guideline giving a least size as an angle rather than in pixels.
- Ergonomic guidance made for games rather than desks.
