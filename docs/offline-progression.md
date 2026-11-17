# Offline world progression

A world keeps going while nobody is near it. While its chunks are unloaded, while its players are in
another dimension, and while the whole server is stopped or asleep, nothing in Minecraft ticks;
when a chunk is ticked again, it is caught up on the time it missed, by Minecraft's own code. What
the owner sees is **Offline world progression** on the server's settings page: one switch, on for
every server it is for, existing ones included, and under **Advanced** a switch for each of its
parts.

## Contents

1. [What is made up, by part](#1-what-is-made-up-by-part)
2. [What isn't, and why](#2-what-isnt-and-why)
3. [Which servers have it](#3-which-servers-have-it)
4. [How it works](#4-how-it-works)
5. [Sleep, wake and restarts](#5-sleep-wake-and-restarts)
6. [Where it lives](#6-where-it-lives)
7. [What was learnt from other projects](#7-what-was-learnt-from-other-projects)
8. [How it was checked](#8-how-it-was-checked)

## 1. What is made up, by part

Each part has its own switch. All are on by default but **Fire and lava spreading**, which would
only do damage while nobody is there to stop it. Which parts are on reaches the plugin or mod as
`CUBEPALS_PROGRESSION` at each start.

| Part (switch) | What is made up | How |
|---|---|---|
| **Furnaces and brewing** | Furnaces, smokers, blast furnaces, brewing stands, lit campfires | Minecraft's own tick for each, once per game tick owed. Fuel is used as it would be (a lava bucket leaves its bucket), only what a recipe makes is made, a full output or one holding another item stops it, it cools when its fuel runs out, and the experience it earned waits in it. A brewing stand uses its blaze powder; a campfire drops its cooked food beside itself. |
| **Crops and plants** | Wheat, carrots, potatoes, beetroot, torchflower and pitcher crops; melon and pumpkin stems and their fruit; sugar cane, cactus, bamboo, chorus flowers; kelp, weeping, twisting and cave vines; nether wart, sweet berries, cocoa; vines, mushrooms; saplings and propagules into trees; farmland drying out; eyeblossoms | Each block's random ticks for the gap, each one Minecraft's own `randomTick`. So a crop needs light 9, grows faster on wet farmland and slower beside its own kind; cane and cactus stop at three tall; a tree grows only where it fits. A mod's crop built on Minecraft's own grows too. |
| **Animals growing up** | Baby animals growing up; parents' wait before breeding again; sheared sheep growing their wool back by eating grass; turtle eggs hatching; dried ghasts | Age moves by the gap through the animal's own `setAge`, as a tick moves it. A sheared sheep standing on grass eats at least once with the chance its eat-grass goal has over the gap (once in about 1,000 ticks, a lamb once in 50): its wool grows back, and the grass under it turns to dirt only where `mobGriefing` allows. An animal whose age is locked stays as it is. Turtle eggs and dried ghasts are random ticks. |
| **World changes** | Copper aging (every weathering copper block: doors, bulbs, grates, chests, statues, lanterns, lightning rods…); leaves cut off from their log decaying; grass and mycelium spreading to lit dirt, and dying under blocks; nylium; ice and snow melting beside light; budding amethyst; pointed dripstone growing and dripping; redstone ore going dark | Random ticks, Minecraft's own. Copper ages only where no copper within four blocks is less aged, as in the game. |
| **Fire and lava spreading** (off) | Lava setting flammable blocks alight; fire spreading, burning blocks away and burning out | Lava is a random tick. Fire ticks itself every 30 to 40 game ticks, so each fire gets Minecraft's own fire tick once a round, a round for each 35 ticks owed, up to 150 rounds; a fire it lights is ticked from the next round. `fire_spread_radius_around_player` and rain apply as in the game. |

`random_tick_speed` counts: a world that turned growth off grows nothing, and one that sped it up
grows faster. A gap shorter than 30 seconds (a player walking out of a chunk and back) is left to
the game; a gap is made up for 30 days at most.

## 2. What isn't, and why

| Not made up | Why |
|---|---|
| Hoppers, droppers and redstone | They only happen by running the world tick by tick: a hopper chain feeding a furnace is a machine, not a block's own change. A furnace makes what its own slots allow. |
| Mob spawning, mob farms, the Nether portal's zombified piglins | Spawning is chance spread over the area round players; made up later it would be invented, not Minecraft's. |
| Villager trades restocking, villager and animal breeding | They need villagers' and animals' brains run: workstations, pathfinding, two animals and a player's food. |
| Chickens' eggs, armadillo scutes, item drops from mobs | Item entities piling up over hours, which the game would have despawned or never made in that spot. |
| Tadpoles, sniffer eggs, frogspawn | Not random ticks: their own timers, ticked only while their chunk ticks. |
| Rain, snow and cauldrons filling from them; water freezing | Weather doesn't advance while a server sleeps, which is most of a gap: there is no rain to replay. |
| The day and the weather themselves | The world's own clock stays where it was. So what depends on the time of day (turtle eggs hatch at night; saplings and grass need daylight) is made up in the light of the world's own moment, which stood still while the server slept. |
| Dripstone filling a cauldron by more than one level | Minecraft fills the cauldron with a scheduled tick, which the several drips of a catch-up share; it fills on as usual once the chunk ticks. |
| Blocks a mod adds of its own kind | Only blocks built on Minecraft's own (a mod's crop that is a crop) are known to be safe to tick. |

## 3. Which servers have it

| Server | What it runs |
|---|---|
| Paper, and plain Minecraft run on Paper | The Paper plugin, on every Paper release Cubepals offers (1.20.1 and newer; tested on 1.21.11 and 26.3). Furnaces, brewing stands and campfires need Paper 1.20.5 or newer, which runs under Mojang's names, by which the plugin finds the ticks Paper's API doesn't offer; on 1.20.1 to 1.20.4 it says so once in the log and makes up everything else. |
| Fabric on Minecraft 26.3 | The Fabric mod. It needs neither Fabric API nor anything on a player's game. |
| Fabric on another release | None yet: the mod reaches into Minecraft's own code, which moves between releases, and it is built and tested for 26.3, the release production's Fabric servers run. |
| A modpack, Forge, NeoForge, Quilt | None. A pack is tested as it is, and Cubepals runs no server on the others. |
| Plain Minecraft on Mojang's own server | None: it takes no plugins. |

The settings page shows the section only on a server it is for (`progression/view.ts`).

## 4. How it works

The same design on Paper and Fabric, by the wall clock rather than the world's game time, since
game time stands still while a server is stopped or suspended, which is exactly the time owed.

- **A stamp per chunk.** Each chunk has the moment up to which the game itself ticked it. While the
  game ticks a chunk, its stamp moves on to now; a chunk that ticks again after a gap is owed the
  gap (`Clock`). What stopped it doesn't matter: unloaded, the server stopped or paused, or the
  machine suspended with the chunk in memory. Its animals have a stamp of their own, moved only
  while the game ticks the chunk's entities too: the ring of chunks at the edge of the simulation
  distance ticks blocks and not entities, so an animal standing there is owed that time.
- **Kept with the world.** On Paper in the chunk's own persistent data, written every second while
  it ticks, so whenever Paper saves the chunk's blocks it saves a stamp as new as them; on Fabric in
  each dimension's saved data (`data/cubepals/progression.dat`), written with each save of the
  level. Either way it survives an unload, a stop and a crash; after a crash, Fabric can make up
  again at most the time between a chunk unloading and the level's next save (an autosave is every
  five minutes). An animal keeps its own stamp, so one that walks into another chunk isn't made up
  twice.
- **A world that ran without it.** Each world keeps the game time it was last seen at. A world
  whose game time moved on more than a minute without it starts fresh: nothing from before is made
  up, so turning it on, or back on, never makes up the time it was off. Where it starts fresh is
  kept with the world too, so a chunk nobody visits until a later start is still owed only from
  there.
- **Random ticks by count, in rounds.** Minecraft picks `random_tick_speed` blocks per 16³ section
  each tick, so one block's random ticks over a gap are Poisson with mean `ticks × speed ÷ 4096`:
  about 53 an hour at the default speed (`RandomTicks`, at most 512). Every block's count is drawn,
  then each round gives each block that has ticks left one of them (`Rounds`), so neighbours move
  together as in the game. A block stops once it takes no more (a crop grown, copper aged, a leaf
  gone); one that spreads (grass, mycelium, nylium) once 64 of its ticks in a row changed nothing.
  A plant that grows a new block at its tip goes on at the tip.
- **Which blocks.** A block's part is read from its class and the classes it extends, by
  Minecraft's own names (`Part`), the same on both: a mod's crop that is a crop counts as one.
- **A little each tick.** Catch-up waits a second after a chunk starts ticking (so ticks it had
  scheduled run first, as leaves learn they are cut off), then goes in a queue that each tick spends
  at most 5 ms on (`Work`): a world that wakes owing hours spreads the work over the ticks after the
  join rather than stalling the one a player joins on. Furnaces and brewing go first, then blocks,
  then animals, then fire.
- **Only ticked chunks, and their neighbours loaded.** A chunk the game loads but doesn't tick (the
  edge of what players see) isn't caught up until it is; until then it owes the time. A ticked
  chunk's neighbours are loaded, so a stem, a tree or a fire at its edge never loads another chunk.

Each round of catch-up writes one line to the server's log:
`Caught up 4 chunks after up to 2h 5m: 3 furnaces, 120 plants, 2 animals, 40 other blocks, 0 fires.`

## 5. Sleep, wake and restarts

- **A sleeping server isn't kept awake for it.** Nothing ticks while a server sleeps; the time is
  made up when a player brings it back and their chunks tick again. Vanilla's own pause of an empty
  server (`pause-when-empty-seconds`) is time owed the same way.
- **Asleep with its memory.** A resumed machine's clock jumps by the time it was suspended; every
  chunk in memory the game ticks next is owed the jump.
- **Changes at the next start.** The plugin or mod is Cubepals' own layer: placed at a start
  (`servers/specs.ts`), never in a revision, never counted by a plan, never among the owner's mods.
  Its switch and its parts' switches restart nothing. A running server has a change at its next
  start; a sleeping one boots once at its next wake to take it, as with the Via plugins and the
  performance mods, which `stale-sleep` usually does in the background so the player's wake still
  resumes.
- **A start that fails with the Fabric mod** starts again without it and turns it off (`clash`),
  as the performance mods do (`operations/boot.ts`); the page says so, and the switch turns it back
  on. A Paper plugin that fails leaves the server starting without it.

## 6. Where it lives

| Part | Where |
|---|---|
| What both reckon with: the clock, the parts, random ticks and their rounds, animals' arithmetic, the budget, with their tests | `apps/progression/reckoning/` |
| The Paper plugin | `apps/progression/paper/` |
| The Fabric mod | `apps/progression/fabric/` |
| The jars, built into the control plane's image and kept in the archive store | `apps/control/Dockerfile`, `app/artifacts/progression-jar.ts`, `app/artifacts/built-jar.ts` |
| Which servers take it, the switches, the page's view | `app/progression/` |
| The settings section | `apps/web/src/app/(app)/servers/[id]/settings/progression.tsx` |
| Turned off, by whom; which parts | `server_progression_off` (no row: on), `server_progression_parts` (no row: the defaults) |

Build and test the Java side with JDK 25: `cd apps/progression && ./gradlew build`. CI runs the
same in its Java job.

## 7. What was learnt from other projects

Before building, the open-source catch-up plugins and mods were read in source, and three were
studied mechanic by mechanic: Unloaded Activity (LGPL-3.0), The Block Keeps Ticking (MIT) and
Anabiosis (MIT). None is bundled and no code is copied: each mechanic here is Minecraft's own tick,
which none of their arithmetic beats. Ideas taken, each credited where it is used:

- stamping a chunk on every tick it is random-ticked, and an animal on its own (Unloaded Activity);
- stepping neighbour-dependent blocks such as copper together, here as rounds (Unloaded Activity);
- a sheared sheep's wool as "ate at least once over the gap" (Unloaded Activity).

Unloaded Activity was tested as the Fabric side first and set aside: its furnace catch-up smelted
iron onto a furnace's gold-ingot output, since it reckons the output's room without checking the
item.

## 8. How it was checked

On real servers in a test harness: a flat world with a furnace (10 raw iron, 2 coal), a brewing
stand (3 water bottles, nether wart, blaze powder), a lit campfire with beef, a wheat field on wet
farmland, sugar cane, an oak sapling, a pen with a calf and three sheared sheep on grass, a turtle
egg on sand, copper, floating leaves, a dirt patch in grass, ice and snow beside glowstone, budding
amethyst, dripstone under water over a cauldron, lava beside planks, and a fire on a row of planks;
each against the same world without the plugin or mod, and with each part switched off.

- **Paper 26.3 and Fabric 26.3** (with Lithium and FerriteCore, as Cubepals runs them), each with
  the chunk unloaded while the server runs, the server stopped and started, the machine frozen with
  the chunk in memory, and in the Nether.
- **Paper 1.21.11**, unloaded.
- **The default speed**: stopped and started with the clock six hours on, and 40-minute stops.
- **The cost**: a wake owing six hours on a 25-chunk base of wheat fields and 100 stuffed furnaces,
  with tick times sampled through the catch-up.

The numbers are in the pull request that added it.
