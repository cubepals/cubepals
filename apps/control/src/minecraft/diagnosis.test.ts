// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { type Diagnosis, diagnose } from './diagnosis.ts'

/**
 * Reading a failure out of a server's own output (§15.6). Every line below is the shape the
 * game, a loader or the image actually prints.
 */
describe('diagnosis', () => {
  test('out of memory is recognised before the stack trace that follows it', () => {
    expect(
      diagnose([
        '[12:00:00] [Server thread/INFO]: Preparing spawn area: 4%',
        'java.lang.OutOfMemoryError: Java heap space',
        '\tat net.minecraft.server.MinecraftServer.run(MinecraftServer.java:661)',
      ]),
    ).toEqual({
      summary:
        'It ran out of memory while loading. Its world, mods or players need more room than this size has.',
      remedy: 'more_room',
    })
  })

  // The owner's Better MC [FABRIC] BMC2 server's first start, 2026-09-24, as the log printed it.
  const window = [
    '[21:28:13] [main/INFO]: Applying default files...',
    '[21:28:14] [main/ERROR]: Error thrown while opening! Exiting',
    'java.awt.HeadlessException: ',
    'No X11 DISPLAY variable was set,',
    'but this program performed an operation which requires it.',
    '\tat java.awt.GraphicsEnvironment.checkHeadless(Unknown Source) ~[?:?]',
    '\tat javax.swing.JFrame.<init>(Unknown Source) ~[?:?]',
    '\tat toni.missingmodschecker.MissingModsWindow.<init>(MissingModsWindow.java:55) ~[missingmodschecker.jar:?]',
    '\tat net.fabricmc.loader.impl.FabricLoaderImpl.setupLanguageAdapters(FabricLoaderImpl.java:497) ~[fabric-loader-0.19.3.jar:?]',
  ]

  test('a pack that leaves mods for players to download by hand is the pack to change', () => {
    expect(diagnose(window)).toEqual({
      summary:
        'Its modpack leaves some of its mods for each player to download by hand, which a server can’t do, so it can’t run as a server. Pick another pack to play.',
      remedy: 'modpack',
    })
  })

  test('any mod that opens a window as the server starts is named', () => {
    const other = window.map((line) => line.replaceAll('missingmodschecker', 'fancymenu'))
    expect(diagnose(other)).toEqual({
      summary:
        'fancymenu opens a window as the server starts, and a server has no screen: it belongs in players’ games only.',
      remedy: 'mods',
      playersOnly: [{ name: 'fancymenu', id: null }],
    })
    // A trace that names no mod still says what happened.
    expect(diagnose(window.slice(0, 5))?.summary).toStartWith('A mod opens a window')
  })

  test('every mod Forge lists as reaching for the screen is named, each with its id', () => {
    // Zombie Storm 100 Days on the real image, 2026-09-26.
    expect(
      diagnose([
        '[15:39:37] [main/ERROR] [minecraft/Main]: Failed to start the minecraft server',
        'net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [',
        '\tCIT Resewn (citresewn) has failed to load correctly',
        '§7java.lang.NoClassDefFoundError: net/minecraft/client/renderer/texture/atlas/SpriteSource,',
        '\tJust Enough Characters (jecharacters) has failed to load correctly',
        '§7java.lang.NoClassDefFoundError: net/minecraft/client/searchtree/SuffixArray',
        ']',
      ]),
    ).toEqual({
      summary:
        'CIT Resewn and Just Enough Characters only run in players’ games, and stopped the server as it started.',
      remedy: 'mods',
      playersOnly: [
        { name: 'CIT Resewn', id: 'citresewn' },
        { name: 'Just Enough Characters', id: 'jecharacters' },
      ],
    })
  })

  test('of everything Fabric says is unmet, the need the owner can act on is named', () => {
    // An uploaded pack naming an older loader than one of its mods wants, and missing its library.
    expect(
      diagnose([
        '[05:45:30] [main/ERROR]: Incompatible mods found!',
        'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
        'A potential solution has been determined, this may resolve your problem:',
        "\t - Mod 'Waystones' (waystones) 21.1.25 requires version 0.17.3 or later of 'Fabric Loader' (fabricloader), but only the wrong version is present: 0.16.14!",
        "\t - Mod 'Waystones' (waystones) 21.1.25 requires any version of balm, which is missing!",
      ]),
    ).toEqual({ summary: 'Waystones needs balm, which isn’t installed.', remedy: 'mods', missing: 'balm' })
  })

  test('a missing dependency names what is missing', () => {
    const found = diagnose([
      "Mod 'Sodium' (sodium) 0.6.0 requires any version of fabric-api, which is missing!",
    ])
    expect(found?.remedy).toBe('mods')
    expect(found?.summary).toContain('fabric-api')
  })

  test('a modpack that no longer exists points at the pack, not at the mods', () => {
    expect(
      diagnose(['[mc-image-helper] ERROR : Unable to locate requested project given CCnu380y'])?.remedy,
    ).toBe('modpack')
  })

  test('Blockly failing to serve the pack is Blockly’s, and never blamed on the pack', () => {
    // The line a real run produced when the artifact endpoint had never been taught about packs.
    const found = diagnose([
      "[mc-image-helper] ERROR : 'install-modrinth-modpack' command failed. Version is 1.68.0: " +
        'FailedRequestException: HTTP request of http://host.docker.internal:4000/runtime/v1/artifacts/' +
        `0bec9311-7bbb-4e24-bae8-a044822c1c45/${'a'.repeat(128)}/pack.mrpack?t=xyz ` +
        'failed with 404 Not Found: Trying to retrieve file',
      '[init] [ERROR] Failed to installModrinth modpack',
    ])
    expect(found?.remedy).toBe('ours')
    expect(found?.summary).toContain('this one is ours')
  })

  test('a world that will not open offers the backup', () => {
    expect(diagnose(['Exception reading ./world/region/r.0.0.mca'])?.remedy).toBe('restore')
  })

  test('a port still held is worth starting again; Blockly’s own mistakes say so', () => {
    expect(diagnose(['[Server thread/WARN]: **** FAILED TO BIND TO PORT!'])?.remedy).toBe('retry')
    expect(diagnose(['Error: Unable to access jarfile /data/server.jar'])?.remedy).toBe('ours')
  })

  test('an ordinary boot says nothing, so nothing is claimed', () => {
    expect(
      diagnose([
        '[12:00:00] [Server thread/INFO]: Starting minecraft server version 26.3',
        '[12:00:07] [Server thread/INFO]: Done (7.004s)! For help, type "help"',
      ]),
    ).toBeNull()
  })
})

