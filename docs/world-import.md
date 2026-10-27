# Bringing a world in

How a player brings a Minecraft world they already have to a server, from the create page, the
world page or the backups page. This is the plan for it: what exists, what each kind of world a
player has looks like, what Blockly does with each, and the order it is built in. Downloads and
backups are [architecture.md](architecture.md) §9; packs are [modpack-system.md](modpack-system.md).

## What exists

- **The backups page** takes a `.tar.gz` through "Upload a download" (`beginWorldUpload`,
  `finishWorldUpload` in `app/backups/service.ts`). It must be shaped like a server's folder: a
  `server.properties` at its root whose `level-name` names a folder holding `level.dat`
  (`uploadedWorld` in `minecraft/uploads.ts`). It becomes a backup, restored like any other.
- **Refused today:** a single-player save, any `.zip`, a world folder on its own, a folder whose
  name has capitals or spaces, and a download from another host packed as a zip. The message says
  "This isn't a Cubepals download".
- **The world page** offers a new world and starting over. It says nothing about bringing one.
- **The create page** offers "A pack you have" (`PackDrop`), which reads Modrinth packs,
  CurseForge exports and instances, Prism and MultiMC instances, packwiz and server packs
  (`app/packs/build.ts`). Worlds inside them are left out (`worldFolders` in
  `minecraft/pack-layout.ts`) and the player is told.
- **A name match is taken as the same world.** `finishWorldUpload` looks the upload's level name up
  among the server's worlds, so a different world in a folder named `world`, uploaded to a server
  whose world is `world`, is recorded as that world.
- **The seed** is read from `server.properties`, which a single-player save doesn't have; the
  save's own seed is in `level.dat`.
- **A single-player host's inventory** is in `level.dat` (`Data.Player`), which a dedicated server
  ignores: brought over as it is, the player who made the world arrives with nothing.

## What it does

A player drops what they have. Blockly works out what is in it, makes it a world a server runs,
says everything it changed, and keeps the upload as it came as a backup, so the way back is a
restore. The player is asked only what only they know: which world, when there are several; which
Minecraft account played it; which players to let in; and whether to move a world to a newer
Minecraft.

## Where a player starts

1. **The create page:** a way to play, "Your own world", beside "A pack you have". The server is
   made to fit the world: its Minecraft version, its game mode, its difficulty, its mods. The
   party-size step is unchanged.
2. **The world page:** a section, "Bring a world", beside "Make your own world". The world is added
   as another of the server's worlds; switching to it is the existing switch, with its snapshot.
3. **The backups page:** "Upload a download" stays and takes everything the other two take.

Each drop target says what it takes, that the world should be closed in Minecraft first, and where
the game keeps its saves, with the player's own system first and a button to copy the path:

| System  | Saves                                                       |
| ------- | ----------------------------------------------------------- |
| Windows | `%APPDATA%\.minecraft\saves`                                |
| macOS   | `~/Library/Application Support/minecraft/saves`             |
| Linux   | `~/.minecraft/saves`                                        |
| Launcher instance (Prism, MultiMC, CurseForge, Modrinth) | the instance's `saves` folder |

## What a player can drop

| What                                              | How it is known                                          | What happens                                  |
| ------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| A world folder, dragged or picked                 | a `level.dat` at its root                                | sent as a tar the browser builds (below)      |
| A `saves` folder, or a zip of one                 | several folders with a `level.dat`                       | the player picks one                          |
| A zip or tarball of a world folder                | one `level.dat`, at the root or one folder down          | read as a world                               |
| A server's folder, zipped or as a tarball         | `server.properties` beside a world folder                | the world `level-name` names; its settings    |
| A launcher instance or export with `saves/`       | the pack importer's `detect` finds an instance or export | mods through the pack importer, world as here |
| A Cubepals download                               | `server.properties` and the download's note              | as today                                      |
| A Bedrock save (`.mcworld`, or `db/` with `levelname.txt`) | its layout                                      | refused: Bedrock saves aren't converted       |
| `.rar`, `.7z`                                     | the name                                                 | refused: asked for a zip                      |

`__MACOSX/`, `.DS_Store`, `Thumbs.db` and `desktop.ini` are skipped wherever they are.

