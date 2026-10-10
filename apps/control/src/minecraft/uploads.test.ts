// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import {
  fabricRange,
  fits,
  JAR_VERSION_PLACEHOLDER,
  mavenRange,
  modMetadata,
  quiltRange,
  uploadedWorld,
  type VersionRange,
} from './uploads.ts'

// Metadata as real jars from Modrinth carry it (docs/dependency-audit.md, "Uploads"), decoded.
const lithium = {
  id: 'lithium',
  name: 'Lithium',
  version: '0.15.4+mc1.21.1',
  environment: '*',
  depends: { fabricloader: '>=0.15.0', minecraft: ['1.21', '1.21.1'] },
}
const fabricApi = {
  id: 'fabric-api',
  name: 'Fabric API',
  version: '0.116.17+1.21.1',
  environment: '*',
  depends: { fabricloader: '>=0.16.10', minecraft: '>=1.21- <1.21.2-' },
}
const quiltedFabricApi = {
  quilt_loader: {
    id: 'quilted_fabric_api',
    version: '7.7.0+0.92.2-1.20.1',
    metadata: { name: 'Quilted Fabric API (QFAPI) / Quilt Standard Libraries (QSL)' },
    depends: [
      { id: 'quilt_loader', versions: '>=0.25.0' },
      { id: 'minecraft', versions: { all: ['>=1.20-', '<1.20.2-'] } },
      'quilted_fabric_api_base',
    ],
  },
}
const sodiumNeoForge = {
  modLoader: 'javafml',
  mods: [{ modId: 'sodium', version: '0.8.13+mc1.21.1', displayName: 'Sodium' }],
  dependencies: {
    sodium: [
      { modId: 'minecraft', type: 'required', versionRange: '1.21.1', side: 'CLIENT' },
      { modId: 'neoforge', type: 'required', versionRange: '[21.1.82,)', side: 'CLIENT' },
      { modId: 'embeddium', type: 'incompatible', versionRange: '[0.0.1,)', side: 'CLIENT' },
    ],
  },
}
const jeiForge = {
  modLoader: 'javafml',
  mods: [{ modId: 'jei', version: JAR_VERSION_PLACEHOLDER, displayName: 'Just Enough Items' }],
  dependencies: {
    jei: [
      { modId: 'forge', mandatory: true, versionRange: '[47.0,)', side: 'BOTH' },
      { modId: 'minecraft', mandatory: true, versionRange: '[1.20.1, 1.20.2)', side: 'BOTH' },
    ],
  },
}
const chunky = {
  name: 'Chunky',
  version: '1.4.40',
  main: 'org.popcraft.chunky.ChunkyBukkit',
  'api-version': '1.13',
}

const allowed = (range: VersionRange, versions: string[]) => versions.filter((v) => fits(range, v))
const RELEASES = [
  '1.20',
  '1.20.1',
  '1.20.2',
  '1.20.6',
  '1.21',
  '1.21.1',
  '1.21.2',
  '1.21.11',
  '26.1.2',
  '26.3',
]

