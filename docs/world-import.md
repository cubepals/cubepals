# Bringing a world in

How a player brings a Minecraft world they already have to a server, from the create page, the
world page or the backups page. This is the plan for it: what there was, where it stands, what
each kind of world a player has looks like, what Blockly does with each, and the order it is built
in. Downloads and backups are [architecture.md](architecture.md) §9; packs are
[modpack-system.md](modpack-system.md).

## What there was

Before the plan:

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

## Where it stands

- **Built:** the reader (step 1), the world page (step 2) and the create page (step 3).
- **The create page** offers "Your own world" after Minecraft's own three ways to play. It opens a
  page of its own, `/servers/new/world`, which takes the world before there is a server
  (`app/backups/new-world-imports.ts`). Back on the create page the world is chosen
  (`{ kind: 'world', importId }`), and the server is made on its release, or the next one Cubepals
  offers, in its game mode and difficulty, with its own name and seed. The world is kept as an
  archive under its bytes, and the server's first start unpacks it where its world goes
  (`World.startsOn`, `minecraft/starter.ts`), before the steps that lay a world out for its server
  type. The server starts on a disk with room for the world and, while it unpacks, the archive
  beside it (`diskForBroughtWorld`), up to the plan's largest; a world brought before its server is
  held to what that leaves. The store keeps the archive while a server has the world, and a month
  for one not made yet; another world brought for a new server lets the one before go once it is
  ready.
- **Step 4, a modded world's pack, is in.** A world played with mods (a modded server type in its
  `level.dat`, or mods beside it) is read like any other, with the server types that opened it
  (`moddedWith`). It isn't made into a server alone: the create page asks for the pack it was
  played with, found by name or dropped as a file, and the server is made from that pack
  (`{ kind: 'world', importId, pack }`, `setups/brought-with-pack.ts`), starting on the world in
  its game mode and difficulty. A pack from the catalog named without a version plays its newest
  version for the world's own release; a pack on an older Minecraft than the world is refused.
  Mod ids from Forge's registry data in `level.dat` aren't read yet: that waits on a world a real
  Forge server saved.
- **A pack and its world from one upload are in.** A launcher's export or a server's folder dropped
  as a pack, holding a world, is built into its pack as before, and the same upload is handed to
  the world reader (`NewWorldImports.fromPack`) instead of being let go: the pack import names it
  (`worldImportId`). On the create page the world is read under the pack, asks what only its owner
  knows, and the server made from the pack starts on it (`pack-world.tsx`), or on a new world if
  they say so. Where its owner may not bring a world, it is past the day's worlds, or it is bigger
  than their plan's largest disk, the pack comes without it.
- **An offline-mode server's players are moved to their accounts.** A server's folder whose
  `usercache.json` lists players by the UUIDs an offline-mode server makes up, with files in the
  world, has each name looked up as a Minecraft account (`WorldReading.accounts`), and their player
  data, stats and advancements renamed to the account's UUID (`withPlayersRenamed`), for a server
  that plays in online mode: every new one, and an existing one that does. A name no account has
  keeps its files, and the notes say who was moved and who wasn't.
- **Who can join comes with a server's folder.** Its `whitelist.json`, `ops.json` and
  `banned-players.json` are read beside its `server.properties`, each player named as the server
  the world goes to knows them, a name no account has left out and said (`world-people.ts`). The
  owner chooses from the list (`world-people.tsx`): nobody is let in until they say, its bans come
  unless they say not, and the server stays open until they turn its whitelist on. On the create
  page the choice is kept on the import (`newWorlds.choosePeople`) and the new server starts with
  it (`createAccess`); on the world page it is let in at once (`backups.letInFromUpload`,
  `AccessService.letIn`), which never turns a server's whitelist off.
