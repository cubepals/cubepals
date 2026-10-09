import { describe, expect, test } from 'bun:test'
import { bootedWith, bootMismatch, modsLoaded, namesWhatStarted } from './logs.ts'

/**
 * Reading what actually started out of a start's own output. Every banner below is as its loader
 * prints it, after what the itzg image prints before Java starts; the image's lines say what it
 * installed, never what ran, and are not read.
 */
const image = (type: string) => [
  "[init] Running as uid=1000 gid=1000 with /data as 'drwxr-xr-x 3 1000 1000 4096 Sep 26 12:00 /data'",
  `[init] Resolving type given ${type}`,
  '[init] Setting initial memory to 3000M and max to 3000M',
  '[init] Starting the Minecraft server...',
]

describe('what started', () => {
  test('plain Minecraft, by its bundler handing over to the game', () => {
    expect(
      bootedWith([
        ...image('VANILLA'),
        '[init] Successfully setup vanilla Minecraft version 26.3',
        'Unpacking 26.3/server-26.3.jar (versions:26.3) to versions/26.3/server-26.3.jar',
        'Starting net.minecraft.server.Main',
        '[18:29:35] [Server thread/INFO]: Starting minecraft server version 26.3',
      ]),
    ).toEqual({ gameVersion: '26.3', loader: 'vanilla', loaderVersion: null })
    // Paper runs the same bundler into its own class, and is not plain Minecraft.
    expect(
      bootedWith([
        ...image('PAPER'),
        'Starting org.bukkit.craftbukkit.Main',
        '[12:00:03 INFO]: Starting minecraft server version 1.21.1',
      ]),
    ).toEqual({ gameVersion: '1.21.1', loader: null, loaderVersion: null })
  })

  test('Fabric and Quilt', () => {
    const fabric = [
      ...image('FABRIC'),
      'Starting net.fabricmc.loader.impl.game.minecraft.BundlerClassPathCapture',
      '[11:37:10] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.14.23',
      '[11:37:10] [main/INFO]: Loading 42 mods:',
      '\t- fabric-api 0.92.2+1.20.1',
      '[11:37:19] [Server thread/INFO]: Starting minecraft server version 1.20.1',
    ]
    expect(bootedWith(fabric)).toEqual({ gameVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.14.23' })
    expect(modsLoaded(fabric)).toBe(42)
    // Before Minecraft says its own version, the loader's banner does.
    expect(bootedWith(fabric.slice(0, 6)).gameVersion).toBe('1.20.1')
    const quilt = [
      ...image('QUILT'),
      '[19:33:44] [main/INFO]: Loading Minecraft 1.18.2 with Quilt Loader 0.16.1-beta.3',
      '[19:33:44] [main/INFO]: Loading 3 mods:',
      '[19:33:59] [Server thread/INFO]: Starting minecraft server version 1.18.2',
    ]
    expect(bootedWith(quilt)).toEqual({
      gameVersion: '1.18.2',
      loader: 'quilt',
      loaderVersion: '0.16.1-beta.3',
    })
    expect(modsLoaded(quilt)).toBe(3)
    // Fabric before 0.12 named the game but not itself.
    const oldFabric = [
      '[13:31:46] [main/INFO]: Loading for game Minecraft 1.16.5',
      '[13:31:49] [main/INFO]: [FabricLoader] Loading 3 mods: minecraft@1.16.5, java@8, fabricloader@0.11.1',
    ]
    expect(bootedWith(oldFabric)).toEqual({ gameVersion: '1.16.5', loader: 'fabric', loaderVersion: null })
    expect(modsLoaded(oldFabric)).toBe(3)
  })

  test('Forge, from its launch arguments and its own banner', () => {
    expect(
      bootedWith([
        ...image('FORGE'),
        '[init] Using Forge supplied run.sh script...',
        '[20:14:29] [main/INFO] [cp.mo.mo.Launcher/MODLAUNCHER]: ModLauncher running: args [--launchTarget, forgeserver, --fml.forgeVersion, 47.3.11, --fml.mcVersion, 1.20.1, --fml.forgeGroup, net.minecraftforge, --fml.mcpVersion, 20230612.114412, nogui]',
        '[20:14:40] [modloading-worker-0/INFO] [ne.mi.co.ForgeMod/FORGEMOD]: Forge mod loading, version 47.3.11, for MC 1.20.1 with MCP 20230612.114412',
        '[20:14:40] [modloading-worker-0/INFO] [ne.mi.co.MinecraftForge/FORGE]: MinecraftForge v47.3.11 Initialized',
        '[20:14:44] [Server thread/INFO] [ne.mi.se.de.DedicatedServer/]: Starting minecraft server version 1.20.1',
      ]),
    ).toEqual({ gameVersion: '1.20.1', loader: 'forge', loaderVersion: '47.3.11' })
    // Newer Forge launches with no versions in its arguments; its banner still says.
    expect(
      bootedWith([
        '[17:00:24] [main/INFO] [cp.mo.mo.Launcher/MODLAUNCHER]: ModLauncher running: args [--launchTarget, forge_server, nogui]',
        '[17:00:31] [modloading-worker-0/INFO] [ne.mi.co.ForgeMod/FORGEMOD]: Forge mod loading, version 53.0.7, for MC 1.21.3 with MCP 20241025.112443',
      ]),
    ).toEqual({ gameVersion: '1.21.3', loader: 'forge', loaderVersion: '53.0.7' })
    // Forge up to 1.12.
    expect(
      bootedWith([
        '[00:37:02] [main/INFO] [FML]: Forge Mod Loader version 14.23.5.2814 for Minecraft 1.12.2 loading',
        '[00:37:06] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer]: Starting minecraft server version 1.12.2',
        '[00:37:06] [Server thread/INFO] [FML]: MinecraftForge v14.23.5.2814 Initialized',
      ]),
    ).toEqual({ gameVersion: '1.12.2', loader: 'forge', loaderVersion: '14.23.5.2814' })
    expect(
      bootedWith(['[00:37:06] [Server thread/INFO] [FML]: MinecraftForge v14.23.5.2814 Initialized']),
    ).toEqual({
      gameVersion: null,
      loader: 'forge',
      loaderVersion: '14.23.5.2814',
    })
  })

  test('NeoForge, and never FancyModLoader’s own version for it', () => {
    expect(
      bootedWith([
        ...image('NEOFORGE'),
        '[16:58:54] [main/INFO]: ModLauncher running: args [--launchTarget, forgeserver, --fml.neoForgeVersion, 21.3.5-beta, --fml.fmlVersion, 4.0.31, --fml.mcVersion, 1.21.3, --fml.neoFormVersion, 20241023.131943, nogui]',
        '[16:59:02] [modloading-worker-0/INFO] [ne.ne.ne.NeoForgeMod/NEOFORGE-MOD]: NeoForge mod loading, version 21.3.5-beta, for MC 1.21.3',
        '[16:59:04] [Server thread/INFO] [ne.mi.se.de.DedicatedServer/]: Starting minecraft server version 1.21.3',
      ]),
    ).toEqual({ gameVersion: '1.21.3', loader: 'neoforge', loaderVersion: '21.3.5-beta' })
    // FancyModLoader without ModLauncher (Minecraft 26): its version is FML's, not NeoForge's.
    expect(
      bootedWith([
        ...image('NEOFORGE'),
        '[12:21:02] [main/INFO] [ne.ne.fm.lo.FMLLoader/]: Starting FancyModLoader version 11.0.3 (DEDICATED_SERVER in PROD)',
        '[12:21:06] [modloading-worker-0/INFO] [ne.ne.ne.NeoForgeMod/NEOFORGE-MOD]: NeoForge mod loading, version 26.1.0.1-beta, for MC 26.1',
      ]),
    ).toEqual({ gameVersion: '26.1', loader: 'neoforge', loaderVersion: '26.1.0.1-beta' })
    // NeoForge for 1.20.1 launched as Forge, under its own group, and kept Forge's banner.
    expect(
      bootedWith([
        '[12:00:00] [main/INFO] [cp.mo.mo.Launcher/MODLAUNCHER]: ModLauncher running: args [--launchTarget, forgeserver, --fml.forgeVersion, 47.1.106, --fml.mcVersion, 1.20.1, --fml.forgeGroup, net.neoforged, --fml.mcpVersion, 20230612.114412, nogui]',
        '[12:00:09] [modloading-worker-0/INFO] [ne.mi.co.ForgeMod/FORGEMOD]: Forge mod loading, version 47.1.106, for MC 1.20.1 with MCP 20230612.114412',
      ]).loader,
    ).toBe('neoforge')
  })

  test('output that says nothing claims nothing', () => {
    const setup = [...image('FABRIC'), '[init] Setting initial memory to 3000M and max to 3000M']
    expect(bootedWith(setup)).toEqual({ gameVersion: null, loader: null, loaderVersion: null })
    expect(modsLoaded(setup)).toBeNull()
  })
})

describe('what started, against what was set up', () => {
  const fabric = { gameVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5' }

  test('what was set up is what started', () => {
    expect(
      bootMismatch(fabric, { gameVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5' }),
    ).toBeNull()
    expect(bootMismatch(fabric, { gameVersion: null, loader: null, loaderVersion: null })).toBeNull()
    expect(
      bootMismatch(
        { gameVersion: '1.21', loader: 'vanilla', loaderVersion: null },
        { gameVersion: '1.21.0', loader: 'vanilla', loaderVersion: null },
      ),
    ).toBeNull()
    // Paper says nothing Blockly reads as a loader.
    expect(
      bootMismatch(
        { gameVersion: '1.21.1', loader: 'paper', loaderVersion: '130' },
        { gameVersion: '1.21.1', loader: null, loaderVersion: null },
      ),
    ).toBeNull()
  })

  test('another Minecraft', () => {
    expect(bootMismatch(fabric, { gameVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.16.5' })).toBe(
      'The server started Minecraft 1.20.1, but its mods are for 1.21.1.',
    )
    expect(
      bootMismatch(
        { gameVersion: '26.3', loader: 'vanilla', loaderVersion: null },
        { gameVersion: '26.2', loader: 'vanilla', loaderVersion: null },
      ),
    ).toBe('The server started Minecraft 26.2 instead of 26.3.')
  })

  test('another loader', () => {
    const neoForge = { gameVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.72' }
    expect(bootMismatch(neoForge, { gameVersion: '1.21.1', loader: 'forge', loaderVersion: '52.0.1' })).toBe(
      'The server started with Forge, but its mods are for NeoForge.',
    )
    expect(bootMismatch(neoForge, { gameVersion: '1.20.1', loader: 'forge', loaderVersion: '47.3.11' })).toBe(
      'The server started Minecraft 1.20.1 with Forge, but its mods are for NeoForge on 1.21.1.',
    )
    expect(bootMismatch(fabric, { gameVersion: '1.21.1', loader: 'vanilla', loaderVersion: null })).toBe(
      'The server started plain Minecraft, but its mods are for Fabric.',
    )
  })

  test('another build of the same loader, compared loosely', () => {
    const neoForge = { gameVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.72' }
    expect(
      bootMismatch(neoForge, { gameVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.72-beta' }),
    ).toBeNull()
    expect(
      bootMismatch(neoForge, { gameVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.65' }),
    ).toBe('The server started NeoForge 21.1.65 instead of 21.1.72.')
    expect(
      bootMismatch(
        { gameVersion: '1.20.1', loader: 'forge', loaderVersion: '1.20.1-47.3.11' },
        { gameVersion: '1.20.1', loader: 'forge', loaderVersion: '47.3.11' },
      ),
    ).toBeNull()
    // A build Blockly didn't pin is never a difference.
    expect(
      bootMismatch(
        { ...neoForge, loaderVersion: null },
        { gameVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.65' },
      ),
    ).toBeNull()
  })

  test('read straight from a start', () => {
    const booted = bootedWith([
      ...image('NEOFORGE'),
      '[16:58:54] [main/INFO]: ModLauncher running: args [--launchTarget, forgeserver, --fml.neoForgeVersion, 21.3.5-beta, --fml.fmlVersion, 4.0.31, --fml.mcVersion, 1.21.3, --fml.neoFormVersion, 20241023.131943, nogui]',
      '[16:59:04] [Server thread/INFO] [ne.mi.se.de.DedicatedServer/]: Starting minecraft server version 1.21.3',
    ])
    expect(
      bootMismatch({ gameVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.72' }, booted),
    ).toBe('The server started Minecraft 1.21.3, but its mods are for 1.21.1.')
  })
})

describe('the lines kept to say what started', () => {
  test('banners are kept and the rest of a long boot is not', () => {
    expect(
      namesWhatStarted('[12:00:01] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.14'),
    ).toBe(true)
    expect(
      namesWhatStarted(
        '[12:00:00] [main/INFO]: ModLauncher running: args [--launchTarget, forgeserver, --fml.forgeVersion, 47.2.0, --fml.mcVersion, 1.20.1]',
      ),
    ).toBe(true)
    expect(
      namesWhatStarted('[12:00:09] [Server thread/INFO]: Starting minecraft server version 1.20.1'),
    ).toBe(true)
    expect(namesWhatStarted('[12:00:10] [Worker-Main-2/INFO]: Preparing spawn area: 4%')).toBe(false)
  })
})