describe('mod and plugin jars', () => {
  test('Fabric mods: loaders, environment and the game versions they declare', () => {
    expect(modMetadata({ 'fabric.mod.json': lithium })).toEqual({
      format: 'fabric.mod.json',
      id: 'lithium',
      name: 'Lithium',
      version: '0.15.4+mc1.21.1',
      loaders: ['fabric'],
      environment: 'both',
      gameVersions: [[{ op: '=', version: '1.21' }], [{ op: '=', version: '1.21.1' }]],
      // The loader builds it accepts: an uploaded pack that names an older one runs on a newer.
      loaderVersions: [[{ op: '>=', version: '0.15.0' }]],
    })
    expect(allowed(fabricRange(lithium.depends.minecraft), RELEASES)).toEqual(['1.21', '1.21.1'])
    expect(allowed(fabricRange(fabricApi.depends.minecraft), RELEASES)).toEqual(['1.21', '1.21.1'])
    const clientOnly = modMetadata({ 'fabric.mod.json': { ...lithium, environment: 'client' } })
    expect(clientOnly?.environment).toBe('client')
    expect(modMetadata({ 'fabric.mod.json': { ...lithium, environment: 'server' } })?.environment).toBe(
      'server',
    )
  })

  test("Fabric's predicate forms", () => {
    const cases: Array<[unknown, string[]]> = [
      ['*', RELEASES],
      [undefined, RELEASES],
      ['1.20.x', ['1.20', '1.20.1', '1.20.2', '1.20.6']],
      ['~1.20.1', ['1.20.1', '1.20.2', '1.20.6']],
      ['^1.20', ['1.20', '1.20.1', '1.20.2', '1.20.6', '1.21', '1.21.1', '1.21.2', '1.21.11']],
      ['>=1.21.2', ['1.21.2', '1.21.11', '26.1.2', '26.3']],
      ['>1.21 <=1.21.2', ['1.21.1', '1.21.2']],
      ['=1.20.1', ['1.20.1']],
      ['1.21-rc.1', []],
      [
        ['1.20.1', '>=26'],
        ['1.20.1', '26.1.2', '26.3'],
      ],
    ]
    for (const [predicate, expected] of cases)
      expect(allowed(fabricRange(predicate), RELEASES)).toEqual(expected)
  })

  test('Quilt mods, with their nested specifiers', () => {
    const qsl = modMetadata({ 'quilt.mod.json': quiltedFabricApi })
    expect(qsl).toMatchObject({ id: 'quilted_fabric_api', loaders: ['quilt'], environment: 'both' })
    expect(allowed(qsl?.gameVersions ?? [], RELEASES)).toEqual(['1.20', '1.20.1'])
    expect(allowed(quiltRange({ any: ['1.20.1', '>=26'] }), RELEASES)).toEqual(['1.20.1', '26.1.2', '26.3'])
    expect(allowed(quiltRange(['*', '1.20.1']), RELEASES)).toEqual(RELEASES)
    expect(
      modMetadata({ 'quilt.mod.json': { ...quiltedFabricApi, minecraft: { environment: 'client' } } })
        ?.environment,
    ).toBe('client')
  })

  test('NeoForge and Forge mods, with Maven ranges and the jar version from the manifest', () => {
    const sodium = modMetadata({ 'META-INF/neoforge.mods.toml': sodiumNeoForge })
    // Every platform dependency is client-side: Sodium only runs in players' games.
    expect(sodium).toMatchObject({
      id: 'sodium',
      name: 'Sodium',
      loaders: ['neoforge'],
      environment: 'client',
    })
    expect(allowed(sodium?.gameVersions ?? [], RELEASES)).toEqual(['1.21.1'])

    const jei = modMetadata(
      { 'META-INF/mods.toml': jeiForge },
      'Manifest-Version: 1.0\nImplementation-Version: 15.59.0.212\n',
    )
    expect(jei).toMatchObject({ id: 'jei', version: '15.59.0.212', loaders: ['forge'], environment: 'both' })
    expect(allowed(jei?.gameVersions ?? [], RELEASES)).toEqual(['1.20.1'])
    // A mods.toml that depends on NeoForge is a NeoForge mod (1.20.1-era NeoForge read mods.toml).
    const neo = {
      ...jeiForge,
      dependencies: { jei: [{ modId: 'neoforge', versionRange: '[20.1,)', side: 'BOTH' }] },
    }
    expect(modMetadata({ 'META-INF/mods.toml': neo })?.loaders).toEqual(['neoforge'])
    expect(modMetadata({ 'META-INF/mods.toml': { ...jeiForge, clientSideOnly: true } })?.environment).toBe(
      'client',
    )

    const ranges: Array<[string, string[]]> = [
      ['[1.20,1.21)', ['1.20', '1.20.1', '1.20.2', '1.20.6']],
      ['(1.21,1.21.2]', ['1.21.1', '1.21.2']],
      ['[1.21.1]', ['1.21.1']],
      ['[26,)', ['26.1.2', '26.3']],
      ['(,1.20.1]', ['1.20', '1.20.1']],
      ['[1.20.1],[26.3]', ['1.20.1', '26.3']],
      ['', RELEASES],
    ]
    for (const [range, expected] of ranges) expect(allowed(mavenRange(range), RELEASES)).toEqual(expected)
  })

  test('plugins: server only, from their oldest API version on', () => {
    const plugin = modMetadata({ 'plugin.yml': chunky })
    expect(plugin).toMatchObject({
      id: 'Chunky',
      version: '1.4.40',
      loaders: ['bukkit'],
      environment: 'server',
    })
    expect(allowed(plugin?.gameVersions ?? [], RELEASES)).toEqual(RELEASES)
    const paper = modMetadata({ 'paper-plugin.yml': { ...chunky, 'api-version': '1.21' } })
    expect(paper).toMatchObject({ loaders: ['paper'] })
    expect(allowed(paper?.gameVersions ?? [], RELEASES)).toEqual([
      '1.21',
      '1.21.1',
      '1.21.2',
      '1.21.11',
      '26.1.2',
      '26.3',
    ])
  })

  test('a jar that declares several loaders is each of them; one with none is not a mod', () => {
    const both = modMetadata({ 'fabric.mod.json': lithium, 'META-INF/neoforge.mods.toml': sodiumNeoForge })
    expect(both).toMatchObject({ format: 'fabric.mod.json', id: 'lithium', loaders: ['fabric', 'neoforge'] })
    expect(modMetadata({})).toBeNull()
    expect(
      modMetadata({ 'mcmod.info': [{ modid: 'old', name: 'Old Mod', mcversion: '1.12.2' }] }),
    ).toMatchObject({
      id: 'old',
      loaders: ['forge'],
      gameVersions: [[{ op: '=', version: '1.12.2' }]],
    })
  })
})

