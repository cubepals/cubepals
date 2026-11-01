// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { PinnedMod } from '../mods/artifact.ts'
import { playerCapacity } from '../server/size.ts'
import {
  bedrockOf,
  type ChangeFacts,
  changeKind,
  defaultSettings,
  describeChanges,
  isPlain,
  otherVersionsOf,
  type RevisionDraft,
  rewritesWorld,
  runsOnPaper,
  settingsProblems,
  welcome,
} from './revision.ts'

const draft = (patch: Partial<RevisionDraft> = {}): RevisionDraft => ({
  acknowledgedRevoked: [],
  files: [],
  gameVersion: '26.3',
  loader: 'vanilla',
  loaderVersion: null,
  settings: defaultSettings({ name: 'Sunset Valley', gameMode: 'survival', maxPlayers: 4 }),
  mods: [],
  modpack: null,
  reason: 'created',
  basedOnRevisionId: null,
  ...patch,
})

const mod = (projectId: string, name: string, sha512: string): PinnedMod => ({
  source: { catalog: 'modrinth', projectId, versionId: `${projectId}-v` },
  name,
  versionLabel: '1.0',
  artifact: {
    ref: { kind: 'remote', url: `https://cdn.example.test/${name}.jar` },
    sha512,
    sizeBytes: 1,
    fileName: `${name}.jar`,
  },
  environment: 'server',
  loaders: ['fabric'],
  gameVersions: ['26.3'],
  origin: 'user',
  requiredBy: [],
})

describe('settings', () => {
  test('a new server’s message is Blockly’s line, not its name again', () => {
    expect(welcome('testing')).toBe('"testing", a server created by Cubepals')
    // A name the list can't show all of in quotes drops out.
    expect(welcome('W'.repeat(60))).toBe(`"${'W'.repeat(60)}", a server created by Cubepals`)
    expect(welcome('W'.repeat(80))).toBe('A server created by Cubepals')
    expect(
      settingsProblems(defaultSettings({ name: 'x'.repeat(40), gameMode: 'survival', maxPlayers: 4 }), 4),
    ).toEqual([])
  })

  test('defaults are within bounds for the size they were made for', () => {
    expect(settingsProblems(draft().settings, playerCapacity('2g'))).toEqual([])
  })

  test('a server message with a check mark or a seal in it is refused', () => {
    for (const mark of ['✓', '✔', '☑', '✅', '🗸', '🏅']) {
      expect(settingsProblems({ ...draft().settings, motd: `&aJoin us ${mark}` }, 4)).toEqual([
        'Server messages can’t use check marks or seals.',
      ])
    }
    expect(settingsProblems({ ...draft().settings, motd: '&a★ Join us ★' }, 4)).toEqual([])
  })

  test('each bound is checked and worded', () => {
    const settings = {
      ...draft().settings,
      viewDistance: 2,
      simulationDistance: 40,
      spawnProtection: -1,
      maxPlayers: 5,
    }
    expect(settingsProblems(settings, playerCapacity('2g'))).toEqual([
      'View distance goes from 3 to 32 chunks.',
      'Simulation distance goes from 3 to 32 chunks.',
      'Spawn protection goes from 0 to 64 blocks.',
      'This size holds up to 4 players. Pick a bigger size for more.',
    ])
    const motd = (text: string) => settingsProblems({ ...draft().settings, motd: text }, 4)
    // What the list's two lines show is taken, and nothing past it.
    expect(motd('W'.repeat(88))).toEqual([])
    expect(motd('W'.repeat(89))).toEqual(['The last character won’t show in the server list.'])
    expect(motd('two\nlines')).toEqual(['The server message is one line of text.'])
    // Formatting codes take no room in the list, so they don't count; codes alone say nothing.
    expect(motd(`&a${'W'.repeat(88)}`)).toEqual([])
    expect(motd('&a&l')).toEqual(['Write something to show under the name.'])
  })
})

