import { describe, expect, test } from 'bun:test'
import type { PinnedMod } from '../mods/artifact.ts'
import { playerCapacity } from '../server/size.ts'
import {
  defaultSettings,
  describeChanges,
  type RevisionDraft,
  rewritesWorld,
  runsOnPaper,
  settingsProblems,
  welcome,
} from './revision.ts'

const draft = (patch: Partial<RevisionDraft> = {}): RevisionDraft => ({
  acknowledgedRevoked: [],
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
    // One line of the server list holds 59 characters; a name that won't fit in quotes drops out.
    expect(welcome('x'.repeat(27))).toHaveLength(59)
    expect(welcome('x'.repeat(28))).toBe('A server created by Cubepals')
    expect(
      settingsProblems(defaultSettings({ name: 'x'.repeat(40), gameMode: 'survival', maxPlayers: 4 }), 4),
    ).toEqual([])
  })

  test('defaults are within bounds for the size they were made for', () => {
    expect(settingsProblems(draft().settings, playerCapacity('2g'))).toEqual([])
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
    expect(settingsProblems({ ...draft().settings, motd: 'x'.repeat(60) }, 4)).toHaveLength(1)
    expect(settingsProblems({ ...draft().settings, motd: 'two\nlines' }, 4)).toHaveLength(1)
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