## How it is sent

- **A folder** is sent as a zip that `client-zip` streams from the files as they are read, stored
  without compression: region files are compressed already. Its size is known before the upload
  starts (`predictLength`), and nothing is held in memory whole.
- **A file** is sent as it is.
- **Before anything is sent**, the browser looks at the listing (a folder's entries, a zip's
  central directory) and answers at once for a Bedrock save, no `level.dat`, several worlds, or a
  file past the size the server takes. The server checks everything again: the browser's look is
  for speed, not trust.
- **Large files** go up in parts through the archive store's multipart upload
  (`s3-archive-store.ts`); a part that fails is sent again, not the whole file.

## Libraries

The formats and services here are taken from libraries and the services' own APIs, behind the
existing ports ([dependency-audit.md](dependency-audit.md)). Blockly's own code is the Minecraft
layout and the decisions.

| Work                                          | Library or service                                               |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Reading uploaded zips, strictly               | `@zip.js/zip.js`, through `PackArchives` (`pack-archives.ts`)    |
| A zip's listing in the browser, before upload | `@zip.js/zip.js`, reading the central directory of the `File`    |
| A folder as a zip, in the browser             | `client-zip`, new, audited as dependency-audit.md says           |
| Reading and writing tarballs                  | `tar` (node-tar), as `readTarball` and `filterTarball` use it    |
| `level.dat` and player files                  | `prismarine-nbt`, read and written                               |
| `server.properties`                           | `dot-properties`, through `FileFormats.decode`                   |
| A Minecraft name's account                    | Mojang's profile API, through `PlayerProfiles`                   |
| An offline-mode player's UUID                 | `offlineUuid` (`app/access/identity.ts`)                         |
| Which mod a jar is                            | Modrinth's `version_files` lookup by hash (`filesByHash`)       |
| Upload in parts                               | S3 multipart upload, through the archive store                   |

Region files are copied as they are and never decoded, so no chunk format is read.

## How Blockly reads it

A world import is a job, as a pack import is (`runImport` in `app/packs/service.ts`): begun with a
presigned upload, finished by the player, then run in the queue with its progress shown. It reads
the upload by range (a zip through `remote-zip.ts`, a tarball streamed), writes a server-shaped
`.tar.gz` to the archive store, and hands that to the reading `finishWorldUpload` does today. An
upload already in that shape is not rewritten.

It reads uploads as hostile input, as `pack-archives.ts` does: no absolute paths, no `..`, no
links or devices, and the entry, inflated-size and time limits the world reader has now.

1. **The world.** The folder holding `level.dat`; with a `server.properties`, the one its
   `level-name` names; otherwise the only one; otherwise the player picks. A `level.dat` that can't
   be read falls back to `level.dat_old`, and the summary says so.
2. **Its folder name.** Always a level name Blockly makes (`nextLevelName` against the server's
   worlds), with its `_nether` and `_the_end` folders renamed with it. The name the player sees is
   `level.dat`'s `LevelName`. An upload is never matched to an existing world by folder name.
3. **The Nether and the End.** A single-player save and a vanilla, Fabric or Forge server keep them
   inside the world folder (`DIM-1`, `DIM1`); Paper keeps them beside it (`worldDirectories` in
   `minecraft/worlds.ts`). The import writes the layout of the loader the server runs, so neither
   dimension is lost going either way.
4. **The world's facts,** from `level.dat`: the Minecraft version (`Data.Version.Name`), the seed
   (`WorldGenSettings.seed`, or `RandomSeed` before 1.16), hardcore, difficulty and game mode.
   Game rules stay where they are, in `level.dat`. A `server.properties`, where there is one, gives
   the server's settings; those Blockly has no setting for are listed, not applied.
5. **The host's inventory.** A single-player `level.dat`'s `Data.Player` is written as that
   player's file (`playerdata/<uuid>.dat`, or under `players/` from 26.1 on, as in
   `minecraft/players.ts`). The player names the Minecraft account that played it, and the name is
   looked up as `minecraft/players.ts` looks names up.
