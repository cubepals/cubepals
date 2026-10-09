# Where a mod runs: the server, players' games, or both

Sources checked September 2026, against the live Modrinth API, Modrinth's source on GitHub, and
the pinned image helpers. What Blockly does with each answer is at the end.

## Summary

1. **A mod's side is declared per version, and only the version tells the truth.** A project's
   `environment` array is the union of its versions' values, so one odd version adds a value:
   Sodium Plus lists `client_only` and `dedicated_server_only` because 1 of its 66 versions is a
   server variant, and Create lists `server_only_client_optional` beside `client_and_server`
   because 38 old versions were migrated to the wrong value. The value to act on is the one on the
   exact version installed.
2. **There are three answers about players, not two.** A player's game must have the mod to join
   (`client_and_server`); it runs without them and adds to a game that has it too (the three
   `…optional` / `prefers_both` values); or plain Minecraft gets all of it (`server_only`,
   `dedicated_server_only`, `client_or_server`). Lithium, Chunky, Simple Voice Chat, Jade and
   AppleSkin are all in the middle group.
3. **Nobody picks a modpack version by its environment.** The image picks by name, release type,
   game version and loader; Modrinth's own hosting lists only packs with a both-sides value, so a
   player's pack with one server version never appears there.
4. **Other hosts either say nothing or show the catalogue's labels.** Aternos and exaroton tell
   players to install everything the server has; Modrinth's hosting shows "Client", "Server",
   "Client and server" tags and a "Server only" toggle. Neither matches how Blockly works: it
   decides, and tells a player only what their game needs.

## 1. Modrinth's environments

