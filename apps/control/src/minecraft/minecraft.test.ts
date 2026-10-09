import { describe, expect, test } from 'bun:test'
import { accessCommand, parseAccessFiles } from './access.ts'
import { announce, normalizeUuid, parseOnlinePlayers, refusedCommand } from './console.ts'
import { installCheck, installProblems, parseInstalled } from './install-check.ts'
import { diskName, jarsOf } from './jars.ts'
import { bootMilestone, classifyLine } from './logs.ts'
import { catalogLoadersFor, projectTypesFor, serverEnvironment } from './mods.ts'
import { IDENTITY_ENV, imageFor, PLAN_ENV, toRuntimeSpec, withoutFilesStep } from './runtime-spec.ts'
import { compareVersions, javaFor } from './versions.ts'

describe('version order', () => {
  test('numeric by part, across the 1.x and year-numbered schemes', () => {
    const shuffled = ['26.2', '1.21.10', '26.1.2', '1.21.8', '26.3', '1.21.11']
    expect([...shuffled].sort(compareVersions)).toEqual([
      '1.21.8',
      '1.21.10',
      '1.21.11',
      '26.1.2',
      '26.2',
      '26.3',
    ])
    expect(compareVersions('26.3', '26.3')).toBe(0)
    expect(compareVersions('26.3', '26.3.1')).toBe(-1)
  })
})

describe('versions and images', () => {
  test('Java follows the release', () => {
    expect(javaFor('26.3')).toBe(25)
    expect(javaFor('1.21.11')).toBe(21)
    expect(javaFor('1.20.4')).toBe(17)
    expect(javaFor('1.16.5')).toBe(8)
  })

  const plain = { gameVersion: '26.3', loader: 'vanilla' as const, modpack: null, mods: [] }
  test('plain Minecraft runs on the Alpine build where the image has one', () => {
    expect(imageFor(plain)).toBe('itzg/minecraft-server:2026.9.1-java25-alpine')
    expect(imageFor({ ...plain, gameVersion: '1.21.11' })).toBe(
      'itzg/minecraft-server:2026.9.1-java21-alpine',
    )
  })

  test('Java 17 and 8 have no Alpine build, so those releases keep Ubuntu', () => {
    expect(imageFor({ ...plain, gameVersion: '1.20.1' })).toBe('itzg/minecraft-server:2026.9.1-java17')
    expect(imageFor({ ...plain, gameVersion: '1.16.5' })).toBe('itzg/minecraft-server:2026.9.1-java8')
  })

  test('loaders, mods and packs keep the Ubuntu build, for their native libraries', () => {
    for (const loader of ['paper', 'fabric', 'quilt', 'forge', 'neoforge'] as const)
      expect(imageFor({ ...plain, gameVersion: '1.21.11', loader })).toBe(
        'itzg/minecraft-server:2026.9.1-java21',
      )
    const pack = { ...plain, loader: 'fabric' as const, modpack: {} as never }
    expect(imageFor(pack)).toBe('itzg/minecraft-server:2026.9.1-java25')
    expect(imageFor({ ...plain, mods: [{ loaders: ['fabric'] }] as never })).toBe(
      'itzg/minecraft-server:2026.9.1-java25',
    )
    // A datapack is data the game reads: plain Minecraft with one keeps the Alpine build.
    expect(imageFor({ ...plain, mods: [{ loaders: ['datapack'] }] as never })).toBe(
      'itzg/minecraft-server:2026.9.1-java25-alpine',
    )
  })

  test('plain Minecraft run on Paper keeps the Ubuntu build, as Paper does', () => {
    expect(imageFor({ ...plain, gameVersion: '1.21.11', loaderVersion: '132' })).toBe(
      'itzg/minecraft-server:2026.9.1-java21',
    )
  })
})