describe('changes between revisions', () => {
  test('version, loader, settings and mods, in that order', () => {
    const from = draft({ mods: [mod('a', 'Lithium', '1'), mod('b', 'Chunky', '2')] })
    const to = draft({
      gameVersion: '26.4',
      loader: 'fabric',
      settings: { ...from.settings, difficulty: 'hard' },
      mods: [mod('a', 'Lithium', '9'), mod('c', 'Carpet', '3')],
    })
    expect(describeChanges(from, to)).toEqual([
      { field: 'gameVersion', from: '26.3', to: '26.4' },
      { field: 'loader', from: 'vanilla', to: 'fabric' },
      { field: 'difficulty', from: 'normal', to: 'hard' },
      { field: 'mods', added: ['Carpet'], removed: ['Chunky'], changed: ['Lithium'] },
    ])
    expect(describeChanges(from, from)).toEqual([])
  })

  test('a new build of the same server type is a change; one that comes with a new type is not listed apart', () => {
    const fabric = draft({ loader: 'fabric', loaderVersion: '0.19.5' })
    expect(describeChanges(fabric, { ...fabric, loaderVersion: '0.19.6' })).toEqual([
      { field: 'loaderVersion', from: '0.19.5', to: '0.19.6' },
    ])
    expect(describeChanges(fabric, { ...fabric, loader: 'quilt', loaderVersion: '0.30.1' })).toEqual([
      { field: 'loader', from: 'fabric', to: 'quilt' },
    ])
    // A revision made before builds were pinned has none to compare.
    expect(describeChanges({ ...fabric, loaderVersion: null }, fabric)).toEqual([])
  })

  test('only a new version or server type rewrites the world', () => {
    expect(rewritesWorld(draft(), draft({ gameVersion: '26.4' }))).toBe(true)
    expect(rewritesWorld(draft(), draft({ loader: 'paper' }))).toBe(true)
    expect(rewritesWorld(draft(), draft({ settings: { ...draft().settings, pvp: false } }))).toBe(false)
  })

  test('plain Minecraft runs on Paper only with a build, no mods and no pack', () => {
    expect(runsOnPaper(draft({ loaderVersion: '132' }))).toBe(true)
    expect(runsOnPaper(draft())).toBe(false)
    expect(runsOnPaper(draft({ loader: 'paper', loaderVersion: '132' }))).toBe(false)
    expect(runsOnPaper(draft({ loaderVersion: '132', mods: [mod('a', 'A', 'a'.repeat(128))] }))).toBe(false)
  })

  test('moving plain Minecraft onto Paper or off it rewrites the world, and says so', () => {
    const paper = draft({ loaderVersion: '132' })
    expect(rewritesWorld(paper, draft())).toBe(true)
    expect(rewritesWorld(draft(), paper)).toBe(true)
    // A newer Paper build is no more than another build of the same server type.
    expect(rewritesWorld(paper, draft({ loaderVersion: '133' }))).toBe(false)
    expect(describeChanges(paper, draft())).toEqual([{ field: 'onPaper', from: true, to: false }])
    expect(describeChanges(draft(), paper)).toEqual([{ field: 'onPaper', from: false, to: true }])
    // Moving to a mod loader says the server type, not Paper as well.
    expect(describeChanges(paper, draft({ loader: 'fabric', loaderVersion: '0.19.5' }))).toEqual([
      { field: 'loader', from: 'vanilla', to: 'fabric' },
    ])
  })
})

describe('what a change is', () => {
  const settings = { ...draft().settings, motd: 'Another day' }
  test('by the costliest thing applying it does', () => {
    expect(changeKind(describeChanges(draft(), draft({ settings })), true)).toBe('settings')
    expect(changeKind(describeChanges(draft(), draft({ settings })), false)).toBe('world')
    expect(changeKind(describeChanges(draft(), draft({ gameVersion: '26.4', settings })), false)).toBe(
      'version',
    )
    expect(changeKind(describeChanges(draft(), draft({ loaderVersion: '120' })), true)).toBe('version')
    const lithium = mod('lithium', 'Lithium', 'a'.repeat(128))
    expect(changeKind(describeChanges(draft(), draft({ mods: [lithium], settings })), true)).toBe('mods')
    expect(
      changeKind(
        [
          { field: 'modpack', from: 'Cobblemon 1.6', to: 'Cobblemon 1.7' },
          ...describeChanges(draft(), draft({ gameVersion: '26.4' })),
        ],
        true,
      ),
    ).toBe('pack')
  })
})

test('compatibility defaults and explicit choices preserve each loader’s owner choice', () => {
  for (const loader of ['vanilla', 'paper', 'fabric', 'quilt', 'forge', 'neoforge'] as const) {
    const base = draft({ loader })
    expect(otherVersionsOf(base)).toBe(loader === 'vanilla' ? 'off' : 'on')
    expect(bedrockOf(base)).toBe(loader !== 'vanilla')
    for (const bedrock of [true, false])
      expect(bedrockOf({ ...base, settings: { ...base.settings, bedrock } })).toBe(bedrock)
    for (const otherVersions of ['off', 'on', 'oldest'] as const)
      expect(otherVersionsOf({ ...base, settings: { ...base.settings, otherVersions } })).toBe(otherVersions)
  }
})