- **A server's other worlds come too.** A server's folder holding more worlds than the one its
  `server.properties` names, as a server with several keeps them, has each read on its own
  (`WorldReading.others`). Brought to a server, each waits in Backups on its own, in a folder of
  its own (`kept-worlds.ts`), for when its owner wants to play it; one that wouldn't open there is
  left out, saying why. Brought for a new server, the server starts on the one named, and
  the notes say to upload the same file on its Backups page to keep the others. A saves folder's
  other saves aren't kept: its owner chose one.
- **A world's mods come with it.** On the world page, a world brought with the instance it was
  played in, or with its mods folder, comes with its loader and mods: each matched on Modrinth,
  its owner's own jars kept as their uploads, and those only players' games run left out. Restoring
  it with them (`withMods`) moves the server to that loader with them (§ Mods and plugins).
- **The guide is published,** `guides/move-a-minecraft-world-to-a-server`: from single-player, from
  another host or a server's folder, with mods, and into a server someone has. Its pictures wait for
  a run on a local stack.

## What it does

A player drops what they have. Blockly works out what is in it, makes it a world a server runs,
says everything it changed, and the player plays it. Under it, the world is kept as a backup of the
server and playing it restores that backup, but the player never reads either word on the way: it
is their world, coming in and then played. The world the server had is kept, and the way back to
it is in Backups. The player is asked only what only they know: which world, when there are
several; which Minecraft account played it; which players to let in; and whether to move a world
to a newer Minecraft.

## Where a player starts

1. **The create page:** a way to play, "Your own world", after Minecraft's own three, which opens
   a page of its own for the world. The server is made to fit the world: its Minecraft version, its
   game mode, its difficulty, its mods. The party-size step is unchanged.
2. **The world page:** a section, "Bring a world", beside "Make your own world". The world is added
   as another of the server's worlds, and played from the same dialog (below).
3. **The backups page:** "Upload a world" opens the same dialog and takes everything the other two
   take.

Each drop target says what it takes, that the world should be closed in Minecraft first, and where
the game keeps its saves, with the player's own system first and a button to copy the path:

| System  | Saves                                                       |
| ------- | ----------------------------------------------------------- |
| Windows | `%APPDATA%\.minecraft\saves`                                |
| macOS   | `~/Library/Application Support/minecraft/saves`             |
| Linux   | `~/.minecraft/saves`                                        |
| Launcher instance (Prism, MultiMC, CurseForge, Modrinth) | the instance's `saves` folder |

The player says which launcher they played on ("Your launcher", the Minecraft Launcher until they
pick another, remembered on that browser). For CurseForge, the Modrinth App and Prism Launcher the
drop names where that launcher keeps its instances, and the way to the worlds inside one; for
another launcher, it says to open the instance's folder from the launcher. The folders, and where
each comes from, are in `apps/web/src/lib/saves-folders.ts`.

## What a player can drop

| What                                              | How it is known                                          | What happens                                  |
| ------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| A world folder, dragged or picked                 | a `level.dat` at its root                                | sent as a tar the browser builds (below)      |
| A `saves` folder, or a zip of one                 | several folders with a `level.dat`                       | the player picks one                          |
| A zip or tarball of a world folder                | one `level.dat`, at the root or one folder down          | read as a world                               |
| A server's folder, zipped or as a tarball         | `server.properties` beside a world folder                | the world `level-name` names; its settings    |
| A launcher instance or export with `saves/`       | the pack importer's `detect` finds an instance or export | its mods matched and kept with the world (§ Mods and plugins); on the create page, built as a pack |
| A Cubepals download                               | `server.properties` and the download's note              | as today                                      |
| A Bedrock save (`.mcworld`, or `db/` with `levelname.txt`) | its layout                                      | refused: Bedrock saves aren't converted       |
| `.rar`, `.7z`                                     | the name                                                 | refused: asked for a zip                      |

`__MACOSX/`, `.DS_Store`, `Thumbs.db` and `desktop.ini` are skipped wherever they are.

## How it is sent

