import { describe, expect, test } from 'bun:test'
import { packCheck, packCleanup, packProblems } from './install-check.ts'
import {
  jarNamed,
  jarSide,
  leaveOutNow,
  modName,
  namedReleases,
  packNameOf,
  packNotes,
  packTierFor,
  runsOn,
  someNames,
} from './pack-build.ts'
import {
  curseForgeExport,
  curseForgeInstance,
  instanceIdentity,
  loaderId,
  packwizIndex,
  packwizMod,
  packwizPack,
} from './pack-manifests.ts'
import { fabricRange, mavenRange } from './uploads.ts'
import { packRuns } from './versions.ts'

describe('where a pack’s jar runs', () => {
  test('the catalog’s record of that exact file first, then what the jar says, then both sides', () => {
    expect(jarSide({ catalog: 'client_only' })).toBe('client')
    expect(jarSide({ catalog: 'singleplayer_only' })).toBe('client')
    expect(jarSide({ catalog: 'server_only' })).toBe('server')
    // A jar that says it runs anywhere is still left out when the catalog knows better.
    expect(jarSide({ catalog: 'client_only', metadata: { environment: 'both' } })).toBe('client')
    expect(jarSide({ catalog: 'unknown', metadata: { environment: 'client' } })).toBe('client')
    expect(jarSide({ metadata: { environment: 'server' } })).toBe('server')
    expect(jarSide({})).toBe('both')
  })
})

describe('what a folder of mods runs on', () => {
  const mod = (format: string, loaders: string[], range: string, id = 'x') => ({
    id,
    format: format as 'fabric.mod.json',
    loaders,
    gameVersions: format === 'fabric.mod.json' ? fabricRange(range) : mavenRange(range),
  })

  test('the loader the mods are for, and the newest release every one allows', () => {
    const fabric = [
      mod('fabric.mod.json', ['fabric'], '>=1.20 <1.21'),
      mod('fabric.mod.json', ['fabric'], '~1.20.1'),
    ]
    const candidates = ['1.21.1', '1.20.1', ...namedReleases(fabric)]
    expect(runsOn(fabric, candidates)).toEqual({ loader: 'fabric', gameVersion: '1.20.1' })
    const neo = [
      mod('META-INF/neoforge.mods.toml', ['neoforge'], '[1.21.1,1.22)'),
      mod('META-INF/mods.toml', ['forge'], '[1.21.1]'),
    ]
    expect(runsOn(neo, ['1.21.1', '1.20.1'])).toEqual({ loader: 'neoforge', gameVersion: '1.21.1' })
  })

  test('mods for different loaders or different releases can’t be one server, unless Connector bridges them', () => {
    expect(
      runsOn(
        [mod('META-INF/mods.toml', ['forge'], '[1.20.1]'), mod('fabric.mod.json', ['fabric'], '1.20.1')],
        ['1.20.1'],
      ),
    ).toHaveProperty('refused')
    expect(
      runsOn(
        [
          mod('META-INF/neoforge.mods.toml', ['neoforge'], '[1.21.1]'),
          mod('fabric.mod.json', ['fabric'], '1.21.1'),
          mod('META-INF/neoforge.mods.toml', ['neoforge'], '[1.21.1]', 'connectormod'),
        ],
        ['1.21.1'],
      ),
    ).toEqual({ loader: 'neoforge', gameVersion: '1.21.1' })
    expect(
      runsOn(
        [mod('fabric.mod.json', ['fabric'], '1.20.1'), mod('fabric.mod.json', ['fabric'], '1.21.1')],
        ['1.21.1', '1.20.1'],
      ),
    ).toHaveProperty('refused')
  })

  test('a 1.12.2 pack’s mods name the release they run on', () => {
    const old = [
      {
        id: 'x',
        format: 'mcmod.info' as const,
        loaders: ['forge'],
        gameVersions: [[{ op: '=' as const, version: '1.12.2' }]],
      },
    ]
    expect(runsOn(old, ['1.21.1', ...namedReleases(old)])).toEqual({ loader: 'forge', gameVersion: '1.12.2' })
  })
})

describe('the size a pack starts on', () => {
  test('what its author says first, generous as authors are', () => {
    expect(packTierFor({ memoryMb: 2048, mods: 300, jarBytes: 9e8 })).toBe('3g')
    expect(packTierFor({ memoryMb: 4096, mods: 1, jarBytes: 1 })).toBe('4g')
    expect(packTierFor({ memoryMb: 8192, mods: 1, jarBytes: 1 })).toBe('8g')
  })

  test('then the catalog’s tags, then what its jars weigh', () => {
    expect(packTierFor({ memoryMb: null, categories: ['lightweight'], mods: 90, jarBytes: 3e8 })).toBe('3g')
    expect(packTierFor({ memoryMb: null, categories: ['kitchen-sink'], mods: 5, jarBytes: 1e6 })).toBe('8g')
    // Saying nothing is the middle size, however few its mods: where every pack measured sat.
    expect(packTierFor({ memoryMb: null, mods: 8, jarBytes: 50 * 1024 ** 2 })).toBe('4g')
    expect(packTierFor({ memoryMb: null, mods: 136, jarBytes: 344 * 1024 ** 2 })).toBe('4g')
    expect(packTierFor({ memoryMb: null, mods: 464, jarBytes: 1.2 * 1024 ** 3 })).toBe('8g')
  })
})

