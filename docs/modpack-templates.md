# Packs Blockly offers by name

Real modpacks, made by their own authors, that someone making a server can pick like any other way
to play: "Create a server → SkyBlock Plus → Create → Join". The person never meets a loader, a mod
list, a manifest or a download host. Blockly works out the rest, and it takes only what a review
approved.

This document is the design and the research behind it. The code cites its sections: a comment
ending in `(docs/modpack-templates.md § Licences)` means the section of that name here, and the
anchors below (`#skyblock-plus`, `#cobblemon`, `#dsmsl`) are part of the review in
`apps/control/src/app/curation/packs.ts`.

Researched and checked on 2026-09-27. **Nothing here is legal advice, and nothing here is a legal
conclusion.** Where a platform's terms or a licence is ambiguous, this says so. The sources are primary: the licences, the terms,
the formats' own specifications and the installers' source code, each linked where it is used.

## The short version

- **A pack's licence covers only its author's own files.** An MIT or MPL pack is still full of
  other people's mods, and a pack author can't licence someone else's mod. Of 27 real Modrinth
  packs checked file by file, every popular one runs at least one all-rights-reserved,
  noncommercial or custom-licensed mod on the server (§ Candidates).
- **Several mod licences demand the opposite of mirroring.** FancyMenu, Fzzy Config, JourneyMap and
  BlayTheNinth's mods allow a pack to use them only if each copy is downloaded from their official
  pages. A mirror would breach them; fetching from their authors is what they ask for.