- **A folder** is sent as an uncompressed tarball the browser lays out as a `Blob` of headers and
  the files' own `File`s (`lib/world-folder.ts`): its size is known before the upload starts,
  nothing is held in memory whole, and region files are compressed already. Why it isn't a
  library's is in [dependency-audit.md](dependency-audit.md).
- **A file** is sent as it is.
- **Before anything is sent**, the browser looks at the listing (a folder's entries, a zip's
  central directory) and answers at once for a Bedrock save, no `level.dat`, or a file past the
  size the server takes. The server checks everything again: the browser's look is for speed, not
  trust.
- **Every upload is one PUT** to a link signed for its size, up to 4 GB, which the store takes in
  one. Sending it in parts the browser completes needs the bucket to show the page each part's
  ETag, which it doesn't (dependency-audit.md).

## Libraries

The formats and services here are taken from libraries and the services' own APIs, behind the
existing ports ([dependency-audit.md](dependency-audit.md)). Blockly's own code is the Minecraft
layout and the decisions.

| Work                                          | Library or service                                               |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Reading uploaded zips, strictly               | `@zip.js/zip.js`, through `PackArchives` (`pack-archives.ts`)    |
| A zip's listing in the browser, before upload | `@zip.js/zip.js`, reading the central directory of the `File`    |
| A folder as one file, in the browser          | a tarball written here, for the reason dependency-audit.md gives |
| Reading and writing tarballs                  | `tar` (node-tar), as `readTarball` and `filterTarball` use it    |
| `level.dat` and player files                  | `prismarine-nbt`, read and written                               |
| `server.properties`                           | `dot-properties`, through `FileFormats.decode`                   |
| A Minecraft name's account                    | Mojang's profile API, through `PlayerProfiles`                   |
| An offline-mode player's UUID                 | `offlineUuid` (`app/access/identity.ts`)                         |
| Which mod a jar is                            | Modrinth's `version_files` lookup by hash (`filesByHash`)       |
| A Prism instance's components                 | `mmc-pack.json`, read as a pack's are (`instanceIdentity`)       |
| The source Prism recorded for a mod           | `.pw.toml`, packwiz's format, through `FileFormats` (`packwizMod`) |
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
- **On the world page,** a world newer than the server comes in all the same, never refused after
  its upload: the browser reads its `level.dat` before sending it and says so up front
  (`lib/level-version.ts`), and playing it moves the server up to that version, which the ready
  screen says in one line, as a step that can't be undone, and its button names ("Play Maple
  Hollow on 26.3", `moveUp`, `app/backups/moved-up.ts`). A server with mods or a pack changes
  version in its settings instead, where its mods are resolved again; the ready screen says so and
  the world waits in Backups meanwhile.

## Mods and plugins

A world played with mods comes with them, as one change its owner confirms when they restore it.

- **What says it was modded:** its `level.dat`'s `ServerBrands` (`moddedWith`; Paper and Mojang's
  own server add no blocks or items, `@blockly/contracts/server-brands`), and the jars beside it in
  the mods folder of the game folder it was played from (`gameFolderOf` in
  `minecraft/world-layout.ts`): the folder holding its `saves/`, as a launcher's `.minecraft/` or a
  Prism instance's `minecraft/` does, else the folder it sits in, as a server's folder holds its
  world. Forge's registry data isn't read yet.