/**
 * What the itzg image prints before Java starts, ahead of every excerpt below: none of it is the
 * server's, and none of it may be read as a failure.
 */
const image = (type: string) => [
  "[init] Running as uid=1000 gid=1000 with /data as 'drwxr-xr-x 3 1000 1000 4096 Sep 26 12:00 /data'",
  `[init] Resolving type given ${type}`,
  '[init] Setting initial memory to 3000M and max to 3000M',
  '[init] Starting the Minecraft server...',
]

const mods = (summary: string): Diagnosis => ({ summary, remedy: 'mods' })

// Excerpts below follow real server logs (Aternos' codex corpus, and the owner's own servers),
// in the console format the image prints: "[12:00:00] [main/ERROR]: …".
describe('a mod made for players’ games alone', () => {
  // Forge 1.20.1: Mixin looks at client classes and recovers (the first four lines); Oculus doesn't.
  const forge = [
    ...image('FORGE'),
    '[init] Using Forge supplied run.sh script...',
    '[10:42:41] [main/INFO] [cp.mo.mo.Launcher/MODLAUNCHER]: ModLauncher running: args [--launchTarget, forgeserver, --fml.forgeVersion, 47.3.11, --fml.mcVersion, 1.20.1, --fml.forgeGroup, net.minecraftforge, --fml.mcpVersion, 20230612.114412, nogui]',
    '[10:42:49] [main/ERROR] [ne.mi.fm.lo.RuntimeDistCleaner/DISTXFORM]: Attempted to load class net/minecraft/client/MouseHandler for invalid dist DEDICATED_SERVER',
    '[10:42:49] [main/WARN] [mixin/]: Error loading class: net/minecraft/client/MouseHandler (java.lang.RuntimeException: Attempted to load class net/minecraft/client/MouseHandler for invalid dist DEDICATED_SERVER)',
    '[10:42:49] [main/WARN] [mixin/]: @Mixin target net.minecraft.client.MouseHandler was not found fabric-screen-api-v1.mixins.json:MouseMixin from mod fabric_screen_api_v1',
    '[10:42:54] [modloading-worker-0/ERROR] [ne.mi.fm.lo.RuntimeDistCleaner/DISTXFORM]: Attempted to load class net/minecraft/client/gui/screens/Screen for invalid dist DEDICATED_SERVER',
    '[10:42:54] [modloading-worker-0/ERROR] [ne.mi.fm.ja.FMLModContainer/LOADING]: Failed to create mod instance. ModID: oculus, class net.irisshaders.iris.Iris',
    'java.lang.RuntimeException: Attempted to load class net/minecraft/client/gui/screens/Screen for invalid dist DEDICATED_SERVER',
    '\tat net.minecraftforge.fml.loading.RuntimeDistCleaner.processClassWithFlags(RuntimeDistCleaner.java:57) ~[fmlloader-1.20.1-47.3.11.jar%2369!/:1.0]',
    '\tat cpw.mods.modlauncher.LaunchPluginHandler.offerClassNodeToPlugins(LaunchPluginHandler.java:88) ~[modlauncher-10.0.9.jar%2355!/:?]',
    '\tat net.minecraftforge.fml.javafmlmod.FMLModContainer.constructMod(FMLModContainer.java:73) ~[javafmllanguage-1.20.1-47.3.11.jar%23147!/:?]',
    '[10:42:54] [main/FATAL] [ne.mi.fm.ModLoader/LOADING]: Failed to complete lifecycle event CONSTRUCT, 1 errors found',
    '[10:42:54] [main/ERROR] [ne.mi.se.Main/FATAL]: Failed to start the minecraft server',
    'net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [',
    '\tOculus (oculus) has failed to load correctly',
    '§7java.lang.RuntimeException: Attempted to load class net/minecraft/client/gui/screens/Screen for invalid dist DEDICATED_SERVER',
    ']',
  ]

  test('Forge names the mod by the name its owner knows', () => {
    expect(diagnose(forge)).toEqual({
      ...mods('Oculus only runs in players’ games, and stopped the server as it started.'),
      playersOnly: [{ name: 'Oculus', id: 'oculus' }],
    })
    // Cut before Forge's summary, the id it printed above the trace is the name.
    expect(diagnose(forge.slice(0, 15))?.summary).toStartWith('oculus only runs in players’ games')
  })

  test('what Mixin looked at and recovered from is not the failure', () => {
    expect(diagnose(forge.slice(0, 10))).toBeNull()
  })

  test('a mod that refuses a server by itself is one too', () => {
    expect(
      diagnose([
        '[10:42:54] [modloading-worker-0/ERROR] [ne.mi.fm.ja.FMLModContainer/LOADING]: Failed to create mod instance. ModID: entity_model_features, class traben.entity_model_features.forge.EMFForge',
        'java.lang.UnsupportedOperationException: Attempting to load a clientside only mod [EMF] on the server, refusing',
        '\tat traben.entity_model_features.forge.EMFForge.<init>(EMFForge.java:39) ~[entity_model_features_forge_1.20.1-2.2.6.jar%23130!/:?]',
        'net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [',
        '\tEntity Model Features (entity_model_features) has failed to load correctly',
        '§7java.lang.UnsupportedOperationException: Attempting to load a clientside only mod [EMF] on the server, refusing',
        ']',
      ])?.summary,
    ).toBe('Entity Model Features only runs in players’ games, and stopped the server as it started.')
  })

  test('NeoForge: the client classes simply are not there', () => {
    expect(
      diagnose([
        ...image('NEOFORGE'),
        '[12:00:01] [main/INFO]: ModLauncher running: args [--launchTarget, forgeserver, --fml.neoForgeVersion, 21.1.72, --fml.fmlVersion, 4.0.31, --fml.mcVersion, 1.21.1, --fml.neoFormVersion, 20240808.144430, nogui]',
        '[12:00:06] [modloading-worker-0/ERROR] [ne.ne.fm.ja.FMLModContainer/LOADING]: Failed to create mod instance. ModID: sodiumextras, class toni.sodiumextras.SodiumExtras',
        'java.lang.NoClassDefFoundError: net/minecraft/client/gui/screens/Screen',
        '\tat toni.sodiumextras.SodiumExtras.<init>(SodiumExtras.java:41) ~[sodiumextras-neoforge-1.21.1-1.0.7.jar%23195!/:?]',
        'Caused by: java.lang.ClassNotFoundException: net.minecraft.client.gui.screens.Screen',
        'Exception in thread "main" net.neoforged.fml.ModLoadingException: Loading errors encountered:',
        '\t- Sodium Extras (sodiumextras) has failed to load correctly',
        '\t  java.lang.NoClassDefFoundError: net/minecraft/client/gui/screens/Screen',
      ]),
    ).toEqual({
      ...mods('Sodium Extras only runs in players’ games, and stopped the server as it started.'),
      playersOnly: [{ name: 'Sodium Extras', id: 'sodiumextras' }],
    })
    // Its development build says so in words.
    expect(
      diagnose([
        '[12:00:05] [modloading-worker-0/ERROR] [ne.ne.fm.ja.FMLModContainer/LOADING]: Failed to create mod instance. ModID: examplemod, class com.example.examplemod.ExampleMod',
        'java.lang.RuntimeException: Attempted to load class net/minecraft/client/Minecraft which is not present on the dedicated server',
      ])?.summary,
    ).toStartWith('examplemod only runs in players’ games')
  })

  test('Fabric names the mod whose entrypoint reached for the client', () => {
    expect(
      diagnose([
        ...image('FABRIC'),
        '[12:00:01] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.16.5',
        '[12:00:03] [main/ERROR]: Failed to start the minecraft server',
        "java.lang.RuntimeException: Could not execute entrypoint stage 'main' due to errors, provided by 'journeymap' at 'journeymap.common.Journeymap'!",
        '\tat net.fabricmc.loader.impl.FabricLoaderImpl.lambda$invokeEntrypoints$2(FabricLoaderImpl.java:403) ~[fabric-loader-0.16.5.jar:?]',
        '\tat net.minecraft.server.Main.main(Main.java:111) ~[server-intermediary.jar:?]',
        'Caused by: java.lang.RuntimeException: Cannot load class journeymap.client.ui.theme.ThemeLoader in environment type SERVER',
        '\tat net.fabricmc.loader.impl.transformer.FabricTransformer.transform(FabricTransformer.java:64) ~[fabric-loader-0.16.5.jar:?]',
        '\t... 12 more',
      ]),
    ).toEqual({
      ...mods('journeymap only runs in players’ games, and stopped the server as it started.'),
      playersOnly: [{ name: 'journeymap', id: null }],
    })
  })

  test('older Forge: the name comes from its report, or from its table of mods', () => {
    // Forge 1.16.5 names the mod only in the summary printed after the trace.
    expect(
      diagnose([
        '[03:57:43] [main/FATAL] [ne.mi.fm.lo.RuntimeDistCleaner/DISTXFORM]: Attempted to load class net/minecraft/client/entity/player/ClientPlayerEntity for invalid dist DEDICATED_SERVER',
        '[03:57:43] [main/ERROR] [ne.mi.fm.ja.FMLModContainer/]: Exception caught during firing event: Attempted to load class net/minecraft/client/entity/player/ClientPlayerEntity for invalid dist DEDICATED_SERVER',
        '\tat net.minecraftforge.fml.loading.RuntimeDistCleaner.processClassWithFlags(RuntimeDistCleaner.java:57) ~[forge.jar:36.2]',
        '[03:57:45] [main/FATAL] [minecraft/Main]: Failed to start the minecraft server',
        'net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [',
        '\tLees Creatures (leescreatures) encountered an error during the load_registries event phase',
        '§7java.lang.RuntimeException: Attempted to load class net/minecraft/client/entity/player/ClientPlayerEntity for invalid dist DEDICATED_SERVER',
        ']',
      ])?.summary,
    ).toStartWith('Lees Creatures only runs in players’ games')
    // Forge 1.7.10 names it by id above the trace, and by name in its table of mods.
    expect(
      diagnose([
        "\tUE\txaerominimap{1.16} [Xaero's Minimap] (Xaeros_Minimap_1.16_Forge_1.7.10.jar) ",
        '[22:50:33] [Server thread/ERROR] [FML/]: The following problems were captured during this phase',
        '[22:50:33] [Server thread/ERROR] [FML/]: Caught exception from xaerominimap',
        'java.lang.NoClassDefFoundError: net/minecraft/client/settings/KeyBinding',
        '\tat xaero.minimap.XaeroMinimap.<clinit>(XaeroMinimap.java:59) ~[XaeroMinimap.class:?]',
      ])?.summary,
    ).toStartWith("Xaero's Minimap only runs in players’ games")
  })
})