describe('what the owner is told', () => {
  test('mods by the names people know them by', () => {
    expect(modName('mods/sodium-fabric-0.5.13+mc1.20.1.jar')).toBe('sodium')
    expect(modName('mods/Xaeros_Minimap_24.5.0_Forge_1.20.jar')).toBe('Xaeros Minimap')
    expect(modName('overrides/mods/oculus-mc1.20.1-1.7.0.jar')).toBe('oculus')
    expect(someNames(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c and 3 more')
    expect(someNames(['a', 'b'])).toBe('a and b')
  })

  test('a pack named only by its file: the pack’s name, and its version apart', () => {
    expect(packNameOf('Create-Above-and-Beyond-Server-1.3.zip')).toEqual({
      name: 'Create Above and Beyond',
      version: '1.3',
    })
    expect(packNameOf('Better MC [FORGE] BMC4 Server Pack v32.zip')).toEqual({
      name: 'Better MC [FORGE] BMC4',
      version: 'v32',
    })
    expect(packNameOf('Cobblemon-1.8-server.zip')).toEqual({ name: 'Cobblemon', version: '1.8' })
    expect(packNameOf('My Friends Pack.zip')).toEqual({ name: 'My Friends Pack', version: null })
    // Nothing but the words and a version: the words stay rather than no name at all.
    expect(packNameOf('ServerFiles-2.35.zip')).toEqual({ name: 'ServerFiles', version: '2.35' })
    expect(packNameOf('1.20.1.zip')).toEqual({ name: '1.20.1', version: null })
  })

  test('the jar a loader’s name for a mod points at, and none where it could be two', () => {
    const jars = [
      'mods/fogoverrides-1.20.1-1.3.jar',
      'mods/Xaeros_Minimap_24.5.0_Forge_1.20.jar',
      'mods/jei-1.20.1-forge.jar',
    ]
    expect(jarNamed(jars, 'Fog Overrides')).toBe('mods/fogoverrides-1.20.1-1.3.jar')
    expect(jarNamed(jars, 'fogoverrides')).toBe('mods/fogoverrides-1.20.1-1.3.jar')
    expect(jarNamed(jars, "Xaero's Minimap")).toBe('mods/Xaeros_Minimap_24.5.0_Forge_1.20.jar')
    expect(jarNamed(jars, 'Oculus')).toBeNull()
    expect(jarNamed(['mods/create-1.jar', 'mods/create-2.jar'], 'Create')).toBeNull()
  })

  test('what a pack server leaves out follows what its pack learned', () => {
    const pinned = ['mods/sodium.jar', 'overrides/mods/flywheel.jar']
    // Nothing learned: as pinned.
    expect(leaveOutNow(pinned, null)).toEqual(pinned)
    // A mod that stopped a server is left out, listed or carried; one put back runs again.
    expect(
      leaveOutNow(pinned, [
        { path: 'mods/sodium.jar', why: 'players' },
        { path: 'mods/fogoverrides.jar', why: 'crashed' },
      ]),
    ).toEqual(['mods/sodium.jar', 'mods/fogoverrides.jar', 'overrides/mods/fogoverrides.jar'])
  })

  test('only what they’d want to know', () => {
    expect(packNotes({ leftOutForPlayers: [], worlds: 0, memoryMb: null })).toEqual([])
    const notes = packNotes({
      leftOutForPlayers: ['mods/sodium-0.5.jar', 'mods/iris-1.7.jar'],
      worlds: 1,
      memoryMb: 12288,
    })
    expect(notes[0]).toBe('Cubepals left out 2 mods made for players’ games: sodium and iris.')
    expect(notes).toHaveLength(3)
  })
})

describe('the files other tools describe a pack in', () => {
  test('a CurseForge export: its loader, release, recommended memory and the files it lists', () => {
    const exported = curseForgeExport({
      manifestType: 'minecraftModpack',
      manifestVersion: 1,
      name: 'All the Mods 9',
      version: '0.3.2',
      overrides: 'overrides',
      minecraft: {
        version: '1.20.1',
        modLoaders: [{ id: 'forge-47.2.0', primary: true }],
        recommendedRam: 8192,
      },
      files: [{ projectID: 1, fileID: 2, required: true }],
    })
    expect(exported).toMatchObject({
      name: 'All the Mods 9',
      gameVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '47.2.0',
      memoryMb: 8192,
      files: [{ projectId: 1, fileId: 2, required: true }],
    })
    expect(curseForgeExport({ manifestType: 'somethingElse' })).toBeNull()
    expect(loaderId('neoforge-21.1.235')).toEqual({ loader: 'neoforge', version: '21.1.235' })
  })

  test('a Prism instance’s components and memory, and the CurseForge app’s profile', () => {
    const prism = instanceIdentity(
      {
        formatVersion: 1,
        components: [
          { uid: 'net.minecraft', version: '1.21.1' },
          { uid: 'net.neoforged', version: '21.1.77' },
        ],
      },
      'InstanceType=OneSix\nname=Friends\nMaxMemAlloc=6144\n',
    )
    expect(prism).toMatchObject({
      name: 'Friends',
      gameVersion: '1.21.1',
      loader: 'neoforge',
      loaderVersion: '21.1.77',
      memoryMb: 6144,
    })
    const app = curseForgeInstance({
      name: 'Mine',
      gameVersion: '1.20.1',
      baseModLoader: { name: 'forge-47.2.0', minecraftVersion: '1.20.1' },
    })
    expect(app).toMatchObject({
      name: 'Mine',
      gameVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '47.2.0',
    })
  })

  test('a Packwiz pack: its versions, its index and a mod’s source and side', () => {
    expect(
      packwizPack({
        name: 'P',
        index: { file: 'index.toml' },
        versions: { minecraft: '1.20.1', fabric: '0.16.9' },
      }),
    ).toMatchObject({
      gameVersion: '1.20.1',
      loader: 'fabric',
      loaderVersion: '0.16.9',
      index: 'index.toml',
    })
    expect(
      packwizIndex({ files: [{ file: 'mods/a.pw.toml', metafile: true }, { file: 'config/b.toml' }] }),
    ).toEqual([
      { file: 'mods/a.pw.toml', metafile: true },
      { file: 'config/b.toml', metafile: false },
    ])
    expect(
      packwizMod({
        name: 'Sodium',
        filename: 'sodium.jar',
        side: 'client',
        download: { url: 'https://cdn.example.test/sodium.jar', 'hash-format': 'sha512', hash: 'AB' },
        update: { modrinth: { 'mod-id': 'AANobbMI', version: 'abcd1234' } },
      }),
    ).toMatchObject({
      side: 'client',
      modrinth: { projectId: 'AANobbMI', versionId: 'abcd1234' },
      curseforge: null,
    })
    expect(
      packwizMod({
        filename: 'x.jar',
        download: { mode: 'metadata:curseforge' },
        update: { curseforge: { 'project-id': 1, 'file-id': 2 } },
      }),
    ).toMatchObject({ url: null, curseforge: { projectId: 1, fileId: 2 }, side: 'both' })
  })
})

describe('checking what a pack installed', () => {
  const jars = [
    { path: 'mods/a.jar', sha512: 'a'.repeat(128) },
    { path: 'mods/b.jar', sha512: 'b'.repeat(128) },
    { path: 'mods/c.jar', sha512: 'c'.repeat(128) },
  ]

  test('a jar the image recorded and holds other bytes, or none, is wrong; one it left out on purpose isn’t', () => {
    const check = packCheck(jars)
    if (check === null) throw new Error('no check')
    const out = [
      JSON.stringify({ files: ['mods/a.jar', 'mods/b.jar'] }),
      '',
      '--- blockly: end of manifest ---',
      `${'a'.repeat(128)}  mods/a.jar`,
      `${'f'.repeat(128)}  mods/b.jar`,
    ].join('\n')
    // c.jar isn't in the image's record: on its own list of mods for players' games.
    expect(packProblems(check, out)).toEqual(['mods/b.jar'])
    // With no record at all, every expected jar counts.
    expect(packProblems(check, `\n--- blockly: end of manifest ---\n${'a'.repeat(128)}  mods/a.jar`)).toEqual(
      ['mods/b.jar', 'mods/c.jar'],
    )
  })

  test('only plain paths reach a command line', () => {
    const check = packCheck([
      ...jars,
      { path: '../../etc/passwd', sha512: 'd'.repeat(128) },
      { path: '-rf', sha512: 'e'.repeat(128) },
    ])
    expect(check?.command.slice(4)).toEqual(['mods/a.jar', 'mods/b.jar', 'mods/c.jar'])
    expect(packCleanup(['mods/b.jar', '../x'])).toEqual(['rm', '-f', '--', '/data/mods/b.jar'])
  })
})

describe('the releases a pack may run on', () => {
  test('any release with a Java image and a pack loader, from 1.12.2 to the newest Blockly knows', () => {
    expect(packRuns('1.12.2', 'forge')).toBe(true)
    expect(packRuns('1.16.5', 'forge')).toBe(true)
    expect(packRuns('1.18.2', 'forge')).toBe(true)
    expect(packRuns('1.7.10', 'forge')).toBe(false)
    expect(packRuns('1.21.1', 'paper')).toBe(false)
    expect(packRuns('27.1', 'fabric')).toBe(false)
    expect(packRuns('1.21-pre1', 'fabric')).toBe(false)
  })
})