- **Before it is sent,** the browser reads `ServerBrands` with the version (`levelOf` in
  `lib/level-version.ts`), so the Bring a world dialog says the world was played with Fabric mods
  and asks for the instance, where none are with it (`bring-world-mods.tsx`). `lib/instance-folders.ts`
  says which folder to pick on each system, for the launcher the player picked under the drop
  (`instancePickOn`: Prism's instances folder, and `minecraft/mods` inside an instance;
  `modsFolderOn`: the Minecraft Launcher's `mods` beside its `saves`), tells an instance picked
  whole (`instanceIn`), and gives the files sent with the world chosen from it (`sentWith`): the
  world, the jars in its mods folder and the sources recorded for them, `mmc-pack.json` and
  `instance.cfg`. Its other worlds, resource packs, shaders, screenshots and logs stay on the
  computer, and the dialog asks which world only where it holds more than one.
- **What is sent** is `lib/brought-files.ts`'s, one upload either way. A folder picked for the
  mods of a world's folder (an instance, its game folder or its mods folder, `modsIn`) adds them
  beside the world, where the control plane reads them (`modsSent`, `playedFrom`): its jars and
  sources in `mods/`, and `mmc-pack.json` and `instance.cfg` with them. A zip can't be added to in
  the browser, so for a world that came as one, the instance is asked for and the world is taken
  from it, the one named as the zip's `level.dat` names it.
- **A launcher's instance,** from each launcher's own source (`minecraft/instance-layout.ts` cites
  each): Prism Launcher and MultiMC keep `instance.cfg` and `mmc-pack.json` (the components it
  runs: Minecraft, the loader and their versions; `PackProfile.cpp`) in the instance's folder, and
  the game's folder below it, `minecraft/` or, where only that exists, `.minecraft/`
  (`MinecraftInstance::gameRoot`), with `saves/` and `mods/` in it. A mod installed from Prism's own
  browser has its source in `mods/.index/<slug>.pw.toml` (`ResourceFolderModel::indexDir`,
  `Packwiz.cpp`), in packwiz's format: its file's name, `side`, `[download]` with `hash-format`
  (`sha512` for Modrinth, `sha1` for CurseForge) and `hash`, and `[update.modrinth]` `mod-id` and
  `version`, or `[update.curseforge]` `project-id` and `file-id`. CurseForge's and the Modrinth
  App's instances have `saves/` and `mods/` at their top.
- **The loader** is the instance's, its `mmc-pack.json` read as the pack importer reads one
  (`instanceIdentity`), else the world's `ServerBrands`, else the one its jars are written for
  (`runsOn`). The loader's build is Cubepals' to pick, as for a pack.
- **Each jar is matched** (`app/mods/jar-matches.ts`): by the source Prism recorded for it, where
  that names a Modrinth version and the hash it records is the jar's own (`GET /v2/versions`), else
  by the jar's sha512 (`POST /v2/version_files`, `filesByHash`). A source recorded for other bytes,
  the jar replaced since, says nothing of it. Which side runs it is decided as for a pack's jars
  (`jarSide`): Modrinth's environment for that file, else the jar's own word, and for a jar Modrinth
  doesn't have, its source's `side`.
- **What comes:** a mod Modrinth has, as the version it was played with; a jar Modrinth doesn't
  have, as its owner's own upload, held to an upload's checks (`app/mods/own-jars.ts`): their plan
  takes uploaded mods, it matches no known malware and its classes are read then, and it is a mod
  a server runs. Mods only players' games run (shaders, minimaps, Sodium) are left out and named.
  A mods folder is read for its first 500 jars, each up to the 128 MB an uploaded jar can be.
- **What is kept:** the loader and each mod, with the world's backup (`world_facts.mods`, and the
  brands as `moddedWith`), shown as `playedWith` on the import (`WorldImportView`) and on the
  backups page (`BackupView`). The page says it where the world is played, rather than among what
  Cubepals did (`bring-world-lines.ts`): "Played with Fabric and 2 mods: Tree Harvester, Vein
  Miner. Your server moves to Fabric with them." and "Left out Sodium: only players’ games run
  it." The instance's own files, read for its loader, aren't said to be left out.