test('absent keep inventory means off; both changes are described once', () => {
  const base = draft()
  const off = draft({ settings: { ...base.settings, keepInventory: false } })
  const on = draft({ settings: { ...base.settings, keepInventory: true } })
  expect(describeChanges(base, off)).toEqual([])
  expect(describeChanges(off, base)).toEqual([])
  expect(describeChanges(base, on)).toEqual([{ field: 'keepInventory', from: false, to: true }])
  expect(describeChanges(on, base)).toEqual([{ field: 'keepInventory', from: true, to: false }])
  expect(describeChanges(on, off)).toEqual([{ field: 'keepInventory', from: true, to: false }])
  expect(changeKind(describeChanges(base, on), true)).toBe('settings')
  expect(defaultSettings({ name: '  Moss  ', gameMode: 'creative', maxPlayers: 17 })).toEqual({
    difficulty: 'normal',
    defaultGameMode: 'creative',
    pvp: true,
    viewDistance: 10,
    simulationDistance: 10,
    maxPlayers: 17,
    motd: '"Moss", a server created by Cubepals',
    spawnProtection: 0,
    onlineMode: true,
  })
})

test('settings accept exact limits, all modes, and refuse fractional or invalid choices', () => {
  const base = draft().settings
  for (const difficulty of ['peaceful', 'easy', 'normal', 'hard'] as const)
    expect(settingsProblems({ ...base, difficulty }, 4)).toEqual([])
  for (const defaultGameMode of ['survival', 'creative', 'adventure', 'spectator'] as const)
    expect(settingsProblems({ ...base, defaultGameMode }, 4)).toEqual([])
  for (const value of [3, 32])
    expect(settingsProblems({ ...base, viewDistance: value, simulationDistance: value }, 4)).toEqual([])
  for (const spawnProtection of [0, 64]) expect(settingsProblems({ ...base, spawnProtection }, 4)).toEqual([])
  for (const maxPlayers of [1, 4]) expect(settingsProblems({ ...base, maxPlayers }, 4)).toEqual([])
  expect(
    settingsProblems({ ...base, difficulty: 'invalid', defaultGameMode: 'invalid' } as never, 4),
  ).toEqual(['Pick a difficulty.', 'Pick a game mode.'])
  for (const maxPlayers of [0, -1, 1.5, Number.NaN])
    expect(settingsProblems({ ...base, maxPlayers }, 4)).toEqual([
      'This size holds up to 4 players. Pick a bigger size for more.',
    ])
  expect(
    settingsProblems({ ...base, viewDistance: 3.5, simulationDistance: 2, spawnProtection: 65 }, 4),
  ).toEqual([
    'View distance goes from 3 to 32 chunks.',
    'Simulation distance goes from 3 to 32 chunks.',
    'Spawn protection goes from 0 to 64 blocks.',
  ])
})

test('pack labels, uploaded identities and datapacks retain their world meaning', () => {
  const base = draft()
  const pack = { catalog: 'modrinth', versionId: 'pack-v1', name: 'Moss Pack', versionLabel: '1.2' }
  const packed: ChangeFacts = { ...base, modpack: pack }
  expect(describeChanges(base, packed)).toEqual([{ field: 'modpack', from: null, to: 'Moss Pack 1.2' }])
  expect(describeChanges(packed, base)).toEqual([{ field: 'modpack', from: 'Moss Pack 1.2', to: null }])
  expect(
    describeChanges(packed, { ...packed, modpack: { ...pack, versionId: 'pack-v2', versionLabel: '2.0' } }),
  ).toEqual([{ field: 'modpack', from: 'Moss Pack 1.2', to: 'Moss Pack 2.0' }])
  const uploaded = {
    ...mod('x', 'Uploaded Moss', 'old'),
    source: { catalog: 'upload' as const, uploadId: 'mine' },
  }
  expect(
    describeChanges(
      draft({ mods: [uploaded] }),
      draft({ mods: [{ ...uploaded, artifact: { ...uploaded.artifact, sha512: 'new' } }] }),
    ),
  ).toEqual([{ field: 'mods', added: [], removed: [], changed: ['Uploaded Moss'] }])
  expect(isPlain({ loader: 'vanilla' })).toBe(true)
  expect(isPlain({ loader: 'vanilla', mods: [{ loaders: ['datapack'] }] })).toBe(true)
  expect(isPlain({ loader: 'vanilla', modpack: {} })).toBe(false)
  expect(isPlain({ loader: 'vanilla', mods: [{ loaders: ['fabric'] }] })).toBe(false)
  expect(runsOnPaper({ loader: 'vanilla', loaderVersion: '132', mods: [{ loaders: ['datapack'] }] })).toBe(
    true,
  )
})
