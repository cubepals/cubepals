# Modpacks

How a pack someone picks, pastes or drops becomes a Minecraft server that players join. The
person makes one choice (which pack) and Blockly works out the rest: the loader, Minecraft, Java,
which mods a server runs, how much memory, and how to install, check and undo it.

Checked 2026-09-26 against itzg/minecraft-server `2026.9.1` (mc-image-helper 1.68.0).

## What a person does

| They have | They do | Blockly |
|---|---|---|
| Nothing yet | Pick a pack Blockly offers by name, under "What to play" | Uses the release an admin offered, checked byte for byte (`docs/modpack-templates.md`) |
| Nothing yet | Search Modpacks on the create page and pick one | Uses the newest version a server can run, or the one they pick |
| A Modrinth link | Paste it into the same search | Reads the pack and the version the link names |
| A CurseForge link | Paste it | Says it can't download from CurseForge and links the pack's Files page, where the server pack is |
| A file | Drop it on "A pack you have" | Reads it and builds a server from it, or says in one sentence why it can't |

Nothing asks for a source, a loader or a Minecraft version. On a pack server's Mods page, the
owner sees the pack and its version, an update when there is one, a place to drop a newer
version of an uploaded pack, and the mods Blockly left out because only players need them.

## Sources

| Source | How | Status |
|---|---|---|
| Curated packs | Reviewed releases, checked by ingestion, offered by an admin (`docs/modpack-templates.md`) | Supported |
| Modrinth catalog | Search, pick, pick a version | Supported |
| Modrinth link | Project, version by id or number, `cdn.modrinth.com` file links | Supported |
| `.mrpack` file | Dropped. One downloaded from Modrinth is recognised by its hash and used as published | Supported |
| Server pack zip | Dropped. Scripts and configs are read, never run | Supported |
| CurseForge export (`manifest.json`) | Dropped. Built when it carries its mods; one that only lists them is refused with where to get the server pack | Supported as far as the file holds the mods |
| CurseForge app profile folder | Dropped as a zip | Supported |
| Prism Launcher and MultiMC instance | Dropped as a zip (`mmc-pack.json`, `instance.cfg`) | Supported |
| Packwiz pack | Dropped as a zip. Mods from Modrinth resolve; CurseForge-sourced ones are refused | Supported for Modrinth-sourced packs |
| A plain mods folder | Dropped as a zip. Loader and Minecraft are read from the jars | Supported |
| CurseForge link or API install | Recognised and answered with the Files page | Blocked: needs Overwolf's written consent (§ CurseForge) |
| Packwiz by link, FTB's installer | Not fetched | Not supported |

Loaders: Fabric, Quilt, Forge and NeoForge. Minecraft: any release from 1.12.2 to 26.3
(`packRuns` in `minecraft/versions.ts`). Java follows Minecraft: 8 to 1.16.5, 17 to 1.20.4, 21 to
1.21.x, 25 for 26.x.

## The pipeline

```
input → detect → normalize → resolve → server spec → install → verify → run
```

Every pack ends as a **Modrinth pack**: a `modrinth.index.json` that lists files by URL and hash,
plus `overrides/` for files carried inside. That is the one shape the runtime installs from, so
the runtime never knows where a pack came from.

- **Catalog packs** are used exactly as Modrinth publishes them.
- **Uploads** are rebuilt into a Modrinth pack by Blockly and stored by their sha512
  (`stored_artifacts`, source `built`). Jars that Modrinth publishes are listed by their Modrinth
  download (found by hash through `POST /v2/version_files`); any other jar is carried inside
  `overrides/mods`.

### Carried files

A server without a pack, Paper ones above all, gets the same two layers from its setup: jars
listed by link and hash, and files carried by their path under the server's directory, as
`overrides/` holds them. Only Cubepals writes them. An owner uploading or editing one is a later,
advanced feature.

| Layer | Pack | Setup (`domain/revision/carried.ts`) |
|---|---|---|
| Jars by link and hash | `modrinth.index.json` `files[].path` | A mod's `dir`: `{ projectId: 'aoneblock', dir: 'plugins/BentoBox/addons' }` |
| Files carried inside | `overrides/<path>` | `files: [{ path: 'plugins/LifeStealZ/config.yml', content }]` |