- **Restoring it with them** (`withMods`, `app/backups/restored-mods.ts`) moves the server to that
  loader with those mods in the restore's own step, resolved as any change of mods is
  (`ModService.planOn`), the server's own mods resolved again with them: each brings what it
  depends on (Collective, for Serilum's mods), as the version it was played with where the server
  runs the world's release, else that mod's newest for the server's. A world from a newer release
  moves the server up as well only where its owner chose that too (`moveUp`). Moving loader isn't
  one-way: the restore's snapshot and the revision before it are the way back. Mods that can't run
  together refuse the restore, naming them; a server that plays a pack is refused, as any lone mod
  change is, and the dialog shows the refusal's words. The dialog's Play, and Backups' Play it,
  send `withMods` wherever mods come, with `moveUp` for a world from a newer release: with its
  mods, a server that has mods of its own moves up too, rather than in its settings first.
- **A world played with mods, with none in the upload,** is kept, and the dialog says its mods
  didn't come and asks for the instance again; Play then reads "Play Life without its mods". The
  instance picked, the world goes up again with them as a new upload (there is no adding to an
  import that is read), and the one without them stays in Backups. On the create page, the pack it
  was played with is asked for (`{ kind: 'world', importId, pack }`); a world brought there doesn't
  read the mods beside it yet.
- **An instance, an export or a server folder dropped as a pack** on the create page is built by
  the pack importer (`app/packs/build.ts`), and the world in it handed to the world import.
- **Not yet:** a mod's `config/` doesn't come, and CurseForge's ids in a source are never used; a
  jar from CurseForge comes as its owner's own where Modrinth doesn't have the same bytes.
- **Plugins** from a Paper server's `plugins/` are matched as a server pack's are, and their data
  folders come with them.
- **What a plan runs** is decided as now (`requireWithinPlan`, `mayUseMods`): a world with jars
  beside it is refused on a plan without mods.

## Who can join

A server's folder brings its whitelist, operators and bans. The import shows them as a list the
player chooses from; nothing is let in without that. Its bans come unless the player says not,
since a ban lets nobody in. A whitelist is the player's to turn on, with those they let in: on
with nobody on it, it would keep everyone out. Both are shown, and undone on the players page.
Without one, who can join
is what a new server's is, or what the server's is now.

## What the player sees

1. **The drop.** The browser's look gives a card at once: the world's name, its Minecraft version,
   its game mode, its size, the dimensions found, its mods and its players.
2. **The questions,** only where they apply: which world, which account played it, which players to
   let in, which Minecraft.
3. **Uploading,** with progress.
4. **Reading the world,** with the job's progress.
5. **What Blockly did:** every rename, move and left-out file.

Every refusal says what was wrong and what to do next. Copy says Cubepals.

### Bringing it to a server, and playing it

On the world page (and from "Upload a world" on Backups) the dialog, `servers/[id]/bring-world.tsx`
with its words in `bring-world-lines.ts`, reads as the player's own world coming in:

1. **The file,** with what Cubepals does with it, a name to give it (its name in Minecraft, read in
   the browser, as the placeholder), and the early note for a world from a newer release. A world
   played with mods that aren't with it asks for its instance here, and Upload reads "Upload
   without its mods" until it is added. An instance picked whole says what of it is sent, and asks
   which world where it holds more than one.
2. **"Bringing Maple Hollow to your server":** the upload with its pace and Cancel, then "Reading
   Maple Hollow" with the countdown (`lib/reading-pace.ts`), then any questions. The name is the
   one given, else the one `level.dat` has, else "your world".
3. **"Maple Hollow is ready":** the world by its name and the Minecraft it was last played on (the
   import's `world`, `WorldImportView`), what Cubepals did, who of its old server's players to let
   in, and what playing it does: the server restarts into it (or wakes on it, asleep), the world it
   has now is kept and can be switched back to from Backups, and, for a world from a newer
   release, the one line that the server moves up for good. A world brought with its mods names
   them, what playing it does to the server's loader, and those left out and why.
4. **"Play Maple Hollow"** restores the backup the world waits in from the dialog itself
   (`backups.restore`, with `moveUp` where it moves the server and `withMods` where its mods
   came), and the dialog closes onto the
   page's own progress. **"Not now"** leaves it waiting in Backups, listed under the world's name
   with "Uploaded by you" and a "Play it" button.

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
4. **Mods.** A pack and a world from one upload, the question for a modded world without mods,
   and a world's own mods brought with it from its instance or mods folder.
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