describe('toRuntimeSpec', () => {
  const input = {
    serverId: 's-1',
    world: {
      id: 'w',
      serverId: 's-1',
      levelName: 'world',
      name: 'World',
      seed: null,
      levelType: 'minecraft:normal',
      hardcore: false,
      generatedOnVersion: '26.3',
    },
    memoryTier: '4g' as const,
    rconPassword: 'secret',
    artifactUrl: () => 'https://example.test/a.jar',
    limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
    iconUrl: null,
  }
  const revision = {
    id: 'r',
    serverId: 's-1',
    number: 1,
    gameVersion: '26.3',
    loader: 'vanilla' as const,
    loaderVersion: null,
    settings: {
      difficulty: 'normal' as const,
      defaultGameMode: 'survival' as const,
      pvp: true,
      viewDistance: 10,
      simulationDistance: 10,
      maxPlayers: 10,
      motd: 'Sunset Valley',
      spawnProtection: 0,
      onlineMode: true,
    },
    mods: [],
    modpack: null,
    acknowledgedRevoked: [],
    reason: 'created' as const,
    basedOnRevisionId: null,
    createdBy: 'u',
  }

  test("the picture the owner picked is the server's icon in the multiplayer list", () => {
    const plain = toRuntimeSpec({ ...input, revision })
    expect(plain.env.ICON).toBeUndefined()
    const withIcon = toRuntimeSpec({
      ...input,
      revision,
      iconUrl: 'http://control.test/runtime/v1/icons/grass.png',
    })
    expect(withIcon.env.ICON).toBe('http://control.test/runtime/v1/icons/grass.png')
    // Without this the image keeps whatever icon the world was first given.
    expect(withIcon.env.OVERRIDE_ICON).toBe('TRUE')
    // Left out of what drift compares with the message, so neither restarts a world.
    expect(IDENTITY_ENV).toEqual(['ICON', 'OVERRIDE_ICON', 'MOTD'])
    // curl fetches it before the image does, so the image's Java helper doesn't at every start:
    // the same icon again is left alone, and another is handed over as a file.
    const [shell, flag, script] = withIcon.entrypoint ?? []
    expect([shell, flag]).toEqual(['/bin/sh', '-c'])
    expect(script).toContain('curl -fsSL --max-time 10 -o /tmp/blockly-icon "$ICON"')
    expect(script).toContain('cmp -s /tmp/blockly-icon /data/server-icon.png; then unset OVERRIDE_ICON')
    expect(script).toContain('export ICON=/tmp/blockly-icon')
    expect(script).toEndWith('exec /image/scripts/start "$@"')
    expect(withoutFilesStep(plain.entrypoint)).toBeUndefined()
  })

  test('a modded server keeps more memory outside its heap than a vanilla one', () => {
    // The capacity research: about 400 MB of JVM native plus 250 MB for the system, and more
    // for a modded server, which loads twice the classes. A live modpack run on the smallest
    // size sat at 93% of the container before anyone joined.
    const vanilla = toRuntimeSpec({ ...input, revision, memoryTier: '3g' })
    expect(vanilla.env.MEMORY).toBe('2048M')
    const withPack = toRuntimeSpec({
      ...input,
      memoryTier: '3g',
      revision: {
        ...revision,
        modpack: {
          catalog: 'modrinth',
          projectId: 'pack',
          versionId: 'v1',
          name: 'A Pack',
          versionLabel: '1.0',
          artifact: {
            ref: { kind: 'remote', url: 'https://cdn.test/pack.mrpack' },
            sha512: 'a'.repeat(128),
            sizeBytes: 1024,
            fileName: 'pack.mrpack',
          },
          page: 'https://modrinth.com/modpack/pack',
          environment: 'both',
          icon: null,
        },
      },
    })
    expect(withPack.env.MEMORY).toBe('1996M')
    // Which still leaves three times the live heap every pack in the research measured.
    expect(Number.parseInt(withPack.env.MEMORY ?? '0', 10)).toBeGreaterThan(3 * 639)
    // And a full gigabyte outside it for the JVM's own memory and the system.
    expect(3072 - Number.parseInt(withPack.env.MEMORY ?? '0', 10)).toBeGreaterThan(650)
  })

  test('a pack server clears the pack file the image kept when the pack pinned changes', () => {
    // mc-image-helper 1.68.0 keeps /data/modpack.mrpack once downloaded from a plain link, and
    // installs it again at every start; a server moved to another version went on running the old.
    const pack = (sha512: string, iconUrl: string | null = null) =>
      toRuntimeSpec({
        ...input,
        iconUrl,
        revision: {
          ...revision,
          modpack: {
            catalog: 'modrinth',
            projectId: 'pack',
            versionId: sha512.slice(0, 8),
            name: 'A Pack',
            versionLabel: '1.0',
            artifact: {
              ref: { kind: 'remote', url: 'https://cdn.test/pack.mrpack' },
              sha512,
              sizeBytes: 1024,
              fileName: 'pack.mrpack',
            },
            page: 'https://modrinth.com/modpack/pack',
            environment: 'both',
            icon: null,
          },
        },
      })
    const first = pack('a'.repeat(128))
    const second = pack('c'.repeat(128))
    expect(first.entrypoint?.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(first.entrypoint?.[2]).toContain('rm -f /data/modpack.mrpack')
    expect(first.entrypoint?.[2]).toContain('exec /image/scripts/start')
    expect(first.env.BLOCKLY_PACK).toBe('a'.repeat(32))
    expect(second.env.BLOCKLY_PACK).not.toBe(first.env.BLOCKLY_PACK)
    // Without a pack or an icon, only the first step (app/servers/paper-runtime.test.ts) is left.
    expect(withoutFilesStep(toRuntimeSpec({ ...input, revision }).entrypoint)).toBeUndefined()
    // One with both fetches its icon, then sees to its pack.
    const both = pack('a'.repeat(128), 'http://control.test/grass.png')
    expect(both.entrypoint?.[2]).toMatch(/blockly-icon.*modpack\.mrpack.*exec \/image\/scripts\/start/)
  })

  test('a pack’s files are left out and put back each by its exact path, the ways the image reads them', () => {
    const spec = toRuntimeSpec({
      ...input,
      revision: {
        ...revision,
        modpack: {
          catalog: 'modrinth',
          projectId: 'pack',
          versionId: 'v1',
          name: 'A Pack',
          versionLabel: '1.0',
          artifact: {
            ref: { kind: 'remote', url: 'https://cdn.test/p.mrpack' },
            sha512: 'b'.repeat(128),
            sizeBytes: 1,
            fileName: 'p.mrpack',
          },
          page: null,
          environment: 'both',
          icon: null,
          leaveOut: ['mods/Sodium-0.6.jar', 'overrides/mods/fog#2.jar', 'overrides/mods/a,b.jar'],
          forceInclude: ['mods/equator-2.5.3.jar'],
        },
      },
    })
    // Anchored patterns in the lower-cased path; commas and hashes can't be written plainly.
    expect(spec.env.MODRINTH_EXCLUDE_FILES).toBe('/^mods\\/sodium-0\\.6\\.jar$/')
    // The overrides' list is split at commas: a name holding one can't be said there, and stays.
    expect(spec.env.MODRINTH_OVERRIDES_EXCLUSIONS).toBe('mods/fog#2.jar')
    expect(spec.env.MODRINTH_FORCE_INCLUDE_FILES).toBe('/^mods\\/equator-2\\.5\\.3\\.jar$/')
  })

  test('never carries live administration', () => {
    const spec = toRuntimeSpec({ ...input, revision })
    for (const key of ['WHITELIST', 'OPS', 'WHITELIST_FILE', 'OPS_FILE', 'ENABLE_WHITELIST']) {
      expect(spec.env[key]).toBeUndefined()
    }
    expect(spec.env.ENFORCE_WHITELIST).toBe('TRUE')
    expect(spec.secrets).toEqual({ RCON_PASSWORD: 'secret' })
  })

  test('sizes the heap below the memory the server is promised', () => {
    const spec = toRuntimeSpec({ ...input, revision })
    expect(spec.resources.memoryMb).toBe(4096)
    expect(spec.env.MEMORY).toBe('3072M')
    expect(spec.stop.timeoutSeconds).toBeGreaterThan(Number(spec.env.STOP_DURATION))
  })

  test("a plan's limits become Minecraft's AFK kick and world border radius", () => {
    const free = toRuntimeSpec({
      ...input,
      revision,
      limits: { playerIdleKickMinutes: 30, worldRadius: 2500, storageGb: 3 },
    })
    expect(free.env.PLAYER_IDLE_TIMEOUT).toBe('30')
    expect(free.env.MAX_WORLD_SIZE).toBe('2500')
    // No limit: the kick is off, and the world border is Minecraft's own.
    const paid = toRuntimeSpec({ ...input, revision })
    expect(paid.env.PLAYER_IDLE_TIMEOUT).toBe('0')
    expect(paid.env.MAX_WORLD_SIZE).toBeUndefined()
    // Only these come from the plan: everything else is the revision's.
    const differing = Object.keys(free.env).filter((key) => free.env[key] !== paid.env[key])
    expect(differing.sort()).toEqual([...PLAN_ENV].sort())
  })

  test('3 GB servers get a 2 GB heap, and the world the disk its plan gives', () => {
    // Five players exploring apart left 56 MB of the machine free with a 2.25 GB heap, whose
    // live part never passed 1.1 GB; a gigabyte stays outside it for the JVM and the system.
    const spec = toRuntimeSpec({ ...input, revision, memoryTier: '3g' })
    expect(spec.resources.memoryMb).toBe(3072)
    expect(spec.env.MEMORY).toBe('2048M')
    expect(spec.storage.sizeGb).toBe(5)
  })

  test('modded loaders always list their mods, even when there are none', () => {
    const fabric = toRuntimeSpec({ ...input, revision: { ...revision, loader: 'fabric' } })
    expect(fabric.env.MODS).toBe('')
    expect(toRuntimeSpec({ ...input, revision }).env.MODS).toBeUndefined()
  })
})

describe('console', () => {
  test('parses online players', () => {
    expect(parseOnlinePlayers('There are 0 of a max of 20 players online: ')).toEqual({
      online: 0,
      max: 20,
      players: [],
    })
    expect(
      parseOnlinePlayers(
        'There are 2 of a max of 20 players online: Steve (069a79f4-44e9-4726-a5be-fca90e38aaf5), Alex (6ab4317889fd490597f60f67d9d76fd9)',
      ),
    ).toEqual({
      online: 2,
      max: 20,
      players: [
        { name: 'Steve', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5' },
        { name: 'Alex', uuid: '6ab43178-89fd-4905-97f6-0f67d9d76fd9' },
      ],
    })
  })

  test('normalizes uuids and refuses IP bans', () => {
    expect(normalizeUuid('069A79F444E94726A5BEFCA90E38AAF5')).toBe('069a79f4-44e9-4726-a5be-fca90e38aaf5')
    expect(refusedCommand('/ban-ip 1.2.3.4')).not.toBeNull()
    expect(refusedCommand('say hi')).toBeNull()
  })

  test('an announcement is a line from Cubepals, not from "[Rcon]", and stays one line', () => {
    const command = announce('Server stops in 2 minutes.\nBye "all"')
    expect(command.startsWith('tellraw @a ')).toBe(true)
    expect(JSON.parse(command.slice('tellraw @a '.length))).toEqual({
      text: '',
      extra: [
        { text: '[Cubepals] ', color: 'aqua' },
        { text: 'Server stops in 2 minutes. Bye "all"', color: 'yellow' },
      ],
    })
    expect(command).not.toContain('\n')
  })
})

describe('access files', () => {
  test('renders commands without control characters', () => {
    const player = { uuid: 'u', name: 'Steve' }
    expect(accessCommand({ type: 'ban', player, reason: 'griefing\nop Steve' })).toBe(
      'ban Steve griefing op Steve',
    )
    expect(accessCommand({ type: 'whitelist_mode', enabled: true })).toBe('whitelist on')
  })

  test('parses the files the server writes', () => {
    const stdout = [
      '@@whitelist.json@@',
      '[{"uuid":"069a79f4-44e9-4726-a5be-fca90e38aaf5","name":"Steve"}]',
      '@@ops.json@@',
      '[{"uuid":"069a79f4-44e9-4726-a5be-fca90e38aaf5","name":"Steve","level":4,"bypassesPlayerLimit":false}]',
      '@@banned-players.json@@',
      '[{"uuid":"6ab43178-89fd-4905-97f6-0f67d9d76fd9","name":"Alex","created":"2026-09-19 10:00:00 +0000","source":"Steve","expires":"forever","reason":"Banned by an operator."}]',
      '@@banned-ips.json@@',
      '[]',
      '@@server.properties@@',
      'white-list=true',
      'online-mode=false',
    ].join('\n')
    expect(parseAccessFiles(stdout)).toEqual({
      onlineMode: false,
      whitelistEnabled: true,
      whitelist: [{ uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Steve' }],
      operators: [
        { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Steve', level: 4, bypassesPlayerLimit: false },
      ],
      bans: [
        {
          uuid: '6ab43178-89fd-4905-97f6-0f67d9d76fd9',
          name: 'Alex',
          reason: 'Banned by an operator.',
          source: 'Steve',
          expiresAt: null,
        },
      ],
      ipBans: [],
    })
  })

  test('a missing file reads as empty; unreadable output throws', () => {
    expect(parseAccessFiles('@@whitelist.json@@\n[]\n@@server.properties@@\n').whitelistEnabled).toBe(false)
    expect(() => parseAccessFiles('sh: cannot cd')).toThrow()
  })
})

describe('server output', () => {
  test('reads the level from vanilla and Paper lines', () => {
    expect(classifyLine('[21:04:11] [Server thread/INFO]: Done (4.213s)! For help, type "help"')).toEqual({
      level: 'info',
      text: 'Done (4.213s)! For help, type "help"',
    })
    expect(classifyLine("[21:05:02] [Server thread/WARN]: Can't keep up! Is the server overloaded?")).toEqual(
      {
        level: 'warn',
        text: "Can't keep up! Is the server overloaded?",
      },
    )
    expect(classifyLine('[21:05:07 ERROR]: Could not pass event')).toEqual({
      level: 'error',
      text: 'Could not pass event',
    })
  })

  test('thread names may hold a slash', () => {
    expect(classifyLine('[21:06:00] [User Authenticator #1/WARN]: Slow login')).toEqual({
      level: 'warn',
      text: 'Slow login',
    })
    expect(classifyLine('[21:06:00] [RCON Client /172.25.0.1 #2/ERROR]: Broken pipe')).toEqual({
      level: 'error',
      text: 'Broken pipe',
    })
  })

  test('players and broadcasts are chat', () => {
    expect(classifyLine('[21:04:41] [Server thread/INFO]: <Steve> anyone want to build a castle?')).toEqual({
      level: 'chat',
      text: '<Steve> anyone want to build a castle?',
    })
    expect(classifyLine('[21:04:42] [Server thread/INFO]: [Not Secure] [Rcon] back in five')).toEqual({
      level: 'chat',
      text: '[Rcon] back in five',
    })
  })

  test("the control plane's own RCON connections are hidden", () => {
    expect(
      classifyLine('[21:07:00] [RCON Listener #1/INFO]: Thread RCON Client /172.25.0.1 started'),
    ).toBeNull()
    expect(
      classifyLine(
        '[21:07:00] [RCON Client /fdaa:0:1:a7b::2 #2/INFO]: Thread RCON Client /fdaa:0:1:a7b::2 shutting down',
      ),
    ).toBeNull()
  })

  test('anything unrecognised passes through as it is', () => {
    expect(classifyLine('Loading Minecraft 26.3 with Fabric Loader 0.19.5')).toEqual({
      level: 'info',
      text: 'Loading Minecraft 26.3 with Fabric Loader 0.19.5',
    })
  })

  test("the server jar's launcher is setup, not the game", () => {
    // The vanilla 26.3 bundler as it printed on 2026-09-23, and Paperclip's own lines.
    for (const line of [
      'Unpacking 26.3/server-26.3.jar (versions:26.3) to versions/26.3/server-26.3.jar',
      'Unpacking com/google/code/gson/gson/2.14.0/gson-2.14.0.jar (libraries:com.google.code.gson:gson:2.14.0) to libraries/com/google/code/gson/gson/2.14.0/gson-2.14.0.jar',
      'Starting net.minecraft.server.Main',
      'Starting org.bukkit.craftbukkit.Main',
      'Downloading mojang_26.3.jar',
      'Applying patches',
      // The image's runner, as it said the server had stopped on 2026-09-24.
      '2026-09-23T21:46:10.570Z\tINFO\tmc-server-runner\tDone',
    ])
      expect(classifyLine(line)).toEqual({ level: 'setup', text: line })
  })

  test("Java's own warnings are warnings", () => {
    expect(classifyLine('WARNING: A restricted method in java.lang.System has been called')).toEqual({
      level: 'warn',
      text: 'WARNING: A restricted method in java.lang.System has been called',
    })
  })

  test('terminal colour codes are dropped', () => {
    // Fly's init, as its log API returned it on 2026-09-19.
    expect(classifyLine('[32m INFO[0m Sending signal SIGINT to main child process w/ PID 634')).toEqual({
      level: 'info',
      text: ' INFO Sending signal SIGINT to main child process w/ PID 634',
    })
    expect(classifyLine('[33m[21:05:02 WARN]: Can’t keep up![m')).toEqual({
      level: 'warn',
      text: 'Can’t keep up!',
    })
  })
})

describe('how far a start has got', () => {
  // A vanilla 26.3 server's start, as the image printed it on 2026-09-23.
  test('the image setting up says nothing; Java starting, then the world, each move it on', () => {
    expect(bootMilestone('[init] Resolving type given VANILLA')).toBeNull()
    expect(
      bootMilestone('[mc-image-helper] 18:29:29.975 INFO  : Minecraft version 26.3 is already installed'),
    ).toBeNull()
    expect(bootMilestone('[init] Starting the Minecraft server...')).toBe('starting')
    expect(bootMilestone('[init] Using Forge supplied run.sh script...')).toBe('starting')
    expect(bootMilestone('WARNING: A restricted method in java.lang.System has been called')).toBeNull()
    expect(bootMilestone('[18:29:35] [Server thread/INFO]: Starting minecraft server version 26.3')).toBe(
      'starting',
    )
    expect(bootMilestone('[18:29:35] [Server thread/INFO]: Preparing level "world"')).toBe('loading_world')
    // Paper's own format.
    expect(bootMilestone('[18:29:35 INFO]: Preparing level "world"')).toBe('loading_world')
  })
})

describe('installed jars', () => {
  const sha = (c: string) => c.repeat(128)
  const pin = (name: string, sha512: string, fileName = `${name}.jar`) => ({
    source: { catalog: 'modrinth', projectId: name, versionId: `${name}-1` },
    name,
    versionLabel: '1.0',
    artifact: {
      ref: { kind: 'remote' as const, url: `https://cdn.example/${fileName}` },
      sha512,
      sizeBytes: 10,
      fileName,
    },
    environment: 'server' as const,
    loaders: ['fabric'],
    gameVersions: ['26.3'],
    origin: 'user' as const,
    requiredBy: [],
  })

  test('jars go where each loader reads them, named by content', () => {
    expect(jarsOf('vanilla')).toBeNull()
    expect(jarsOf('paper')).toEqual({ dir: '/data/plugins', env: 'PLUGINS' })
    expect(jarsOf('fabric')).toEqual({ dir: '/data/mods', env: 'MODS' })
    expect(diskName(pin('lithium', sha('a')).artifact)).toBe('aaaaaaaaaaaa-lithium.jar')
  })

  test('nothing to check without jars', () => {
    expect(installCheck({ loader: 'vanilla', mods: [pin('a', sha('a'))] })).toBeNull()
    expect(installCheck({ loader: 'fabric', mods: [] })).toBeNull()
    expect(installCheck({ loader: 'paper', mods: [pin('a', sha('a'))] })?.command.join(' ')).toContain(
      '/data/plugins',
    )
  })

  test('reads sha512sum, including its escaped names', () => {
    // GNU sha512sum in the image, for "odd\name.jar" and "new<newline>line.jar".
    const stdout = [
      `${sha('a')}  aaaaaaaaaaaa-lithium.jar`,
      `\\${sha('b')}  odd\\\\name.jar`,
      `\\${sha('c')}  new\\nline.jar`,
      'sha512sum: x.jar: Permission denied',
      '',
    ].join('\n')
    expect(parseInstalled(stdout)).toEqual(
      new Map([
        ['aaaaaaaaaaaa-lithium.jar', sha('a')],
        ['odd\\name.jar', sha('b')],
        ['new\nline.jar', sha('c')],
      ]),
    )
  })

  test('a jar missing or holding other bytes names its mod; extra jars are not ours to judge', () => {
    const check = installCheck({
      loader: 'fabric',
      mods: [pin('lithium', sha('a')), pin('sodium', sha('b'))],
    })
    if (check === null) throw new Error('expected a check')
    const installed = new Map([
      ['aaaaaaaaaaaa-lithium.jar', sha('c')],
      ['cccccccccccc-leftover.jar', sha('c')],
    ])
    expect(installProblems(check, installed)).toEqual(['lithium', 'sodium'])
    expect(
      installProblems(
        check,
        new Map([
          ['aaaaaaaaaaaa-lithium.jar', sha('a')],
          ['bbbbbbbbbbbb-sodium.jar', sha('b')],
        ]),
      ),
    ).toEqual([])
  })
})

describe('what a server type runs', () => {
  test('catalog loaders and project types per server type', () => {
    // Every server type reads datapacks from its world, plain Minecraft included.
    expect(catalogLoadersFor('fabric')).toEqual(['fabric', 'datapack'])
    expect(catalogLoadersFor('quilt')).toEqual(['quilt', 'fabric', 'datapack'])
    expect(catalogLoadersFor('paper')).toEqual(['paper', 'spigot', 'bukkit', 'datapack'])
    expect(catalogLoadersFor('vanilla')).toEqual(['datapack'])
    expect(projectTypesFor('paper')).toEqual(['plugin', 'datapack'])
    expect(projectTypesFor('neoforge')).toEqual(['mod', 'datapack'])
    expect(projectTypesFor('vanilla')).toEqual(['datapack'])
  })

  test("declared environments: the server's alone, players' too, players' if they like, or players' only", () => {
    // Plain Minecraft gets all of it: LuckPerms, Terralith, spark, FerriteCore.
    expect(serverEnvironment('server_only')).toBe('server')
    expect(serverEnvironment('dedicated_server_only')).toBe('server')
    expect(serverEnvironment('client_or_server')).toBe('server')
    // A player's game must have it to join: Create, Cobblemon.
    expect(serverEnvironment('client_and_server')).toBe('both')
    expect(serverEnvironment('unknown')).toBe('both')
    // It runs without players having it, and adds to a game that does: Lithium, Simple Voice
    // Chat, Jade (either side, better on both), Polymer (server, client optional), Xaero's
    // Minimap (client, server optional).
    expect(serverEnvironment('client_or_server_prefers_both')).toBe('optional')
    expect(serverEnvironment('server_only_client_optional')).toBe('optional')
    expect(serverEnvironment('client_only_server_optional')).toBe('optional')
    // Not on a server at all: Sodium, Iris.
    expect(serverEnvironment('client_only')).toBeNull()
    expect(serverEnvironment('singleplayer_only')).toBeNull()
  })
})