- **Where they live.** A setup and a revision carry `files`, and a mod may carry `dir`. A
  template names them, a copy keeps them, and every later change keeps them: a mod change
  resolves again and puts each plugin back in its folder.
- **How they reach the server.** The image has no place for either on Paper: `PLUGINS` all go
  in `plugins/`, and `overrides/` only install with a pack. So a step of the entrypoint
  (`minecraft/carried.ts`) reads `BLOCKLY_JARS` (path, sha512, link) and `BLOCKLY_FILES` (path,
  base64) before the image starts. It removes what the last start placed and this revision doesn't
  (`/data/.blockly-files`), fetches each placed jar unless it already holds its bytes, refuses one
  whose sha512 is wrong, then writes every carried file. A server that places nothing has no step.
- **Replaced, at every start.** A carried file replaces the one on disk before every start, the
  first included. The plugin finds its file already there and keeps it rather than writing its
  defaults. What the server reads is always what its revision says, and going back to a revision
  puts its file back. A plugin that fills in what a file leaves out (Bukkit's `copyDefaults`, as
  LifeStealZ does) lets a carried file hold only the values Cubepals changes.
- **Paths.** Relative, letters, digits and `.`, `_`, `+`, `-` only, and never a file Blockly keeps
  itself (`server.properties`, the access lists, `.blockly-` marks). A wrong one fails building the
  spec: it is a mistake in a template, never skipped.
- **The diff and the undo.** The diff before apply and the history list files the way they list
  mods, named by the plugin they set up: "Set by Cubepals: updated LifeStealZ settings". A change
  to a carried file or a placed jar counts as rewriting the world (`rewritesWorld`), so it gets a
  snapshot first, and the snapshot back if it doesn't start, like a new pack. The check after a
  start hashes placed jars where they were placed.

Checked on staging (2026-10-09, itzg `2026.9.1`, in a temporary app running this spec):

- **LifeStealZ 2.21.1 on Paper 26.2.** A carried `config.yml` with only `startHearts: 7` and
  `maxHearts: 13` stayed as written after the first start. `lifestealz debug generate`, the
  plugin's dump of what it loaded, showed those two values merged with its own defaults. The file
  was then overwritten on the volume and a revision carrying 4 and 9 applied. After the restart,
  the file and the plugin both said 4 and 9.
- **BentoBox 3.23.3 and AOneBlock 1.28.0 on Paper 26.1.2,** with AOneBlock's `dir` set to
  `plugins/BentoBox/addons`. The jar landed there and not in `plugins/`, and `bentobox version`
  listed `AOneBlock 1.28.0 (ENABLED)` with its `oneblock_world`.

### Detect

`detect(names)` in `minecraft/pack-layout.ts` decides the format from the file names alone:
`mrpack`, `curseforge`, `packwiz`, `instance`, `server` or `mods`, and the folder the pack lives
in. A download that wraps the pack in one more zip is opened once, never deeper. Anything else is
refused: "This file doesn’t hold a modpack Blockly can build a server from."

### Normalize

`app/packs/build.ts` builds the pack for each format. Its readers are pure:

- `minecraft/mrpack.ts`: a Modrinth index, its loader and Minecraft, safe paths, both hashes.
- `minecraft/pack-manifests.ts`: CurseForge exports and instances, Prism and MultiMC, Packwiz.
- `minecraft/server-pack.ts`: a server pack's start scripts, `variables.txt`, ServerStarter's
  config, `user_jvm_args.txt` and the library names for the loader, its build, Minecraft, the
  author's memory and the safe `-D` properties. Nothing in the pack is ever executed.
- `minecraft/pack-layout.ts` `placeOf`: which files a server keeps. Worlds, launcher files,
  libraries, installers, scripts and clutter stay out.

When a pack says nothing about its loader or Minecraft, `runsOn` works it out from the jars: the
loader they are written for (NeoForge, then Forge, then Quilt, then Fabric) and the newest
Minecraft every one of them allows. Fabric mods beside Forge ones are refused unless the pack
carries Sinytra Connector.

The loader build is Blockly's to pick. When a Fabric or Quilt pack names an older build than its
own mods accept (their `depends.fabricloader` or `quilt_loader`), the current build is used when
every mod accepts it, and the pack's notes say so; when none does, the pack is refused in a
sentence. Forge and NeoForge builds are used as the pack names them.