describe('uploaded worlds', () => {
  const properties = {
    'level-name': 'world',
    'level-type': 'minecraft:normal',
    'level-seed': '',
    hardcore: 'false',
  }
  const levelDat = { Data: { LevelName: 'world', DataVersion: 5023, Version: { Name: '26.3', Snapshot: 0 } } }

  test('a download names its world in server.properties and describes it in level.dat', () => {
    expect(uploadedWorld(properties, levelDat)).toEqual({
      levelName: 'world',
      levelType: 'minecraft:normal',
      seed: null,
      hardcore: false,
      gameVersion: '26.3',
    })
    expect(
      uploadedWorld(
        { 'level-name': 'world-2', 'level-type': 'LARGEBIOMES', 'level-seed': ' -42 ', hardcore: 'true' },
        levelDat,
      ),
    ).toMatchObject({
      levelName: 'world-2',
      levelType: 'minecraft:large_biomes',
      seed: '-42',
      hardcore: true,
    })
    expect(uploadedWorld({ 'level-type': 'DEFAULT' }, levelDat)).toMatchObject({
      levelName: 'world',
      levelType: 'minecraft:normal',
    })
  })

  test('what Blockly can’t run is refused with what to fix', () => {
    const refusals = [
      uploadedWorld(null, levelDat),
      uploadedWorld({ 'level-name': 'My World' }, levelDat),
      uploadedWorld(properties, undefined),
      uploadedWorld(properties, { Data: { LevelName: 'world' } }),
    ]
    expect(refusals.map((r) => ('refused' in r ? r.refused : null))).toEqual([
      'This isn’t a Cubepals download: it has no server.properties naming its world.',
      'The world folder “My World” isn’t one Cubepals can run: use lowercase letters, digits, - and _ in its name and in level-name.',
      'The download has no world/level.dat, so it holds no world to restore.',
      'This world is from before Minecraft 1.9, too old to open here.',
    ])
  })
})