describe('mods that need other mods', () => {
  // Fabric Loader 0.14.23, as it printed it.
  const fabric = [
    ...image('FABRIC'),
    '[11:37:10] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.14.23',
    '[11:37:10] [main/WARN]: Mod resolution failed',
    '[11:37:10] [main/ERROR]: Incompatible mods found!',
    'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
    'A potential solution has been determined, this may resolve your problem:',
    "\t - Replace mod 'Indium' (indium) 1.0.27+mc1.20.1 with any version that is compatible with:",
    '\t\t - sodium 0.4.10+build.27',
    'More details:',
    "\t - Mod 'Indium' (indium) 1.0.27+mc1.20.1 requires version 0.5.3 of mod 'Sodium' (sodium), but only the wrong version is present: 0.4.10+build.27!",
    "\t - Mod 'Indium' (indium) 1.0.27+mc1.20.1 requires version 3.2.0 or later of fabric-renderer-api-v1, which is missing!",
    '\tat net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:51) ~[fabric-loader-0.14.23.jar:?]',
  ]
  const fabricSays = (detail: string) => diagnose([...fabric.slice(0, 11), detail])

  test('Fabric names both mods, and whether the other is missing or the wrong version', () => {
    expect(diagnose(fabric)).toEqual(mods('Indium needs another version of Sodium.'))
    expect(
      fabricSays(
        "\t - Mod 'Iris' (iris) 1.7.0+mc1.20.1 requires any version of fabric-api, which is missing!",
      ),
    ).toEqual({ ...mods('Iris needs fabric-api, which isn’t installed.'), missing: 'fabric-api' })
    expect(
      fabricSays(
        "\t - Mod 'Continuity' (continuity) 3.0.0+1.20.1 requires any version of mod 'Indium' (indium), which is disabled for this environment (client/server only)!",
      ),
    ).toEqual(mods('Continuity needs Indium, which only runs in players’ games.'))
    expect(
      fabricSays(
        "\t - Mod 'Mod A' (mod-a) 1.0.0 is incompatible with any version of mod 'Fabric API' (fabric-api), but a matching version is present: 0.80.0+1.19.4!",
      ),
    ).toEqual(mods('Mod A can’t run alongside Fabric API.'))
    // Without its details, the header still says what happened.
    expect(diagnose(fabric.slice(0, 8))?.summary).toStartWith('Its mods can’t run together')
  })

  test('a mod made for another Minecraft, or needing another loader, says so', () => {
    expect(
      fabricSays(
        "\t - Mod 'Sodium' (sodium) 0.5.8+mc1.20.4 requires version 1.20.4 of 'Minecraft' (minecraft), but only the wrong version is present: 1.20.1!",
      ),
    ).toEqual(mods('Sodium is made for another version of Minecraft.'))
    // Blockly picks the loader, so a loader too old is Blockly's.
    expect(
      fabricSays(
        "\t - Mod 'Fabric API' (fabric-api) 0.100.1+1.21 requires version 0.15.11 or later of 'Fabric Loader' (fabricloader), but only the wrong version is present: 0.14.21!",
      ),
    ).toEqual({
      summary:
        'Fabric API needs another version of Fabric Loader. Cubepals picks that itself, so this is ours to fix.',
      remedy: 'ours',
    })
  })

  test('older Fabric, in its own words', () => {
    expect(
      diagnose([
        '[16:33:50] [main/FATAL]: A critical error occurred',
        'net.fabricmc.loader.discovery.ModResolutionException: Errors were found!',
        " - Mod 'Extra Origins' (extraorigins) requires any version of mod pehkui, which is missing!",
        '\t - You must install any version of pehkui.',
      ]),
    ).toEqual({ ...mods('Extra Origins needs pehkui, which isn’t installed.'), missing: 'pehkui' })
    expect(
      diagnose([
        'net.fabricmc.loader.discovery.ModResolutionException: Could not find required mod: fabric requires {minecraft @ [~1.17-alpha.20.45.a]}',
      ]),
    ).toEqual(mods('fabric is made for another version of Minecraft.'))
  })

  test('Forge names who asked, and for what', () => {
    const forge = [
      ...image('FORGE'),
      '[12:00:02] [main/ERROR] [ne.mi.fm.lo.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:',
      "\tMod ID: 'geckolib', Requested by: 'alexsmobs', Expected range: '[4.2,)', Actual version: '[MISSING]'",
      "\tMod ID: 'minecraft', Requested by: 'create', Expected range: '[1.20.1,1.20.2)', Actual version: '1.20.4'",
    ]
    expect(diagnose(forge)).toEqual({
      ...mods('alexsmobs needs geckolib, which isn’t installed.'),
      missing: 'geckolib',
    })
    // Its crash report's table of mods gives the name its owner knows.
    expect(
      diagnose([
        ...forge,
        "\t\talexsmobs-1.22.8.jar                              |Alex's Mobs                   |alexsmobs                     |1.22.8              |SIDED_SETUP|Manifest: NOSIGNATURE",
      ])?.summary,
    ).toBe("Alex's Mobs needs geckolib, which isn’t installed.")
    expect(diagnose([...forge.slice(0, 5), forge[6] ?? ''])).toEqual(
      mods('create is made for another version of Minecraft.'),
    )
    expect(
      diagnose([
        "\tMod ID: 'citadel', Requested by: 'alexsmobs', Expected range: '[2.4.0,)', Actual version: '2.1.4'",
      ]),
    ).toEqual(mods('alexsmobs needs another version of citadel.'))
    expect(
      diagnose([
        "\tMod ID: 'forge', Requested by: 'create', Expected range: '[47.1.3,)', Actual version: '47.1.0'",
      ])?.remedy,
    ).toBe('ours')
    expect(diagnose(forge.slice(0, 5))).toEqual(mods('A mod needs another mod that isn’t installed.'))
  })

  test('NeoForge, and Forge 1.14 to 1.16, say it over two lines', () => {
    expect(
      diagnose([
        ...image('NEOFORGE'),
        'Exception in thread "main" net.neoforged.fml.ModLoadingException: Loading errors encountered:',
        '\t- Mod yungsmenutweaks requires yungsapi 1.21.1-NeoForge-5.1.2 or above',
        '\t  Currently, yungsapi is not installed',
      ]),
    ).toEqual({ ...mods('yungsmenutweaks needs yungsapi, which isn’t installed.'), missing: 'yungsapi' })
    // NeoForge's crash report says the same, and its table of mods has the name.
    expect(
      diagnose([
        '-- Mod loading issue for: yungsmenutweaks --',
        'Details:',
        '\tMod file: /server/mods/YungsMenuTweaks-1.21.1-NeoForge-2.1.1.jar',
        '\tFailure message: Mod yungsmenutweaks requires yungsapi 1.21.1-NeoForge-5.1.2 or above',
        '\t\tCurrently, yungsapi is not installed',
        "\t\tYungsMenuTweaks-1.21.1-NeoForge-2.1.1.jar         |YUNG's Menu Tweaks            |yungsmenutweaks               |1.21.1-NeoForge-2.1.1|COMMON_SET|Manifest: NOSIGNATURE",
      ])?.summary,
    ).toBe("YUNG's Menu Tweaks needs yungsapi, which isn’t installed.")
    // Forge 1.15 left Minecraft's colour codes in.
    expect(
      diagnose([
        'net.minecraftforge.fml.ModLoadingException: Mod §eazurecompat§r requires §6mmorpg§r §o1 or above§r',
        '§7Currently, §6mmorpg§r§7 is §o§nnot installed',
      ]),
    ).toEqual({ ...mods('azurecompat needs mmorpg, which isn’t installed.'), missing: 'mmorpg' })
    expect(
      diagnose([
        'net.minecraftforge.fml.ModLoadingException: Mod §ecar§r requires §6minecraft§r §o1.15.1§r',
        '§7Currently, §6minecraft§r§7 is §o1.15.2',
      ]),
    ).toEqual(mods('car is made for another version of Minecraft.'))
    expect(
      diagnose([
        'Mod §euteamcore§r requires §6forge§r §o28.2.0 or above§r',
        '§7Currently, §6forge§r§7 is §o28.1.117',
      ])?.remedy,
    ).toBe('ours')
  })

  test('Forge up to 1.12', () => {
    expect(
      diagnose([
        '[16:41:32] [Server thread/FATAL] [FML]: net.minecraftforge.fml.common.MissingModsException: Mod cofhcore (CoFH Core) requires [redstoneflux@[2.1.0,2.2.0)]',
      ]),
    ).toEqual({
      ...mods('CoFH Core needs a version of redstoneflux that isn’t installed.'),
      missing: 'redstoneflux',
    })
    expect(
      diagnose([
        '[18:19:10] [Server thread/FATAL] [FML]: net.minecraftforge.fml.common.MissingModsException: Mod appliedenergistics2 (Applied Energistics 2) requires [forge@[14.23.5.2768,)]',
      ])?.summary,
    ).toBe(
      'Applied Energistics 2 needs another version of Forge. Cubepals picks that itself, so this is ours to fix.',
    )
    expect(
      diagnose([
        "[03:23:41] [Server thread/ERROR] [FML/]: The mod ArchimedesShipsPlus (Archimedes' Ships Plus) requires mods [MovingWorld] to be available",
      ])?.summary,
    ).toBe("Archimedes' Ships Plus needs a version of MovingWorld that isn’t installed.")
    expect(
      diagnose([
        '[13:42:12] [Server thread/ERROR] [FML/]: The mod journeymap does not wish to run in Minecraft version Minecraft 1.10.2. You will have to remove it to play.',
      ]),
    ).toEqual(mods('journeymap is made for another version of Minecraft.'))
  })
})