A pack's name and version come from its own files where it has them (an index, a manifest, an
instance). A server pack named only by its file is read from the name:
`Create-Above-and-Beyond-Server-1.3.zip` is Create Above and Beyond, version 1.3 (`packNameOf`).

### Resolve

`app/packs/contents.ts` reads a pack once and keeps what it holds by the file's sha512
(`pack_contents`): its Minecraft, loader and build, every jar a server installs, and the ones left
out with why. Catalog packs are read by HTTP ranges, not downloaded whole.

#### Sides

A pack's own `env` marks are not trusted: Better MC 4 marks 63 mods that only run in players'
games as required on the server. Each jar's side comes from, in order:

1. Modrinth's environment for that exact version, found by the jar's hash.
2. The jar's own metadata (`fabric.mod.json` `environment`).
3. Otherwise both sides.

Jars that only players need are left out of the server through `MODRINTH_EXCLUDE_FILES` and
`MODRINTH_OVERRIDES_EXCLUSIONS`, each an exact path. A jar some other server mod depends on is
kept.

#### Size

`packTierFor` in `minecraft/pack-build.ts`, in order:

1. The author's `-Xmx` or recommended memory: up to 2.5 GB is the small size, up to 4.5 GB the
   middle, above that the large.
2. The catalog's tags.
3. The jars: 150 mods or 400 MB and over is the large size, anything else the middle. Never the
   small one from counting alone.

A pack that asks for more than the largest size says it may run slowly. A size only Plus has is
said in the preview, before anything installs. Sizes are never shown by their names.

### Server spec

`minecraft/runtime-spec.ts` turns the pinned pack into the image's settings:

| Setting | Holds |
|---|---|
| `TYPE=MODRINTH`, `MODRINTH_MODPACK` | The pack file's URL (Modrinth's CDN, or the stored copy) |
| `BLOCKLY_PACK` | The first 32 hex characters of the pack's sha512 |
| `MODRINTH_EXCLUDE_FILES` | The listed jars only players need, as anchored patterns |
| `MODRINTH_OVERRIDES_EXCLUSIONS` | The same for jars carried inside the pack |
| `MODRINTH_FORCE_INCLUDE_FILES` | Files the pack keeps off servers that a mod of it turned out to need |
| `JVM_DD_OPTS` | The author's safe `-D` properties (`java.`, `jdk.`, `log4j` and the like are dropped) |
| Java image tag | From Minecraft, as above |

The image keeps the first pack it downloads from a plain URL at `/data/modpack.mrpack` and
reinstalls it at every start, so a new version would never install. A pack server's entrypoint
is a short `sh -c` that removes that file whenever `BLOCKLY_PACK` differs from the one recorded
in `/data/.blockly-pack`, then runs the image's own start (`RuntimeSpec.entrypoint`).

## Installing

Installing and updating is a deployment (`app/operations`):

1. A restore point (`pre_apply` snapshot) before any change that moves the pack
   (`movesPack` in `domain/revision/revision.ts`).
2. The new pack installs as the server starts.
3. The install is checked (§ Verify).
4. If it doesn't come up, the snapshot goes back and the server runs on the pack before. The
   owner reads: "The new configuration didn't start…. Your server is back on the one before."

A change made while the server is stopped waits, and installs the same way on the next start
(`installOnStart`), going back to the pack before if it fails.

### Verify

A server counts as up only when:

- the process started and the image reported the server ready;
- **what it installed is what the pack says.** mc-image-helper never checks the hashes of what
  it downloads, so every jar it records is hashed against the pack (`packCheck`). Wrong or
  missing ones are removed and fetched once more; a second failure names them and fails the
  boot;
- **what started is what the pack is.** The Minecraft and loader are read from the server's own
  banners (`bootedWith`) and must match (`bootMismatch`);
- the port answers, and status or RCON answers.

A modded crash is named in one sentence with the mod (`minecraft/diagnosis.ts`): a mod that only
runs in players' games, a missing or wrong dependency, two copies of one mod, a mixin failure,
the wrong Java, a full disk, running out of memory. When Fabric lists several unmet needs, the one
the owner can act on is named rather than a loader build Blockly picks.