Defined in Modrinth's announcement ([new environments, 2025-08-28](https://modrinth.com/news/article/new-environments/));
the tags modrinth.com shows come from
[EnvironmentTags.vue](https://github.com/modrinth/code/blob/main/packages/ui/src/components/project/EnvironmentTags.vue).

| Value | Meaning | On a dedicated server | A joining player |
|---|---|---|---|
| `client_only` | only in a player's game; works with plain servers | never | their own choice |
| `singleplayer_only` | does nothing in multiplayer | never | — |
| `client_only_server_optional` | must be in the player's game; a server copy adds extras | optional | their own choice |
| `server_only` | server-side; plain games join; also works in singleplayer | yes | nothing needed |
| `dedicated_server_only` | a dedicated server only, not singleplayer | yes | nothing needed |
| `server_only_client_optional` | must be on the server; a player's copy adds extras | yes | optional |
| `client_or_server` | either side alone gives all of it | yes | nothing needed |
| `client_or_server_prefers_both` | either side works; best on both | yes | optional |
| `client_and_server` | required on both sides | yes | **required** |
| `unknown` | could not be determined (old contradictory side pairs) | ? | ? |

- **Per version.** Every version carries one value, and the project array is documented as "all
  the environments that versions of this project support", unordered, with the version's value
  preferred ([openapi.yaml](https://docs.modrinth.com/openapi.yaml)). Modrinth's own sidebar shows
  only the first non-`unknown` entry, which is why Create's page carries the tags of a server mod
  with an optional player part
  ([ProjectSidebarCompatibility.vue](https://github.com/modrinth/code/blob/main/packages/ui/src/components/project/ProjectSidebarCompatibility.vue)).
- **`unknown`** can't be chosen by an author; it comes from contradictory old side pairs.
- **The deprecated `client_side` / `server_side`** are derived from `environment`
  ([v2_reroute.rs](https://github.com/modrinth/code/blob/main/apps/labrinth/src/routes/v2_reroute.rs)),
  and a project's pair from a single version, so they can misstate a project.

Measured 2026-09-23 (`api.modrinth.com/v2`):

| Group | Examples |
|---|---|
| plain Minecraft gets all of it | LuckPerms, Terralith (`server_only`); spark, FerriteCore (`client_or_server`) |
| a player's game must have it | Cobblemon, Create 6.x, Farmer's Delight, Waystones (`client_and_server`) |
| runs alone, adds to a game that has it | Lithium, Chunky, Simple Voice Chat, Jade, AppleSkin (`client_or_server_prefers_both`); Polymer, C2ME (`server_only_client_optional`); Xaero's Minimap, EMI (`client_only_server_optional`) |
| players' games only | Sodium, Iris, Mod Menu, Entity Culling (`client_only`) |

Of the 200 most-downloaded modpacks: 100 `client_and_server`, 55 `client_only`, 12
`client_or_server_prefers_both`, 11 `client_only_server_optional`, 5 `singleplayer_only`, 3
`client_or_server`, 1 `server_only`, and 13 with mixed values.

## 2. Modpacks, and what the image installs

- In a `.mrpack`, each file may carry `env: {client, server}`, each `required`, `optional` or
  `unsupported`; `server` there means the physical dedicated server
  ([format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)).
  `server-overrides/` is layered over `overrides/`.
- The image installs a pack file unless its `env.server` is `unsupported` or an exclude pattern
  matches it; optional files and files with no `env` are installed
  ([FileInclusionCalculator.java](https://github.com/itzg/mc-image-helper/blob/main/src/main/java/me/itzg/helpers/modrinth/FileInclusionCalculator.java)).
  On top of that it skips 104 well-known players'-game mods (Sodium, Iris, Xaero's Minimap…) by
  default, through `MODRINTH_DEFAULT_EXCLUDE_INCLUDES`
  ([docs](https://github.com/itzg/docker-minecraft-server/blob/master/docs/types-and-platforms/mod-platforms/modrinth-modpacks.md)).
- **Separate server versions** have no Modrinth convention; the format's answer is
  `server-overrides/`. Sodium Plus's `SERVER2.4.7` is an alpha marked `dedicated_server_only`,
  published the same day as its players' build. Blockly installed it for real on 2026-09-23: 103
  mods (Lithium, FerriteCore, Simple Voice Chat, Jade…), up in 2.2 s. Whether a plain game then
  joins follows from those labels; it was not tested with a player.
- The image picks a pack version by name, release type, game version and loader, never by
  environment; Modrinth's hosting lists only packs carrying a both-sides value
  ([use-server-install-content.ts](https://github.com/modrinth/code/blob/main/apps/frontend/src/composables/use-server-install-content.ts)).

## 3. What happens on each side

- **Fabric** quietly leaves out a mod declared for the other side; a mod depending on one then
  fails to load ([fabric.mod.json](https://wiki.fabricmc.net/documentation:fabric_mod_json_spec)).
- **NeoForge**: code for a player's game running on a dedicated server crashes on missing classes
  ([sides](https://docs.neoforged.net/docs/concepts/sides/)). **Forge**'s `clientSideOnly=true`
  skips loading on a server; `displayTest` only sets the server list's red cross
  ([sides](https://docs.minecraftforge.net/en/latest/concepts/sides/)).
- **A player without a mod the server has**: NeoForge turns away a game that can't agree a
  required channel, and lists what's missing to a modded one
  ([NetworkRegistry.java](https://github.com/neoforged/NeoForge/blob/26.3.x/src/main/java/net/neoforged/neoforge/network/registration/NetworkRegistry.java));
  Fabric API turns one away when the server has modded registry entries to sync
  ([RegistrySyncManager.java](https://github.com/FabricMC/fabric/blob/26.3/fabric-registry-sync-v0/src/main/java/net/fabricmc/fabric/impl/registry/sync/RegistrySyncManager.java)).
  So Create and Cobblemon lock plain games out, and LuckPerms, Chunky and spark don't. Read from
  the code, not tested live.

## 4. How others present it

- **Modrinth's hosting**: a "Server only" toggle in its mod browser (hiding `client_only` and
  `singleplayer_only`), warnings in its content tab for a players'-game mod that may break
  startup, and cards tagged "Client", "Server", "Client and server", "Client or server",
  "Singleplayer", "Dedicated server"
  ([common-messages.ts](https://github.com/modrinth/code/blob/main/packages/ui/src/utils/common-messages.ts)).
- **Aternos and exaroton** tell players to install every mod the server has, and the same pack
  ([Aternos](https://support.aternos.org/hc/en-us/articles/360027235871),
  [exaroton](https://support.exaroton.com/hc/en-us/articles/360019857818)); what their in-app
  libraries show is behind a login and unverified.
- **CurseForge** attaches server packs as extra files (`isServerPack`, `serverPackFileId`), and its
  sidebar's "Environment" is coarse: Sodium "Client", Cobblemon, Chunky and LuckPerms all "Client &
  Server", Create "Not Set"
  ([server packs](https://blog.curseforge.com/server-packs-tutorial/)).

## What Blockly does with it

Nobody using Blockly is asked to think about sides. Blockly reads them and acts.

- **Picking a pack.** Only packs people play together, or packs made for servers, are suggested
  (`suggestedForServers`); a player's pack with one server version is found by name, not
  suggested. A pack that can't be a server at all is dimmed, with one line, when someone searches
  for it by name. The version installed is the newest one a server can run, never a version for
  players' games (`setups/service.ts`).
- **What friends install.** A pack is taken as one everyone installs unless it says it is made for
  servers (`packEnvironment`): a friend turned away at the door is the worse mistake. For mods,
  friends install only what their game needs: nothing, unless one mod has to be in their game; then
  they install the loader anyway, and the mods that only add to a game that has them come along
  (`forPlayers`). A mod players can do without — Lithium, say — is never the reason to install a
  loader.
- **Adding a mod.** One that only runs in players' games can't be added, and says so; nothing else
  about sides is shown.

Unverified: Modrinth's hosting's own install logic, Aternos's and exaroton's in-app labels, and
live join behaviour with a missing mod.