describe('mods that change the same code, or come twice', () => {
  test('a Mixin failure names the mod it came from', () => {
    // Fabric Loader 0.16.10; the warning above it is a mod that carried on.
    expect(
      diagnose([
        ...image('FABRIC'),
        '[19:11:23] [main/WARN]: @Mixin target net.minecraft.class_287 was not found owo.mixins.json:BufferBuilderAccessor from mod owo',
        'java.lang.RuntimeException: Mixin transformation of net.minecraft.class_1297 failed',
        '\tat net.fabricmc.loader.impl.launch.knot.KnotClassDelegate.getPostMixinClassByteArray(KnotClassDelegate.java:427) ~[fabric-loader-0.16.10.jar:?]',
        'Caused by: org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered',
        '\tat org.spongepowered.asm.mixin.transformer.MixinProcessor.applyMixins(MixinProcessor.java:392) ~[sponge-mixin-0.15.4+mixin.0.8.7.jar:0.15.4+mixin.0.8.7]',
        'Caused by: org.spongepowered.asm.mixin.injection.throwables.InjectionError: Critical injection failure: Callback method setInWater(Z)Z in expandability-common.mixins.json:swimming.EntityMixin from mod expandability failed injection check, (3/4) succeeded. Scanned 0 target(s). Using refmap expandability-common-refmap.json',
      ]),
    ).toEqual(mods('expandability doesn’t work with this Minecraft or with the other mods.'))
    expect(
      diagnose([
        '[12:00:03] [main/ERROR]: Mixin apply for mod lithium failed lithium.mixins.json:ai.pathing.PathNodeDefaultsMixin from mod lithium -> net.minecraft.class_14: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure: @Inject annotation on getNodeType could not find any targets matching',
      ])?.summary,
    ).toStartWith('lithium doesn’t work')
    // Forge's Mixin names only the mod's config.
    expect(
      diagnose([
        '[12:00:04] [main/ERROR] [mixin/]: Mixin apply failed mixins.carryon.json:MixinPlayer -> net.minecraft.world.entity.player.Player: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure',
        'org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered',
        'Caused by: org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin [mixins.carryon.json:MixinPlayer] from phase [DEFAULT] in config [mixins.carryon.json] FAILED during APPLY',
      ])?.summary,
    ).toStartWith('carryon doesn’t work')
  })

  test('a Mixin failure it carried on from is not why it stopped', () => {
    expect(
      diagnose([
        '[12:00:03] [main/WARN]: Mixin apply for mod lithium failed lithium.mixins.json:ai.pathing.PathNodeDefaultsMixin from mod lithium -> net.minecraft.class_14: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure',
      ]),
    ).toBeNull()
  })

  test('the same mod twice is named once', () => {
    expect(
      diagnose([
        '[23:35:35] [main/FATAL]: A critical error occurred',
        "net.fabricmc.loader.discovery.ModResolutionException: Duplicate versions for mod ID 'fabric': [0.30.3+1.16 at /data/mods/fabric-api-0.30.3+1.16.jar]",
      ]),
    ).toEqual(mods('Two copies of fabric are installed.'))
    expect(
      diagnose([
        '[22:32:46] [Server thread/ERROR] [FML/]: Found a duplicate mod Baubles at [/data/mods/1.7.10/Baubles-1.7.10-1.0.1.10.jar, /data/mods/Baubles-1.7.10-1.0.1.10.jar]',
      ]),
    ).toEqual(mods('Two copies of Baubles are installed.'))
    // Forge 1.20.1: Embeddium carries Rubidium's id, so both are Rubidium to it.
    expect(
      diagnose([
        '[11:43:04] [main/ERROR] [ne.mi.fm.lo.UniqueModListBuilder/LOADING]: Found duplicate mods:',
        "\tMod ID: 'rubidium' from mod files: rubidium-mc1.20.1-0.7.1.jar, embeddium-0.3.31+mc1.20.1.jar",
        'net.minecraftforge.fml.loading.EarlyLoadingException: Duplicate mods found',
      ]),
    ).toEqual(mods('rubidium and embeddium are the same mod, so only one of them can be installed.'))
    expect(
      diagnose([
        'Exception in thread "main" net.neoforged.fml.ModLoadingException: Loading errors encountered:',
        '\t- Mod jei is present in multiple files: jei-1.21.1-neoforge-19.21.0.247.jar, jei-1.21.1-neoforge-19.19.0.221.jar',
      ]),
    ).toEqual(mods('Two copies of jei are installed.'))
  })

  test('two mods carrying the same code', () => {
    expect(
      diagnose([
        'Exception in thread "main" java.lang.module.ResolutionException: Module roughlyenoughitems contains package mezz.jei.api.runtime, module jei exports package mezz.jei.api.runtime to roughlyenoughitems',
        '\tat java.base/java.lang.module.Resolver.resolveFail(Resolver.java:901)',
      ]),
    ).toEqual(mods('roughlyenoughitems and jei can’t be installed together.'))
  })

  test('a mod that crashes as it starts is named', () => {
    expect(
      diagnose([
        ...image('FABRIC'),
        '[22:28:53] [main/ERROR]: Failed to start the minecraft server',
        "java.lang.RuntimeException: Could not execute entrypoint stage 'main' due to errors, provided by 'bfapi'!",
        '\tat net.fabricmc.loader.impl.entrypoint.EntrypointUtils.lambda$invoke0$0(EntrypointUtils.java:51) ~[fabric-loader-0.13.3.jar:?]',
        "Caused by: java.lang.NoSuchMethodError: net.minecraft.class_2370: method 'void <init>(net.minecraft.class_5321, com.mojang.serialization.Lifecycle)' not found",
      ]),
    ).toEqual(
      mods(
        'bfapi stopped the server while it was starting. It may not work with the others, or with this Minecraft.',
      ),
    )
  })
})