Some failures only a start can reveal, and a pack server learns from them instead of failing:

- **A mod the catalog lets a server run that stops one as it starts**, being for players' games
  (seen on the real image: Zombie Storm 100 Days carries Fog Overrides, which Modrinth marks as
  optional on servers and which stops a dedicated server). Its jar is left out
  (`pack_contents.left_out`, `crashed`) and the start goes on.
- **A mod Blockly left out that another one needs**, because the catalog marked it for players'
  games. It is put back and the start goes on.
- **A library the pack itself keeps off servers that its own mod needs** (seen on the real image:
  Cabricality 0.3.1 marks Equator unsupported on servers, and its own mod requires it). Found in
  the pack's index and installed anyway (`MODRINTH_FORCE_INCLUDE_FILES`).

Every mod one stop names is learned together (Forge lists all the mods that failed at once,
each with its id, which finds its jar). What a pack learns holds for every server of that pack
file: the runtime spec reads it (`leaveOutNow`), and the Mods page lists learned mods with the rest
left out. One start tries again three times at most, then fails with the diagnosis.

### Updates

- A server stays on its pinned version. Nothing updates by itself.
- The Mods page offers the newest version a server can run that is newer than the pin, and says
  when it also moves the world to a newer Minecraft. A world never moves back.
- An uploaded pack updates by dropping its newer file on the Mods page.
- A pack server refuses a lone Minecraft or mod change: "This server plays {name}: its
  Minecraft and its mods come with the pack. Change the pack instead."

## Mods one at a time

On a server without a pack, the Mods page adds mods one at a time (`app/mods/service.ts`):

- A mod found by name is resolved with its dependencies, held to the server's Minecraft and
  loader, and refused where it only runs in players' games. A set that can't run together is a
  list of conflicts, and a newer Minecraft where it works is offered, never applied.
- An uploaded jar the catalog publishes (found by its hash) is added as that exact catalog
  version, so it brings what it depends on and is judged by the catalog's record of where it
  runs, not by the jar's own word.
- Any other jar is the owner's own: refused if it says it only runs in players' games, and held
  to the Minecraft and loader it declares.

## Players

The invite and the server page name the pack and its exact version, with its page and where to
get it (the Modrinth App or Prism for Modrinth packs). An uploaded pack has no public page, so it
says to ask whoever runs the server for that exact version. Blockly has no launcher of its own.

## Security

### The trust boundary

**Mods are code, and a pack server runs whatever mods its owner chose.** Blockly doesn't review
them and can't make running a mod safe. What Blockly controls is where that code runs and what it
can reach:

- Each server runs in its own container (Docker locally, a Fly Machine VM in production) with
  its own volume and a memory limit.
- The Docker container sets `no-new-privileges` and a process limit. The image drops from root
  to its own user with `gosu` before Minecraft starts.
- A server holds no Blockly credentials. It has only its own: its RCON password, and a token
  (in its pack's URL) that fetches its own files and nothing else.
- Nothing from a pack runs on the control plane. Start scripts, installers and jars are read as
  data, never executed.

What this doesn't cover: a mod can use its server's network, fill its own disk and memory, and
read or change its own world. That is the owner's choice and stays within their server.

### What the image itself checks

Nothing, read in mc-image-helper 1.68.0's source (`docs/modpack-templates.md` § What actually
happens): it downloads each index file's first link without checking its hashes, keeps any file
already on disk, and resolves override entries without guarding against `..`. Blockly's reading of
indexes, its hostile-archive checks and `packCheck` are the checks there are. A curated pack is
opened as a hostile archive in full before it is offered; a catalog pack picked from search is read
by ranges, its index checked, its overrides not yet.

### Hostile archives

Every uploaded or downloaded file is treated as hostile (`infra/formats/pack-archives.ts`, zip.js
2.18.2 in strict mode). Before a byte is used:

- **Names:** normalised, then refused for traversal, absolute paths, drive letters, control and
  bidi characters, reserved Windows names, over-long names and deep nesting.
- **Entry types:** links and devices refused.
- **Encoding:** encryption and any compression but stored and deflate refused.
- **Collisions:** duplicate names, including case and Unicode collisions, and overlapping entries
  refused.