6. **Players from an offline-mode server.** Their files are named for offline UUIDs. Where the
   upload has a `usercache.json`, each name's files (player data, stats, advancements) are renamed
   to its account's UUID, and the summary lists who was matched and who wasn't.
7. **What is kept.** The world's folders. From a server's folder, `server.properties`,
   `whitelist.json`, `ops.json` and the ban lists are read and not copied; `mods/` and `config/`
   go to the mods step, `plugins/` to the plugins step. Anything else is left out and listed.

## Which Minecraft

- **The world's own version is offered:** it is used, with no question.
- **It isn't, and a newer one is:** the player chooses. Opening on the newer version upgrades the
  world and can't be undone; the upload stays as a backup either way.
- **It is newer than any offered,** a snapshot, or from before 1.9: refused, naming the version.
- **On the world page,** a world newer than the server offers the server's existing move to that
  version, which the player chooses.

## Mods and plugins

- **Known from** `level.dat` (`Data.WasModded`, `ServerBrands`, Forge's registry data), jars in
  `mods/` or `plugins/`, and launcher instance files.
- **An instance, an export or a server folder with mods** is both a pack and a world: the pack
  importer (`app/packs/build.ts`) builds the pack from it, and the worlds it leaves out today are
  handed to the world import. A server is made from the pack, with the world as its world.
- **A world played with mods, with no mods in the upload,** is never opened on plain Minecraft,
  as now. The player is asked for the pack it was played with: a launcher export to drop, or one
  from the modpack catalog, with packs named by the mod ids in `ServerBrands` and the registry
  data put first.
- **Client-only mods** are left out, as the pack importer leaves them out now.
- **Plugins** from a Paper server's `plugins/` are matched as a server pack's are, and their data
  folders come with them.
- **What a plan runs** is decided as now (`requireWithinPlan`, `mayUseMods`).

## Who can join

A server's folder brings its whitelist, operators and bans. The import shows them as a list the
player chooses from; nothing is let in without that. Without one, who can join is what a new
server's is, or what the server's is now.

## What the player sees

1. **The drop.** The browser's look gives a card at once: the world's name, its Minecraft version,
   its game mode, its size, the dimensions found, its mods and its players.
2. **The questions,** only where they apply: which world, which account played it, which players to
   let in, which Minecraft.
3. **Uploading,** with progress.
4. **Reading the world,** with the job's progress.
5. **What Blockly did:** every rename, move and left-out file, and the backup that holds the upload
   as it came.

Every refusal says what was wrong and what to do next. Copy says Cubepals.

## The guide

- **In the product:** the drop targets' text (above), and the world page's and create page's own
  lines pointing to it.
- **On the site:** a guide under `apps/web/src/app/(public)/guides/`, listed in `guides.ts`, on
  moving a world to Cubepals: from single-player, from a launcher, from another host, with mods.

## The order it is built in

Each is a pull request of its own, with its tests.

1. **The reader.** The import job, zips and tarballs of any of the shapes above, folder names,
   dimension layout, the host's inventory, and no matching by name, behind the backups page.
2. **The world page.** "Bring a world", folder picking, the browser's look, multipart upload.
3. **The create page.** "Your own world": an import its owner holds before there is a server, as a
   pack import is, a `{ kind: 'world', importId }` setup source in `SetupSourceInput`, and the
   version choice.
4. **Mods.** A pack and a world from one upload, and the question for a modded world without mods.
5. **The rest.** Offline-mode players, the whitelist and operators, a server's other worlds.
6. **The guide** on the site.

## How it is proven

- **Worlds the real game saved:** a single-player save, and worlds saved by the vanilla, Paper,
  Fabric and NeoForge servers, made by the real jars, never a `level.dat` built by hand.
- **Hostile uploads** through the real reader and a real store, as `world-refusals.test.ts` does:
  traversal, links, zip bombs, an upload that never finishes arriving.
- **Every refusal's message,** asserted.
- **On staging,** end to end (`bun scripts/staging.ts start`, `up`, `bun scripts/staging-check.ts`,
  `stop`): a single-player save, a Paper server's zip and a modded instance, each joined, with the
  host's inventory, the Nether and the End checked.

## Not in it

- Converting Bedrock saves.
- Worlds from before Minecraft 1.9.