describe('what Blockly set up', () => {
  test('a loader older than its Java is Blockly’s to fix', () => {
    const older: Diagnosis = {
      summary:
        'It needs an older Java than the one Cubepals started it with. Cubepals picks the Java itself, so this is ours to fix.',
      remedy: 'ours',
    }
    // Forge 1.16.5 started on Java 21.
    expect(
      diagnose([
        ...image('FORGE'),
        'Exception in thread "main" java.lang.IllegalArgumentException: Unsupported class file major version 65',
        '\tat org.objectweb.asm.ClassReader.<init>(ClassReader.java:199)',
      ]),
    ).toEqual(older)
    // Forge 1.12.2 started on anything after Java 8.
    expect(
      diagnose([
        '[12:00:00] [main/INFO] [LaunchWrapper]: Loading tweak class name net.minecraftforge.fml.common.launcher.FMLServerTweaker',
        'Exception in thread "main" java.lang.ClassCastException: class jdk.internal.loader.ClassLoaders$AppClassLoader cannot be cast to class java.net.URLClassLoader (jdk.internal.loader.ClassLoaders$AppClassLoader and java.net.URLClassLoader are in module java.base of loader \'bootstrap\')',
        '\tat net.minecraft.launchwrapper.Launch.<init>(Launch.java:34)',
      ]),
    ).toEqual(older)
  })

  test('a full disk is Blockly’s, and only what came after the start counts', () => {
    expect(
      diagnose([
        // Recovered from on the way up, before the server said it had started.
        '[12:00:02] [main/WARN]: Mod resolution failed',
        '[12:00:20] [Server thread/INFO]: Done (18.204s)! For help, type "help"',
        "[12:30:00] [Server thread/INFO]: Saving chunks for level 'ServerLevel[world]'/minecraft:overworld",
        '[12:30:01] [IOWorker-1/ERROR]: Failed to store chunk [12, -4]',
        'java.io.IOException: No space left on device',
        '\tat java.base/sun.nio.ch.FileDispatcherImpl.write0(Native Method)',
      ]),
    ).toEqual({
      summary:
        'Cubepals ran out of room for this server’s files. Nothing about your server is wrong; this one is ours.',
      remedy: 'ours',
    })
  })

  test('memory running out under its other names', () => {
    for (const line of [
      'java.util.concurrent.CompletionException: java.lang.OutOfMemoryError: Metaspace',
      'Exception in thread "Server thread" java.lang.OutOfMemoryError: GC overhead limit exceeded',
    ])
      expect(diagnose(['Description: Exception in server tick loop', '', line])?.remedy).toBe('more_room')
  })
})