- **Bombs:** per-entry and whole-pack ratios, counts and sizes (50,000 files, 4 GiB in all,
  512 MiB for one file). Every read is held to its declared size.
- **Downloads:** Modrinth pack downloads are held to Modrinth's host allowlist (`cdn.modrinth.com`,
  `github.com`, `raw.githubusercontent.com`, `gitlab.com`), and a download aborts its connection
  past its limit.
- **Jar metadata:** capped (1 MiB per entry, 20,000 records), so a small jar can't declare a huge
  one.

Uploads go straight to the store by a presigned link, 4 GiB at most and 25 a day for each
account, and are read by a worker job (`pack-import`), not by the API.

## CurseForge

- **API: blocked.** Its terms (14 Aug 2024, §3.1) rule out using the API for a competing product,
  and CurseForge sells server hosting since 8 Sep 2026. They also forbid caching, the site
  forbids automated downloads, and CDN downloads need an API key since 16 Jul 2026. The
  itzg image's `AUTO_CURSEFORGE` carries its maintainer's key and stays off.
- **What Blockly does now:** CurseForge links are recognised (`infra/curseforge/curseforge-links.ts`)
  and answered with the pack's Files page. The server pack or instance the person downloads
  there builds through the upload path.
- **To unblock:** written consent from Overwolf (api@curseforge.com, or the API form) to use the
  API in a paid hosting product. Then an adapter for `CurseForge.files` (`app/ports/curseforge.ts`,
  null in every deployment) with Blockly's own key, kept in the control plane.

No copy promises CurseForge installs.

## Licences and terms

- Catalog packs are used as their authors publish them, from Modrinth's CDN. Blockly doesn't
  mirror or re-host anyone's files for other people.
- A curated pack is kept as Blockly's own copy only where every file a server installs is licensed
  for it, or its author gave written permission; any other is fetched from its authors, as their
  licences ask (`docs/modpack-templates.md` § Licences).
- A built pack holds only what its owner uploaded, is kept for that owner's servers, and is
  removed when nothing uses it (`app/artifacts`).
- Jars Modrinth publishes are downloaded from Modrinth, not carried in Blockly's copy.
- Modrinth's API terms still speak of non-commercial use.

## Not supported

- CurseForge installs by link or API (§ CurseForge).
- FTB's installer and other packs that need a program run to exist. The person downloads the
  server files and drops them.
- Packwiz packs by link, and Packwiz mods from CurseForge.
- A CurseForge export that lists its mods without carrying them. The refusal names the Files
  page.
- Minecraft before 1.12.2, and snapshots.
- Plugin servers (Paper, Purpur) from a pack; plugins are added one at a time on the Mods page.

## Adding a source

1. Teach `detect` its file names, and write a pure reader in `minecraft/` for its manifest.
2. Add a plan to `app/packs/build.ts` that produces the same Modrinth pack: files the catalog
   knows by hash, the rest carried in `overrides/`.
3. If it has links, give its adapter a `linkOf` and answer them in `PackService.linkOf`. Its
   hostnames stay in its adapter (`scripts/check-boundaries.ts`).
4. Tests: the reader, `pack-build.test.ts`, and one end to end in `app/packs/packs.test.ts`.

Nothing past the build changes: the runtime already installs the result.

## Tests

- Readers and rules: `minecraft/mrpack.test.ts`, `pack-layout.test.ts`, `server-pack.test.ts`,
  `pack-build.test.ts`, `diagnosis.test.ts`, `logs.test.ts`, `minecraft.test.ts`.
- Hostile input: `infra/formats/pack-archives.test.ts`, `file-formats.test.ts`.
- Carried files and placed jars: `domain/revision/carried.test.ts`, `app/servers/carried-runtime.test.ts`
  (the step in a real shell) and `app/setups/carried.test.ts` (a template-shaped setup end to end).
- End to end on the stand-in runtime: `app/packs/packs.test.ts` (upload, build, create, links)
  and `app/packs/changes.test.ts` (update, rollback running and stopped, guarded changes). These
  need the `S3_TEST_*` variables, as CI sets them (`.github/workflows/ci.yml`).
- Real packs on the real image: run by hand against a deployment.