- **So Blockly does not host complete packs by default.** Each release gets one of two
  distributions, decided by its licences, not by convenience:
  - `mirror`: every file a server installs may be copied commercially. Blockly keeps one verified,
    self-contained copy, and servers download nothing from anyone else (bar Mojang and the
    loader's own sources).
  - `upstream`: Blockly keeps only the pack's identity, hashes and what checking found. Each server
    fetches the exact bytes from where their authors published them, which is what their licences
    allow, and Blockly checks what arrived.
- **What ships now:** the pipeline, the catalog, the review format, the admin page and the create
  page. The review holds two real packs:
  - **SkyBlock Plus 1.0.9**, licence-clean for a mirror.
  - **Cobblemon 1.8.1**, verified from upstream and offered as Cobbled Studios publish it. A pack
    is held over its authors' terms only when they say no in writing.
- **Blockly's own packs** go through the same checks and the same admin page: short lists of mods
  Blockly chose, put together per Minecraft release (§ Blockly's own packs).
  Modrinth's API terms speak of non-commercial use, which applies to the existing modpack search
  just as much.

## What a person sees

On the create page, under "What to play", after the templates:

| On the card | From |
|---|---|
| The pack's picture | Its catalog's icon, shown from the catalog as its search results show it |
| Its name, and one line of what playing it is | The review (`blurb`), in Blockly's words |
| "Minecraft 1.21.1 · Friends install the pack · By Cobbled Studios" | What checking the release found, and the review's credit to its authors |
| Dimmed, with the reason, when the plan doesn't run it | The same plan rule every template and pack uses |

Picking one fills in the bar ("Cobblemon · Minecraft 1.21.1 · Up to 10 players") and the size, as
any choice does. Nothing on the card names a loader, a mod, a host or a distribution. On the
server's Mods page the pack shows as any pack does, with its authors' own page and file for
players, and never Blockly's copy.

The server size is shown the way the product already shows it (by party, and a size where the plan
asks), not as RAM. Memory is the product's decision (`packTierFor`), from what the pack's authors say
and what its jars weigh.

Players always get a pack from its authors. `PinnedModpack.publishedFile` keeps the authors' file
when servers install Blockly's copy, so the invite and the Mods page point players there.

## What actually happens when a server installs a pack

Read in mc-image-helper 1.68.0's source, the installer in the itzg image
([`ModrinthPackInstaller.java`](https://github.com/itzg/mc-image-helper/blob/1.68.0/src/main/java/me/itzg/helpers/modrinth/ModrinthPackInstaller.java),
[`FileInclusionCalculator.java`](https://github.com/itzg/mc-image-helper/blob/1.68.0/src/main/java/me/itzg/helpers/modrinth/FileInclusionCalculator.java),
[`ModrinthApiClient.java`](https://github.com/itzg/mc-image-helper/blob/1.68.0/src/main/java/me/itzg/helpers/modrinth/ModrinthApiClient.java)).

1. The server fetches `MODRINTH_MODPACK`, which is always Blockly's own stable link
   (`/runtime/v1/artifacts/…`). Blockly answers with a redirect to its stored copy, or to the
   authors' file.
2. For every file in `modrinth.index.json` that the server's side doesn't refuse, the image
   downloads `downloads[0]`, whatever host that is. It **never checks the hashes** the index gives
   (`downloadFileFromUrl`, with `skipExisting(true)`: a file already on disk is kept whatever it
   holds).
3. It copies `overrides/` then `server-overrides/` into the server's folder. It **doesn't guard
   against `..` in a path**: `sanitizeModFilePath` only swaps backslashes, and entries are resolved
   with `outputDirectory.resolve(subpath)`.
4. It installs the loader the index names. Fabric, Forge, NeoForge and Quilt come from their own
   sources, and those installers fetch Mojang's server jar from Mojang.

So **a `.mrpack` is not self-contained**: whoever hosts the pack file, the mods come from the
addresses in its index. Blockly's `mirror` copy is written so that it holds every file a server
installs under `overrides/`, and its index lists nothing to download. Mojang's server jar and the
loader still come from their own sources, as they must (§ Mojang).

Blockly's own checks cover what the image doesn't: every path is read by `readIndex` (no `..`, no
absolute paths); curated packs are opened as hostile archives before anything is used; and after a
server starts, every installed jar is hashed against the pack (`packCheck`, see
`docs/modpack-system.md` § Verify).

Other formats, for comparison:

- A CurseForge client export (`manifest.json`) lists project and file ids that an installer
  resolves through CurseForge's API.
- Some server packs are **ServerStarter stubs** that download every mod from CurseForge on first
  start: Enigmatica 10 (312 files, 4.3 MiB stub) and Craftoria (7.8 KB).
- FTB's installer downloads each file through FTB's API. For StoneBlock 4 v1.22.0, 411 jars come
  from `edge.forgecdn.net` and 6,482 other files from `files.feed-the-beast.com`.
- Packwiz packs point at each mod's catalog.
- Only a full server zip carries its mods. Several of those also carry Mojang's own server jar
  (§ Candidates), which Blockly must never keep a copy of.

## Licences

The rules are code (`domain/mods/curation.ts`, pure and tested) over facts ingestion gathers.

**Kinds.** Each declared licence is read conservatively for a paid hosting company:

| Kind | Licences | A copy Blockly keeps | Offered from upstream |
|---|---|---|---|
| `open` | MIT, BSD, Apache-2.0, ISC, Zlib, CC0, Unlicense, WTFPL, CC-BY, CC-BY-ND (a kept copy is never changed) | Yes, keeping notices | Yes |
| `copyleft` | GPL, LGPL, AGPL, MPL, EPL, EUPL, OSL, CC-BY-SA | Yes, keeping notices and offering the source | Yes |
| `reserved` | All rights reserved | Only with the author's written permission | Yes: nothing of theirs is copied, and a server fetches it from them |
| `custom` | Any `LicenseRef-*` but ARR | Only once a reviewer has read it (a *reading*) | Only once read |
| `noncommercial` | CC-BY-NC-*, PolyForm Noncommercial | Only with permission | Only with permission |
| `unknown` | No licence found (a file no catalog publishes) | No | Only once identified |

SPDX expressions are read as SPDX means them. `AND` binds every part, `OR` offers a choice, and
`WITH` only adds an exception. Anything in brackets goes to a person.

**What counts.** The review covers the pack's own licence, which covers its index, configuration
and scripts, and every work of someone else's that a server installs:

- mods listed in the index;
- jars and archives the pack carries in its overrides, each hashed and matched on the catalog.

Files only players need don't count, because a server never gets them (§ Ingestion step 4).

**Readings, permissions, authored files, holds.** A review can record four more things. Each points
at its evidence in this document.

- A **reading** of a licence of its own, for example FancyMenu's DSMSL read as `reserved` (§ DSMSL).
- A **permission**: an author's written yes to `mirror` or `upstream`, for their project.
- An **authored** file: an archive the pack carries that no catalog publishes, which the review
  found to be its authors' own work. For example, Cobblemon's loading-screen tips (§ Cobblemon).
- A **hold**: a sentence saying why no admin may offer the pack yet. Only a reviewed change lifts it.

**The verdict.**

- `mirror` is allowed when every work is `open` or `copyleft`, read so, or permitted.
- `upstream` is allowed when all of these hold:
  - the pack's own licence allows a paid product (or its author said yes);
  - nothing a server runs is noncommercial;
  - every licence of its own has been read.
- A review that asked for `mirror` its licences no longer allow is **refused**, not quietly moved
  to `upstream`. A licence that changed under a pack is for a person to look at.
- A deployment without an archive store (`ARCHIVE_S3_*` unset, as in local development) has
  nowhere to keep a copy, so a `mirror` release is checked and offered as `upstream` there. Each
  release records which it got, shown on the admin page and in its `curation.verified` entry.

### Obligations

A mirrored copy carries `blockly-notices.txt` beside its index (never under `overrides/`, so it
doesn't reach servers). It lists every work, its licence, and for copyleft its source (the
project's page on its catalog, which links the code). The same list is kept in the release's facts
(`obligations`).

Whether that is enough for GPLv3 §6(d) and MPL §3.2 is a question for a lawyer. It becomes a real
question the moment Blockly conveys copies to someone, and today it already does: a world download
holds the server jar and every mod jar (§ Next steps).

## The format

Three layers, each immutable where it matters:

1. **The review** (`app/curation/packs.ts`, reviewed code). A pack's `key`, `name`, `blurb` and
   `authors`, where its files come from (`source`: catalog and project, never a URL), the most its
   licences allow (`distribution`), `readings`, `permissions`, `authored`, `held`, and its releases,
   newest first. Each release pins `version`, the catalog's `versionId`, and the file's `sha512` and
   `sizeBytes`. Nothing else becomes a curated pack; no URL typed by anyone gets in.
2. **The release** (`curated_releases`, one row per `key@version`). Its state, its `distribution`,
   the `pack` a server pins and the `facts` checking found:
   - what it runs on (Minecraft, loader and build);
   - its size and whether players need it;
   - how many files were checked, their bytes, and the hosts they came from;
   - files that run as code;
   - every work and its licence kind, what a copy owes, and what stands in the way of one;
   - provenance (catalog, project, version, sha512, size, file name, when it was fetched).

   Written once when verified, and never again: a database check refuses a release past `pending`
   without its pack, facts and distribution.
3. **The server's revision.** `PinnedModpack` gains `curated: { key, version }`. The bytes are pinned
   as for any pack (`artifact.sha512`), so a revision stays reproducible whatever happens to the
   catalog. A server references `cobblemon@1.8.1`, never `cobblemon`.

Compared with the brief's example, it keeps every field it asked for:

| Asked for | Where it is |
|---|---|
| immutable, versioned artifacts | `key@version`; artifacts content-addressed by sha512; rows immutable once verified |
| SHA-256 or equivalent | sha512 on the pack and every file (the format's own and Blockly's store's identity); sha1 in the index too |
| provenance | `facts.upstream` + the review's pin; ingestion refuses any difference |
| upstream version | `versionId`, `version` |
| licensing, attribution | `facts.licences`, `facts.obligations`, `authors`, `review`, notices in the copy |
| Minecraft, loader, build | `facts.gameVersion`, `loader`, `loaderVersion` (and the pinned revision) |
| server/client distinction | sides from the catalog per file, client assets left out, `playersNeedIt` from the catalog |
| deterministic installation | pinned bytes; a mirror copy rebuilt from the same inputs is byte-identical (fixed zip timestamps) |
| rollback | revisions pin artifacts; garbage collection keeps every copy of a release ever verified |
| compatibility | Minecraft, loader, build, Java (from Minecraft), size |
| artifact size | `sizeBytes`; `facts.checked.bytes` for everything a server installs |
| created/updated timestamps | `created_at`, `verified_at`, `published_at`, `withdrawn_at`, `updated_at` |
| disable without breaking servers | `withdrawn`: off the create page, still installable by every server that pins it |

## A release's life

```
pending ──verified──► verified ──publish──► published ──withdraw──► withdrawn
   │                     │                                             │
   └──refused──► refused └──────────────withdraw──────────────────────►│
                   │                                                    │
                   └──retry──► pending          withdrawn ──publish──► published
```

- A release is checked once and stays checked: its bytes never change, so it never goes back to
  `pending`. A refused one can be checked again once what refused it is fixed, which is an admin's
  "Check again".
- **Nobody sees a release until an admin offers it** (`publish`), and a `held` pack can't be
  offered at all.
- New servers get the first published release in the review's order. A server's owner is offered
  the next published one on the Mods page and moves to it like any pack change: a snapshot first,
  and the pack before back if the new one doesn't start. Nothing moves by itself.
- Withdrawing takes a release from new servers only. Servers that play it restart, roll back to it
  and keep it; garbage collection keeps Blockly's copy of every release that was ever verified.

## Ingestion

The `curation` schedule (hourly, and as a worker starts) records each reviewed release it hasn't
seen and queues `curation-ingest`, one job per release. A job that fails twice refuses the release
with what went wrong. It runs on a worker, never on the API. `PackCuration.ingest`, in the order
that fails soonest:

1. **Provenance.** The catalog still publishes the reviewed version, under the reviewed project,
   with exactly the reviewed sha512 and size. The project is still published. Its host is one the
   catalog allows.
2. **Fetch.** The file is downloaded from there alone, held to the pinned size, redirects checked
   hop by hop (`DownloadRefused` otherwise), and its sha512 must be the pinned one.
3. **Open.** It is opened as hostile input (`PackArchives.open`), which refuses:
   - traversal, absolute paths, drive letters, control and bidi characters;
   - links and devices;
   - encryption and unknown compression;
   - duplicate or overlapping entries;
   - bombs: counts, sizes and ratios.

   Its index is read by the format's rules (`readIndex`).
4. **Pin.** It is pinned the way creating a server pins a catalog pack (`SetupService.pinnedPack`),
   which settles the pack's sides, Minecraft, loader, build, size and whether players need it. On
   top of that, files only players' games read are left out of servers, whether listed or carried:
   `resourcepacks/`, `shaderpacks/` and the rest of `placeOf`'s `players`. That is recorded against
   the pack file for every server of it.
5. **Licences.** The pack's own licence and every work a server installs, matched by hash, go
   through `judgeLicences` and `distributionFor`, as above.
6. **Verify.** Every file a server installs is fetched from where the index says (an allowed host
   only), held to its size, and matched to its sha512. For `upstream` the bytes are thrown away
   after checking; for `mirror` they are kept.
7. **Keep** (mirror only). The pack is written again as Blockly's copy, stored content-addressed
   (`stored_artifacts`, source `curated`), and its contents are recorded under its own sha512.

What it found is written in one transaction with the release's move to `verified`, and audited
(`curation.verified`, `curation.refused`, `curation.published`, `curation.withdrawn`). Checked live
on 2026-09-27 against Modrinth:

| Release | Result | Time | What a server installs |
|---|---|---|---|
| `skyblock-plus@1.0.9` | verified, `mirror` | 6 s | 6 jars, 7.5 MB, all checked. Kinds: 6 open, 1 copyleft. Copy: 4.7 MB (`3595ce88…`, identical across runs). Friends join with plain Minecraft |
| `cobblemon@1.8.1` | verified, `upstream` (held) | 19 s | 32 files, 184 MB from `cdn.modrinth.com`, all checked. Kinds: 12 open, 16 copyleft, 6 reserved. Shaders and resource packs left out. Players install the pack |

## Security

Mods are code, and a pack server runs its pack's code. The boundary that matters is still the one in
`docs/modpack-system.md` § Security: every server in its own machine and private network, holding no
Blockly credentials. Curation narrows what gets in, and makes what does get in checkable.

| Threat | What Blockly does | What remains |
|---|---|---|
| An arbitrary URL or file becoming a trusted template | Only `packs.ts`, reviewed code, names what may be ingested, by catalog, project, version and sha512. The admin API takes a key and a version that must be in the review | Whoever can merge to the repository can add a pack; that's the trust boundary, as for any code |
| Compromised or replaced upstream release | The review's sha512 must match what the catalog publishes and what is served. Every file is matched to its hash at ingestion; after install, `packCheck` hashes every jar | `upstream`: a file substituted *after* ingestion is caught after it loaded once (the image doesn't check hashes). `mirror` closes that gap |
| Mutable release URLs | Identity is the sha512, never the URL. Modrinth version files are immutable, and GitHub release assets aren't, which is one reason curation fetches only through the catalog adapter | — |
| Dependency substitution | The index is pinned by the pack's sha512, and every file in it by its own. A file whose hash no catalog knows is unidentified (`unknown`) and holds the pack back | — |
| SSRF during ingestion | Downloads are held to the catalog's hosts (`packDownloadAllowed`, https for Modrinth); redirects are followed by hand and checked each hop, at most 5 | DNS rebinding of an allowed host isn't defended; the hosts are the catalog's own CDN |
| Oversized artifacts, bombs | Each download is held to its declared size and cut off past it. Archives are held to 50,000 files, 4 GiB in all and 512 MiB each, with ratio checks | — |
| ZIP path traversal, symlinks, filesystem escape | Refused when the pack is opened (`HostileArchive`), and `readIndex` refuses unsafe index paths. The image itself guards neither | — |
| Malicious archives | zip.js strict reading plus Blockly's own checks: duplicates, case and Unicode collisions, overlapping entries, encryption | — |
| Unexpected executables and scripts | Nothing from a pack runs on the control plane. Files that run as code besides mods (`runsAsCode`: KubeJS, CraftTweaker, shell scripts, native libraries) are listed on the admin page | They run inside the server if the pack's mods run them; that's the pack |
| Malicious Minecraft mods | A human review picks the pack. Catalog takedowns show as the project or version going absent (§15.3). A release can be withdrawn at once | No scanning of jar bytecode. See § Next steps |
| Arbitrary code execution in the server process | Per-server machine, private network, non-root, no secrets (§19a) | A mod can use its own server's network and disk |
| Checksum mismatches | Refused with the file named. An admin re-checks once fixed | — |
| Distribution beyond licence | Decided by rules, recorded per release, refused on any mismatch | Declared licences can be wrong (TerraFirmaGreg's core mod is LGPL on GitHub and ARR on Modrinth); the review reads anything unclear |

## Platforms and the law

Read on 2026-09-27. Quotes are exact.

### Mojang

- **Server software.** The [EULA](https://www.minecraft.net/en-us/eula) says: "you must not
  distribute anything we've made unless we specifically agree to it". It also says: "we need all game
  downloads and updates to come from a source that we authorize". Blockly never mirrors a server jar
  or a pack that bundles one. The image downloads it from Mojang's manifest.
- **The ecosystem's workarounds.** The 2014 [CraftBukkit DMCA](https://github.com/github/dmca/blob/master/2014/2014-09-05-CraftBukkit.md)
  is why Spigot's BuildTools and Paper's [Paperclip](https://github.com/PaperMC/Paperclip/blob/main/readme.md)
  patch a downloaded vanilla jar instead of shipping one. NeoForge's installer warns that its fat
  installer "is illegal" to redistribute.
- **Mods and Modded Versions.** "Mods are okay to distribute; hacked versions or Modded Versions of
  the game client or server software are not okay to distribute."
- **Charging for access.** The [Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)
  allow it under conditions: genuine accounts, the disclaimer, and a contact method.
- **Hosting companies are not addressed.** Who is the EULA's licensee when Blockly sets
  `EULA=TRUE` is already a launch blocker.

### Modrinth

- **Terms, updated 13 Aug 2026 ([terms](https://modrinth.com/legal/terms)).**
  - The API licence is "limited, non-exclusive, non-sublicensable and **revocable** ... to download,
    display, query ... via their own services".
  - The same terms say they "permit you to use the Service for your personal, non-commercial use
    only".
  - Prohibited uses include "any robot, spider or other automatic device ... to access the Service
    for any purpose, including monitoring or copying". Whether that binds API clients is ambiguous.
  - API users must send a uniquely identifying User-Agent; the limit is 300 requests a minute.
- **What uploaders grant.** Uploaders give Modrinth the right to "distribute your Gaming Content to
  our users **through the Service**". Nothing grants anyone a right to host the files elsewhere, so
  redistribution rights come only from each project's own licence.
- **Hosting.** Modrinth sells hosting itself (Modrinth Hosting, in the app since April 2026). There
  is no competitor clause.
- **Format.** The `.mrpack` format allows downloads only from `cdn.modrinth.com`, `github.com`,
  `raw.githubusercontent.com` and `gitlab.com`, and says "HTTP 3xx redirects MUST be followed". It
  requires sha1 and sha512.
- **Assessment:** fetching from upstream fits the terms. Commercial use is **ambiguous**, and
  already a launch blocker for Blockly's modpacks whatever this feature does.

### CurseForge and Overwolf

- **The API terms (14 Aug 2024)** forbid "save or cache any data obtained through the API or SDK". They
  also forbid using API materials to "build any product or service that competes, directly or
  indirectly, with CF". API keys are non-transferable, so the one in the itzg image isn't Blockly's
  to use.
- **CurseForge runs server hosting itself.** It started rolling out
  [CurseForge Servers](https://blog.curseforge.com/the-easiest-way-to-play-modded-minecraft-with-your-friends-curseforge-servers-are-here/)
  (BETA, with Shockbyte) on 8 Sep 2026.
- **CDN downloads.** They were [announced](https://blog.curseforge.com/introducing-api-key-authentication-for-curseforge-file-downloads/)
  to need a key from 16 Jul 2026; enforcement wasn't observed.
- **Authors can opt out.** The per-project
  [distribution toggle](https://support.curseforge.com/en/support/solutions/articles/9000207877-project-distribution-toggle)
  lets an author turn off third-party access entirely.
- **Assessment:** mirroring is prohibited, and automated access by a competing host is high-risk.
  **No CurseForge pack is curated.** The existing refusal and Files-page answer
  (`docs/modpack-system.md` § CurseForge) stays.

### Feed The Beast

- **API.** FTB lets third-party launchers use its [API](https://www.feed-the-beast.com/blog/p/ftb-api)
  and says it won't revoke that.
- **Mod and modpack terms.** Its [terms](https://www.feed-the-beast.com/policies/modpacks-mods-policy)
  forbid commercial use "excluding for Streaming, Recording Videos, or Hosting servers". They also
  forbid using a mod "to provide services to third parties", a contradiction for a host. The grant
  is personal and non-sublicensable.
- **FTB competes too.** It sells hosting (FTB Worlds).
- **Assessment:** fetching through the API is plausible, but **ask FTB first**. Mirroring is not
  permitted.

### Copyright mechanics

- **A mirror is Blockly's own copy.** A persistent copy in Blockly's store is a reproduction Blockly
  makes. It fits poorly under the US system-caching safe harbour (17 U.S.C. §512(b), which is about
  "intermediate and temporary storage"), and under the EU's transient-copy exception (2001/29/EC
  Art. 5(1)).
- **Copies kept in-house aren't "conveying".** Keeping copies only for its own machines isn't
  conveying under the GPL: GPLv3 §2 says "You may make, run and propagate covered works that you do
  not convey, without conditions", and the FSF FAQ on internal distribution agrees. Handing a copy
  to a customer is conveying.
- **Pack authors can't sublicense.** The GPL says "Sublicensing is not allowed"; CC 4.0 is
  non-sublicensable; ARR grants nothing. A pack licence covers only its author's own files, and
  Modrinth says it "is only able to obtain permission for files that are specifically uploaded to
  the site".
- **Who makes the copy.** Fetching from upstream leaves the copying to the platform the author chose,
  on the customer's server's own command. In *Cartoon Network v. CSC Holdings*, 536 F.3d 121 (2d Cir.
  2008), direct liability followed who issued the command. The court said this doesn't reach
  contributory infringement or CDNs in general.
- **Blockly's AGPL** covers modified versions of Blockly's own code (§13). Its aggregate clause keeps
  mods, packs and Minecraft separate works.
- **Commercial use** changes the answer under Mojang's guidelines, Modrinth's "non-commercial"
  wording, Overwolf's terms, FTB's terms and every CC-NC licence. It changes nothing under
  open-source licences.

**Assessment:** fetching from upstream is lower-risk under every source reviewed. A mirror is
defensible only where every file's licence allows commercial copies, and then only with the notices
and source offers kept.

### Mod licences that decide it

- <a id="dsmsl"></a>**FancyMenu, DSMSL v3.1**
  ([licence](https://github.com/Keksuccino/FancyMenu/blob/master/LICENSE.md)).
  - §3.1: "You may not re-upload, re-distribute, mirror, publish, or otherwise publicly share the
    mod's compiled JAR file".
  - §5.1: "It is acceptable for mod launchers ... to automatically download the mod ... as long as
    the mod is obtained from the official download sources".
  - Read as `reserved`: never copied, fetched from Modrinth. Whether a hosted server counts as a
    "mod launcher" is ambiguous; Blockly's servers fetch it from the same official source a launcher
    would.
- **Fzzy Config, TDL-M 1.3**
  ([licence](https://raw.githubusercontent.com/fzzyhmstrs/fconfig/master/LICENSE)).
  - "You may not distribute this software", "or restrict its access behind any paywall or monetised
    link".
  - "Permission is granted for Modpacks to include this software as long as the copy ... is included
    via a manifest which would download this software from its respective CurseForge or Modrinth
    page."
  - It sits in every Adrenaline build. Whether gating modpacks behind a paid plan is "restricting
    access behind a paywall" is a question for a lawyer.
- **JourneyMap** ([licensing](https://teamjm.github.io/journeymap-docs/latest/about/licensing/)).
  "you may not alter, host or distribute JourneyMap yourself". Packs are fine "as long as JourneyMap
  is downloaded from CurseForge or Modrinth".
- **BlayTheNinth** (Balm, Crafting Tweaks, NetherPortalFix, Waystones;
  [permissions](https://mods.twelveiterations.com/permissions)). "Publicly reuploading or rehosting
  mod files or associated material is not allowed."
- **Xaero's Minimap and World Map** (their Modrinth pages). "Only monetization of the modpack
  through CurseForge or Modrinth is allowed ... unless I have given you written permission to
  monetize it elsewhere."
- **Cobblemon** ([Fair Use Policy](https://cobblemon.com/en/fairuse)). "Cobblemon may be used on a
  commercial Minecraft server, provided that the assets used are not used outside of the scope of
  Minecraft". Also: "you may not distribute or sell copies of Cobblemon assets". Its code is MPL-2.0.

## Candidates

Checked 2026-09-27. Mod licences come from each project's declared licence on Modrinth, which is
the author's own statement and occasionally wrong. Counts of all-rights-reserved (ARR) files are
upper bounds, since pack side flags over-include. The class says what Blockly may do:

- **MIRROR**: safe to mirror on explicit licensing.
- **UPSTREAM**: download from upstream only.
- **PERMISSION**: requires author permission.
- **UNCLEAR**: do not ship.

| Pack (authors) | Latest · Minecraft · loader | Server distribution | Pack licence | What decides it | Class |
|---|---|---|---|---|---|
| <a id="skyblock-plus"></a>**SkyBlock Plus** (BPR02) | 1.0.9 · 26.2 · Fabric | Modrinth `.mrpack`, server-side only (vanilla players join) | Apache-2.0 | All 6 server jars MIT, Apache-2.0 or GPL-3.0 (No Command Confirm). Mirror owes notices and a GPL source offer | **MIRROR** (in the review) |
| <a id="cobblemon"></a>**Cobblemon Official Modpack** (Cobbled Studios) | 1.8.1 · 1.21.1 · Fabric | Modrinth `.mrpack`, links only; the 96 MiB is a client tutorial world | MPL-2.0 (assets under the Fair Use Policy) | 6 reserved works run on its servers: Xaero's Minimap and World Map, Balm, Crafting Tweaks, NetherPortalFix, FancyMenu (DSMSL, read above). The loading-tips archive it carries is its authors' own | **UPSTREAM**, offered as its authors publish it; a pack is held only on its authors' written no |
| Adrenaserver (SkywardMC) | 1.7.0 · 1.21.1 · Fabric | `.mrpack`, 11 links | MIT | All 11 mods MIT, LGPL-3.0 or Apache-2.0; merged into Adrenaline, discontinued | MIRROR, but obsolete |
| Adrenaline (SkywardMC) | 26.5.0 · 1.20.1–26.3 · Fabric | `.mrpack`, links only | MIT | Fzzy Config (TDL-M: manifest-only, no paywalls) | UPSTREAM, after the TDL-M paywall question |
| Monifactory | 0.13.8 · 1.20.1 · Forge | GitHub server zip (211 jars) | LGPL-3.0 | JourneyMap, Balm (no rehost), FTB Library (ARR), Quark and Jade (NC) | UPSTREAM, once NC mods are settled |
| Nomifactory CEu | 1.7.7 · 1.12.2 · Forge | GitHub server zip **with Mojang's jar** | LGPL-3.0 | Mojang's jar inside; Patchouli (NC) | UPSTREAM; never cache the zip |
| TerraFirmaGreg | 0.13.10 · 1.20.1 · Forge | GitHub zip and `.mrpack` (220 links + 47 carried jars) | LGPL-3.0 (core mod ARR on Modrinth) | 25 ARR server mods; Patchouli and Jade (NC) | UPSTREAM, once NC is settled |
| Divine Journey 2 | 2.23.4 · 1.12.2 · Forge | GitHub zip **with Mojang's jar** | GPL-3.0 | Mojang's jar; JourneyMap | UPSTREAM; never cache the zip |
| Star Technology | Theta 2 HF2 · 1.20.1 · Forge | GitHub zip **with Mojang's jar** | MIT | Balm, FTB mods, NC mods | UPSTREAM, once NC is settled |
| GregTech: New Horizons | 2.8.4 · 1.7.10 · Forge | Own site zip **with Mojang's jar** | CC BY-NC-SA 4.0 | Noncommercial pack | PERMISSION |
| All the Mods 9 / 10 | 8.2 · 1.21.1 · NeoForge | CurseForge server zip, 1.16 GiB | ARR | ARR and CurseForge | PERMISSION |
| Better MC 4 / 5 | v61 / v31 · 1.20.1 / 1.21.1 | CurseForge zip; Modrinth `.mrpack` with carried jars | ARR | ~79 ARR server mods | PERMISSION |
| Prominence II | 4.1.1hf · 1.20.1 · Fabric | `.mrpack` + CurseForge zip | ARR ("Do not reupload the files anywhere") | ARR | PERMISSION |
| Vault Hunters 3 | 3.21.7 · 1.18.2 · Forge | CurseForge zip | ARR | closed ARR core mod | PERMISSION |
| RLCraft, SkyFactory 5, DawnCraft, Cisco's, Create: Above and Beyond, Create: Astral, Enigmatica, Craftoria | various | CurseForge (some ServerStarter stubs) | ARR | ARR and CurseForge | PERMISSION |
| FTB StoneBlock 4, Evolution, Skies 2 | 1.21.1 · NeoForge | FTB API + installer | FTB policy ("Hosting servers" carved out) | "services to third parties" clause | UPSTREAM, after FTB confirms |
| Cabricality, Create: Arcane Engineering | 1.18.2 | `.mrpack` / CurseForge | GPL-3.0 (conflicting ARR on CurseForge) | FTB mods left out by hand; licence conflict | UNCLEAR |
| Fabulously Optimized, Additive | 26.x | client packs | BSD-3 / MIT | not for servers | not a server template |

Across the 27 Modrinth packs checked file by file, the open-licensed ones still install
all-rights-reserved or noncommercial mods on the server. Some counts of server files:

- Create+ (LGPL): 19 ARR, 2 NC.
- Society: Sunlit Valley (GPL): 61 ARR, 12 NC.
- Vanilla Perfected (MIT): 27 ARR, 4 NC.
- Aged (MIT): 27 ARR, 4 NC.

Of the top 100 Modrinth modpacks by downloads, 50 are ARR themselves.

## Next steps

1. Make world downloads hold the world alone (and keep full archives for restores): today an
   archive is the whole `/data`, server jar and mod jars included.
2. Check jars before they run, not only after (a pre-start hash check in the pack entrypoint). That
   closes the `upstream` window where a file substituted after ingestion loads once.
3. Open catalog packs from search as hostile archives too, as curated ones are.
4. Consider scanning jars at ingestion for known malware signatures (Fractureiser's stage-0 pattern)
   before a release is verified.
5. Mirror individual files a pack's licences allow even when the pack as a whole can't be. That
   needs rewritten index links, which the image supports, but it gains little until most files are
   open.

## Blockly's own packs

Short lists of mods Blockly chose, offered on the create page beside the packs other people publish,
as one more card in "What to play". Picking one is the same single choice as picking a template: the
card says what playing it is, the Minecraft it plays and that friends join with plain Minecraft, and
nothing else. The lists are the review, in `apps/control/src/app/curation/own.ts`.

The current policy. Every pack:

- **asks nothing of players,** unless its review says players install it (`playersInstall`).
  Checking refuses a release of any other that
  would need anything in players' games;
- **is open-licensed all the way down.** Every mod and every library it pulls in is under a licence
  that allows commercial copies (open or copyleft, § Licences). Nothing all-rights-reserved,
  noncommercial or custom, even where fetching it from upstream would be allowed;
- **copies nothing.** Blockly keeps only the index it writes; every server fetches each mod from where
  its authors publish it, at the exact bytes checked.

### How a list becomes a release

- **Every hour** (`curation`), each list is resolved on every Minecraft Blockly offers, newest
  first, as creating a server with it would resolve it, dependencies and all. The newest release
  where all of it runs gets a release of the pack, named for the day and that Minecraft
  (`2026.09.28+26.3`), unless one exists for it already.
- **Checking it** (`curation-ingest`) resolves the list again, and refuses the release, in a sentence
  for an admin, when:
  - it no longer resolves;
  - players would need something;
  - a licence isn't open (judged by `judgeLicences`, like any pack's);
  - a file doesn't match the catalog's hash;
  - the loader has no build for that Minecraft.

  Otherwise it writes an index naming each file at its catalog download, keeps it, and records what
  it found, as a curated release's facts are.
- **An admin offers it** on Admin → Curated packs, as any release. From then on it is the release new
  servers get. A server never moves by itself. When a newer release is offered, the server's Mods page
  offers it too, and moving a world to a newer Minecraft is its owner's choice.
- **As versions move:** a pack stays on the newest Minecraft where all of it runs, and gets a release
  on a newer one as soon as every mod reaches it. Mod updates on the same Minecraft don't make new
  releases: servers keep the bytes they were checked with. A refused release waits for an admin to
  check it again.

### Sides

Modrinth marks many libraries as needed on both sides even when every mod asking for them runs on
the server alone. YUNG's API is marked `client_and_server`, yet each YUNG's structure mod that needs
it is `server_only`. So a library counts as needed by players only when something players need asks
for it (`neededByPlayers`). A mod the catalog itself marks for both sides always counts. That is why
Leaves Be Gone is left out: its own version is marked `client_and_server`, whatever its project
page says.

### <a id="easy-survival"></a>Easy survival

"Survival without the chores: graves keep your things, and trees fall whole." Fabric, on 26.3, the
newest Minecraft Blockly offers, where every mod has a release build. Licences as Modrinth declares
them, checked 2026-09-28.

| Mod | Project | Licence | Side (version) |
|---|---|---|---|
| Lithium | `gvQqBUqZ` | LGPL-3.0-only | client or server |
| FerriteCore | `uXXizFIs` | MIT | client or server |
| ServerCore | `4WWQxlQP` | MIT | server only |
| Universal Graves | `yn9u3ypm` | LGPL-3.0-only | server only |
| ↳ Polymer | `xGdtZczs` | LGPL-3.0-only | server, client optional |
| ↳ Fabric API | `P7dR8mSH` | Apache-2.0 | client or server |
| Right Click Harvest | `Cnejf5xM` | MIT | server only |
| ↳ Jamlib | `IYY9Siz8` | MIT | marked both, needed only by Right Click Harvest |
| FallingTree | `Fb4jn8m6` | LGPL-3.0-only | server, client optional |

Left out of what was proposed:

- **C2ME**: it publishes only alpha builds.
- **Leaves Be Gone**: its version is marked for both sides (§ Sides).

### <a id="adventure"></a>Adventure

"Taller mountains, deeper dungeons, and strongholds worth the trip." Fabric, on 26.1.2. YUNG's mods
have no 26.2 or 26.3 build yet, so this is the newest Minecraft all of it runs on.

| Mod | Project | Licence | Side (version) |
|---|---|---|---|
| Tectonic | `lWDHr9jE` | MIT | server, client optional |
| ↳ Lithostitched | `XaDC71GB` | MIT | server only |
| ↳ Fabric API | `P7dR8mSH` | Apache-2.0 | client or server |
| YUNG's Better Dungeons | `o1C1Dkj5` | LGPL-3.0-only | server only |
| YUNG's Better Strongholds | `kidLKymU` | LGPL-3.0-only | server only |
| YUNG's Better Mineshafts | `HjmxVlSr` | LGPL-3.0-only | server only |
| ↳ YUNG's API | `Ua7DFN59` | LGPL-3.0-only | marked both, needed only by server-only mods |
| ↳ Cloth Config | `9s6osm5g` | LGPL-3.0-only | client or server |

Friends need the same Minecraft as the server. The card says "Minecraft 26.1.2", and the server's
page says "Nothing to install: plain Minecraft 26.1.2 joins this server". Both come from what
checking the release found, so no copy was written for it. When YUNG's mods reach 26.3, a 26.3
release is put together by itself and waits for an admin to offer it.

Left out:

- **Terralith, Incendium, Nullscape and Structory** (Stardust Labs). Their licence allows for-profit
  servers, but also forbids using the work to "configure, test, debug, or augment" any AI system.
  Out until someone reads that clause for Blockly.
- **Dungeons and Taverns** (all rights reserved) and **Towns and Towers** (CC-BY-NC-SA-4.0): not open.

## Adding a pack

1. Read the pack's licence and every server file's, as § Licences says, by looking each mod up on
   its catalog. Quote anything unclear here. Adding the pack with a hold first is a safe trial: its
   releases are fetched and checked, and Admin → Curated packs shows its licences and what a copy of
   Blockly's own would need permission for, while nobody can offer it.
2. Add it to `CURATED_PACKS` with its releases pinned. Use:
   - the catalog's version id, sha512 and size (`GET /v2/version/<id>` on Modrinth);
   - the most its licences allow as `distribution`;
   - any readings, permissions, authored files or a hold.
3. Write its review here under an anchor, and list it in § Candidates.
4. After deploying, the release is checked by itself. An admin offers it on Admin → Curated packs
   once it is verified and nothing holds it.

One of Blockly's own packs is a list in `OWN_PACKS` instead, of catalog projects only, with its
review here under an anchor named for its key. It needs no pinned releases: they are put together
as § Blockly's own packs says.

## Versions Cubepals tested

A catalog's version metadata trails what really runs. BSkyBlock lists nothing past 26.1.1, and
AOneBlock, Level and Warps nothing past 26.1.2, yet all four make their worlds on Cubepals' Paper
26.1.2 and 26.2 (the boot test in cubepals/cubepals#10). Resolution matches a version strictly on
release and server type, so without help a template with one of them is pulled down to an older
release, or can't be made at all.

`app/curation/tested.ts` is the review of what Cubepals ran itself. Each record names one exact
catalog version, the release and server type it ran on, the build, the day, who tested it and what
showed it working. Resolution counts a record as a fit only where nothing the catalog lists fits,
so a set that resolved before resolves the same. A newer release of the same project isn't
covered until someone tests it and adds its own record.

To add one:

1. Boot that exact version on Cubepals' pinned build for the target. Read the log for errors and
   for the line that shows it working.
2. Add the record to `TESTED`, with the version id from the catalog (`GET /v2/project/<id>/version`
   on Modrinth) and the evidence in a line, or where the boot log is written up.

Admin → Curated packs lists every record with the day it was tested. It also lists each template
that brings plugins, against the newest release Cubepals offers for its server type. A template
is **Up to date** when every plugin lists that release, **Tested by Cubepals** when records carry
the ones that don't, and **Lagging** otherwise, naming each plugin that holds it back and the
newest release it lists. Players see none of this. Moving a world forward stays its owner's
decision.

## Tests

- **Rules:**
  - `domain/mods/curation.test.ts`: licence kinds and expressions, the verdict with readings,
    permissions and holds, distribution, the release's life, references.
  - `app/curation/packs.test.ts`: the review is well formed.
  - `app/curation/own.test.ts`: Blockly's own packs are well formed, releases are named and ordered,
    and libraries' sides are read (§ Sides).
  - `app/curation/tested.test.ts`: each tested record covers one exact version and target; a
    template lags, is covered or keeps up; a BentoBox setup on Paper 26.2 resolves only with the
    records.
  - `minecraft/pack-layout.test.ts` and `minecraft/packs.test.ts`: client-only files, and files that
    run as code.
- **Adapters:**
  - `infra/formats/pack-archives.test.ts`: held downloads (redirects, other hosts, loops) and
    byte-identical writes, whenever and in whichever time zone they happen.
  - `infra/modrinth/modrinth-catalog.test.ts`: licences in bulk.
- **End to end** on the stand-in runtime, with an in-memory store (`app/curation/curation.test.ts`,
  needs `DATABASE_URL`):
  - a mirrored pack installs from Blockly's copy and downloads nothing upstream;
  - an upstream pack fetches its authors' files;
  - refusals: changed versions, swapped packs, swapped or oversized mods, other hosts, traversal,
    ARR under a mirror, NC and unread licences;
  - a held pack can't be offered;
  - withdrawing keeps servers and copies;
  - updates are offered and applied only on request;
  - only admins act;
  - Blockly's own packs (`app/curation/own.test.ts`): a list lands on the newest Minecraft it runs
    on, installs from its authors, asks nothing of players, and gets a newer release when its mods
    reach a newer Minecraft; one that would need players or a closed licence is refused.