describe('healthy starts', () => {
  test('a modded start that got there says nothing, however noisy the way up', () => {
    expect(
      diagnose([
        ...image('FABRIC'),
        '[03:45:04] [main/INFO]: Loading Minecraft 1.19.4 with Fabric Loader 0.14.19',
        '[03:45:04] [main/WARN]: Warnings were found!',
        " - Mod 'Mod A' (mod-a) 1.0.0 conflicts with any version of mod 'Mod A' (mod-a), which is present with the following versions: 1.0.0!",
        '[03:45:04] [main/INFO]: Loading 42 mods:',
        '[03:45:07] [main/WARN]: @Mixin target net.minecraft.class_437 was not found owo.mixins.json:ScreenAccessor from mod owo',
        '[03:45:15] [Server thread/INFO]: Starting minecraft server version 1.19.4',
        '[03:45:26] [Server thread/INFO]: Done (10.832s)! For help, type "help"',
      ]),
    ).toBeNull()
    expect(
      diagnose([
        ...image('FORGE'),
        '[10:42:49] [main/ERROR] [ne.mi.fm.lo.RuntimeDistCleaner/DISTXFORM]: Attempted to load class net/minecraft/client/MouseHandler for invalid dist DEDICATED_SERVER',
        '[10:42:49] [main/WARN] [mixin/]: Error loading class: net/minecraft/client/MouseHandler (java.lang.RuntimeException: Attempted to load class net/minecraft/client/MouseHandler for invalid dist DEDICATED_SERVER)',
        '[10:42:54] [modloading-worker-0/INFO] [ne.mi.co.ForgeMod/FORGEMOD]: Forge mod loading, version 47.3.11, for MC 1.20.1 with MCP 20230612.114412',
        '[10:42:58] [Server thread/INFO] [ne.mi.se.de.DedicatedServer/]: Starting minecraft server version 1.20.1',
        '[10:43:12] [Server thread/INFO] [ne.mi.se.de.DedicatedServer/]: Done (13.502s)! For help, type "help"',
      ]),
    ).toBeNull()
  })
})
