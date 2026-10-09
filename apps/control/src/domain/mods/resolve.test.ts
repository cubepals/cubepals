import { describe, expect, test } from 'bun:test'
import { isDatapack, type PinnedMod } from './artifact.ts'
import type { CatalogDependency, CatalogProject, CatalogVersion } from './catalog.ts'
import { type CatalogData, type ResolveRequest, resolve } from './resolve.ts'

const project = (
  projectId: string,
  name: string,
  state: CatalogProject['state'] = 'approved',
): CatalogProject => ({
  projectId,
  slug: projectId,
  name,
  summary: '',
  iconUrl: null,
  environments: [],
  downloads: 0,
  state,
})

function version(
  projectId: string,
  versionId: string,
  options: Partial<Pick<CatalogVersion, 'gameVersions' | 'loaders' | 'channel' | 'state' | 'environment'>> & {
    requires?: string[]
    dependencies?: CatalogDependency[]
  } = {},
): CatalogVersion {
  return {
    versionId,
    projectId,
    versionLabel: versionId,
    channel: options.channel ?? 'release',
    state: options.state ?? 'listed',
    environment: options.environment ?? 'server_only',
    loaders: options.loaders ?? ['fabric'],
    gameVersions: options.gameVersions ?? ['26.3'],
    publishedAt: new Date('2026-09-01'),
    file: {
      url: `https://cdn.example/${projectId}/${versionId}.jar`,
      sha512: `${versionId}`.padEnd(128, '0'),
      sizeBytes: 100,
      fileName: `${projectId}-${versionId}.jar`,
    },
    dependencies: [
      ...(options.requires ?? []).map((id) => ({
        projectId: id,
        versionId: null,
        kind: 'required' as const,
      })),
      ...(options.dependencies ?? []),
    ],
  }
}

/** A catalog that knows these projects and versions; versions listed newest first. */
function catalog(projects: CatalogProject[], versions: CatalogVersion[]): CatalogData {
  return {
    projects: new Map(projects.map((p) => [p.projectId, p])),
    fitting: new Map(projects.map((p) => [p.projectId, versions.filter((v) => v.projectId === p.projectId)])),
    versions: new Map(versions.map((v) => [v.versionId, v])),
  }
}

const request = (patch: Partial<ResolveRequest> = {}): ResolveRequest => ({
  catalog: 'modrinth',
  target: { gameVersion: '26.3', loaders: ['fabric'] },
  wanted: [],
  current: [],
  upgrade: new Set(),
  environment: (declared) =>
    declared === 'client_only' ? null : declared === 'client_and_server' ? 'both' : 'server',
  ...patch,
})

const resolved = (result: ReturnType<typeof resolve>) => {
  if (result.kind !== 'resolved') throw new Error(`Expected mods, got ${JSON.stringify(result)}`)
  return result.mods
}
const summary = (mods: PinnedMod[]) =>
  mods.map((m) => [m.name, 'versionId' in m.source ? m.source.versionId : 'upload', m.origin, m.requiredBy])

const sodium = project('sodium', 'Sodium')
const lithium = project('lithium', 'Lithium')
const fabricApi = project('fabric-api', 'Fabric API')
const cloth = project('cloth', 'Cloth Config')

describe('resolve', () => {
  test('the newest fitting release, with what it requires; optional and embedded ones stay out', () => {
    const data = catalog(
      [sodium, fabricApi, cloth],
      [
        version('sodium', 's2', {
          requires: ['fabric-api'],
          dependencies: [
            { projectId: 'cloth', versionId: null, kind: 'optional' },
            { projectId: 'cloth', versionId: null, kind: 'embedded' },
          ],
        }),
        version('sodium', 's1'),
        version('fabric-api', 'f1'),
        version('cloth', 'c1'),
      ],
    )
    expect(summary(resolved(resolve(request({ wanted: [{ projectId: 'sodium' }] }), data)))).toEqual([
      ['Fabric API', 'f1', 'dependency', ['Sodium']],
      ['Sodium', 's2', 'user', []],
    ])
  })

  test('asks for what it has not seen, round after round, then resolves', () => {
    const everything = catalog(
      [sodium, fabricApi],
      [version('sodium', 's1', { requires: ['fabric-api'] }), version('fabric-api', 'f1')],
    )
    const seen: CatalogData = { projects: new Map(), fitting: new Map(), versions: new Map() }
    const wanted = request({ wanted: [{ projectId: 'sodium' }] })
    expect(resolve(wanted, seen)).toEqual({ kind: 'need', projects: ['sodium'], versions: [] })
    const round2: CatalogData = {
      projects: new Map([['sodium', sodium]]),
      fitting: new Map([['sodium', everything.fitting.get('sodium') ?? []]]),
      versions: new Map(),
    }
    expect(resolve(wanted, round2)).toEqual({ kind: 'need', projects: ['fabric-api'], versions: [] })
    expect(resolved(resolve(wanted, everything))).toHaveLength(2)
  })

  test('a dependency named only by version is looked up by version', () => {
    const data = catalog(
      [sodium, fabricApi],
      [
        version('sodium', 's1', { dependencies: [{ projectId: null, versionId: 'f1', kind: 'required' }] }),
        version('fabric-api', 'f2'),
        version('fabric-api', 'f1'),
      ],
    )
    const asked = resolve(request({ wanted: [{ projectId: 'sodium' }] }), {
      ...data,
      versions: new Map([['s1', data.versions.get('s1') ?? null]]),
    })
    expect(asked).toEqual({ kind: 'need', projects: [], versions: ['f1'] })
    // The named version is preferred while it fits.
    expect(summary(resolved(resolve(request({ wanted: [{ projectId: 'sodium' }] }), data)))[0]?.[1]).toBe(
      'f1',
    )
  })

  test('a release over a newer beta; a beta when there is nothing else', () => {
    const data = catalog(
      [sodium, lithium],
      [
        version('sodium', 's3-beta', { channel: 'beta' }),
        version('sodium', 's2'),
        version('lithium', 'l2-alpha', { channel: 'alpha' }),
        version('lithium', 'l1-beta', { channel: 'beta' }),
      ],
    )
    const mods = resolved(
      resolve(request({ wanted: [{ projectId: 'sodium' }, { projectId: 'lithium' }] }), data),
    )
    expect(summary(mods).map((m) => m[1])).toEqual(['l1-beta', 's2'])
  })

  test('adding a mod keeps the versions already pinned; an upgrade moves them', () => {
    const before = resolved(
      resolve(
        request({ wanted: [{ projectId: 'sodium' }] }),
        catalog(
          [sodium, fabricApi],
          [version('sodium', 's1', { requires: ['fabric-api'] }), version('fabric-api', 'f1')],
        ),
      ),
    )
    const newer = catalog(
      [sodium, fabricApi, lithium],
      [
        version('sodium', 's2', { requires: ['fabric-api'] }),
        version('sodium', 's1', { requires: ['fabric-api'] }),
        version('fabric-api', 'f2'),
        version('fabric-api', 'f1'),
        version('lithium', 'l1'),
      ],
    )
    const added = resolved(
      resolve(
        request({ wanted: [{ projectId: 'sodium' }, { projectId: 'lithium' }], current: before }),
        newer,
      ),
    )
    expect(summary(added).map((m) => m[1])).toEqual(['f1', 'l1', 's1'])
    // Kept pins keep the facts they were pinned with.
    expect(added.find((m) => m.name === 'Sodium')).toEqual(
      before.find((m) => m.name === 'Sodium') as PinnedMod,
    )

    const upgraded = resolved(
      resolve(request({ wanted: [{ projectId: 'sodium' }], current: before, upgrade: 'all' }), newer),
    )
    expect(summary(upgraded).map((m) => m[1])).toEqual(['f2', 's2'])
  })

  test('removing a mod drops what only it required', () => {
    const data = catalog(
      [sodium, lithium, fabricApi, cloth],
      [
        version('sodium', 's1', { requires: ['fabric-api', 'cloth'] }),
        version('lithium', 'l1', { requires: ['fabric-api'] }),
        version('fabric-api', 'f1'),
        version('cloth', 'c1'),
      ],
    )
    const both = resolved(
      resolve(request({ wanted: [{ projectId: 'sodium' }, { projectId: 'lithium' }] }), data),
    )
    expect(summary(both).find((m) => m[0] === 'Fabric API')?.[3]).toEqual(['Lithium', 'Sodium'])
    const without = resolved(resolve(request({ wanted: [{ projectId: 'lithium' }], current: both }), data))
    expect(summary(without)).toEqual([
      ['Fabric API', 'f1', 'dependency', ['Lithium']],
      ['Lithium', 'l1', 'user', []],
    ])
  })

  test('a new game version re-resolves every mod, or names each that cannot follow and changes nothing', () => {
    const data = catalog(
      [sodium, lithium, fabricApi],
      [
        version('sodium', 's-26.3', { requires: ['fabric-api'] }),
        version('sodium', 's-26.2', { gameVersions: ['26.2'], requires: ['fabric-api'] }),
        version('lithium', 'l-26.2', { gameVersions: ['26.2'] }),
        version('fabric-api', 'f-26.3'),
        version('fabric-api', 'f-26.2', { gameVersions: ['26.2'] }),
      ],
    )
    const on262 = resolved(
      resolve(
        request({ target: { gameVersion: '26.2', loaders: ['fabric'] }, wanted: [{ projectId: 'sodium' }] }),
        data,
      ),
    )
    expect(summary(on262).map((m) => m[1])).toEqual(['f-26.2', 's-26.2'])
    expect(
      summary(resolved(resolve(request({ wanted: [{ projectId: 'sodium' }], current: on262 }), data))),
    ).toEqual([
      ['Fabric API', 'f-26.3', 'dependency', ['Sodium']],
      ['Sodium', 's-26.3', 'user', []],
    ])
    expect(
      resolve(request({ wanted: [{ projectId: 'sodium' }, { projectId: 'lithium' }], current: on262 }), data),
    ).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'no_fitting_version', mod: 'Lithium', projectId: 'lithium' }],
    })
  })

  test('client-only mods are refused, including as a requirement', () => {
    const zoom = project('zoom', 'Zoomify')
    const data = catalog(
      [zoom, sodium],
      [
        version('zoom', 'z1', { environment: 'client_only' }),
        version('sodium', 's1', { requires: ['zoom'] }),
      ],
    )
    expect(resolve(request({ wanted: [{ projectId: 'zoom' }] }), data)).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'client_only', mod: 'Zoomify', projectId: 'zoom' }],
    })
    expect(resolve(request({ wanted: [{ projectId: 'sodium' }] }), data)).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'missing_dependency', mod: 'Sodium', projectId: 'sodium', dependency: 'Zoomify' }],
    })
  })

  test('taken-down projects and missing requirements are named', () => {
    const data = catalog(
      [project('bad', 'Bad Mod', 'withheld'), sodium],
      [version('bad', 'b1'), version('sodium', 's1', { requires: ['gone'] })],
    )
    const withGone: CatalogData = { ...data, projects: new Map([...data.projects, ['gone', null]]) }
    expect(resolve(request({ wanted: [{ projectId: 'bad' }, { projectId: 'sodium' }] }), withGone)).toEqual({
      kind: 'conflicts',
      conflicts: [
        { kind: 'unavailable', mod: 'Bad Mod', projectId: 'bad' },
        { kind: 'missing_dependency', mod: 'Sodium', projectId: 'sodium', dependency: 'gone' },
      ],
    })
  })

  test('a pinned mod taken down stays, with what it required, until the owner removes it; nobody can add it anew', () => {
    const data = catalog(
      [sodium, fabricApi, lithium],
      [
        version('sodium', 's1', { requires: ['fabric-api'] }),
        version('fabric-api', 'f1'),
        version('lithium', 'l1'),
      ],
    )
    const before = resolved(resolve(request({ wanted: [{ projectId: 'sodium' }] }), data))
    const takenDown: CatalogData = {
      ...data,
      projects: new Map([
        ['sodium', { ...sodium, state: 'withheld' }],
        ['fabric-api', fabricApi],
        ['lithium', lithium],
      ]),
    }
    const kept = resolved(
      resolve(
        request({ wanted: [{ projectId: 'sodium' }, { projectId: 'lithium' }], current: before }),
        takenDown,
      ),
    )
    expect(summary(kept)).toEqual([
      ['Fabric API', 'f1', 'dependency', ['Sodium']],
      ['Lithium', 'l1', 'user', []],
      ['Sodium', 's1', 'user', []],
    ])
    expect(resolve(request({ wanted: [{ projectId: 'sodium' }] }), takenDown)).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'unavailable', mod: 'Sodium', projectId: 'sodium' }],
    })
  })

  test('mods that exclude each other conflict, by project or by exact version', () => {
    const data = catalog(
      [sodium, lithium, cloth],
      [
        version('sodium', 's1', {
          dependencies: [{ projectId: 'lithium', versionId: null, kind: 'incompatible' }],
        }),
        version('lithium', 'l1'),
        version('cloth', 'c1', {
          dependencies: [{ projectId: 'lithium', versionId: 'l0', kind: 'incompatible' }],
        }),
      ],
    )
    expect(resolve(request({ wanted: [{ projectId: 'sodium' }, { projectId: 'lithium' }] }), data)).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'incompatible', mod: 'Sodium', projectId: 'sodium', with: 'Lithium' }],
    })
    // Only another version of Lithium was excluded.
    expect(
      resolved(resolve(request({ wanted: [{ projectId: 'cloth' }, { projectId: 'lithium' }] }), data)),
    ).toHaveLength(2)
  })

  test("an owner's exact version must fit", () => {
    const data = catalog(
      [sodium],
      [version('sodium', 's2'), version('sodium', 's-old', { gameVersions: ['26.1'] })],
    )
    expect(
      summary(
        resolved(resolve(request({ wanted: [{ projectId: 'sodium', versionId: 's2' }] }), data)),
      )[0]?.[1],
    ).toBe('s2')
    expect(resolve(request({ wanted: [{ projectId: 'sodium', versionId: 's-old' }] }), data)).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'no_fitting_version', mod: 'Sodium', projectId: 'sodium' }],
    })
  })

  test('uploads come along as they are, unless they declare another game version', () => {
    const upload: PinnedMod = {
      source: { catalog: 'upload', uploadId: 'u1' },
      name: 'My Mod',
      versionLabel: '1.0',
      artifact: {
        ref: { kind: 'stored', key: 'uploads/x' },
        sha512: 'x'.repeat(128),
        sizeBytes: 1,
        fileName: 'my.jar',
      },
      environment: 'server',
      loaders: ['fabric'],
      gameVersions: ['26.3'],
      origin: 'user',
      requiredBy: [],
    }
    const data = catalog(
      [sodium],
      [version('sodium', 's1'), version('sodium', 's-26.2', { gameVersions: ['26.2'] })],
    )
    expect(
      summary(resolved(resolve(request({ wanted: [{ projectId: 'sodium' }], current: [upload] }), data))),
    ).toEqual([
      ['My Mod', 'upload', 'user', []],
      ['Sodium', 's1', 'user', []],
    ])
    expect(
      resolve(
        request({
          target: { gameVersion: '26.2', loaders: ['fabric'] },
          wanted: [{ projectId: 'sodium' }],
          current: [upload],
        }),
        data,
      ),
    ).toEqual({ kind: 'conflicts', conflicts: [{ kind: 'upload_does_not_fit', mod: 'My Mod' }] })
  })

  test('Quilt servers take Fabric builds when that is what fits', () => {
    const data = catalog([sodium], [version('sodium', 's1', { loaders: ['fabric'] })])
    const quilt = request({
      target: { gameVersion: '26.3', loaders: ['quilt', 'fabric'] },
      wanted: [{ projectId: 'sodium' }],
    })
    expect(resolved(resolve(quilt, data))).toHaveLength(1)
  })
})

describe('datapacks', () => {
  test('datapacks resolve by game version like mods, and say what they are by their loaders', () => {
    const manhunt = project('manhunt', 'Manhunt')
    const data = catalog(
      [manhunt],
      [
        version('manhunt', 'm2', { loaders: ['datapack'], gameVersions: ['26.4'] }),
        version('manhunt', 'm1', { loaders: ['datapack'], environment: 'unknown' }),
      ],
    )
    const seen: Array<readonly string[]> = []
    const plain = request({
      target: { gameVersion: '26.3', loaders: ['datapack'] },
      wanted: [{ projectId: 'manhunt' }],
      environment: (_declared, loaders) => {
        seen.push(loaders)
        return 'server'
      },
    })
    const [pin] = resolved(resolve(plain, data))
    expect(summary(pin === undefined ? [] : [pin])).toEqual([['Manhunt', 'm1', 'user', []]])
    expect(pin?.environment).toBe('server')
    expect(seen).toEqual([['datapack']])
    expect(pin !== undefined && isDatapack(pin)).toBe(true)
    // A mod server takes it too, and it still goes into the world.
    const fabric = request({
      target: { gameVersion: '26.3', loaders: ['fabric', 'datapack'] },
      wanted: [{ projectId: 'manhunt' }],
    })
    expect(resolved(resolve(fabric, data)).map((m) => isDatapack(m, ['fabric']))).toEqual([true])
    // A mod made for a loader is no datapack, and plain Minecraft has nothing to run it.
    expect(
      resolve({ ...plain, wanted: [{ projectId: 'sodium' }] }, catalog([sodium], [version('sodium', 's1')])),
    ).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'no_fitting_version', mod: 'Sodium', projectId: 'sodium' }],
    })
  })

  test('a version published as both a mod and a datapack is the mod where the server loads it', () => {
    const both = { loaders: ['datapack', 'fabric'] }
    expect(isDatapack(both, ['fabric'])).toBe(false)
    expect(isDatapack(both, ['paper', 'spigot', 'bukkit'])).toBe(true)
    expect(isDatapack(both)).toBe(true)
    expect(isDatapack({ loaders: ['fabric'] })).toBe(false)
  })
})

describe('versions Cubepals tested', () => {
  const paper = { gameVersion: '26.2', loaders: ['paper', 'spigot'] }
  const bskyblock = project('bskyblock', 'BSkyBlock')
  const listsTo = (versionId: string, gameVersions: string[], publishedAt: string) => ({
    ...version('bskyblock', versionId, { loaders: ['paper'], gameVersions }),
    publishedAt: new Date(publishedAt),
  })
  // As the catalog answers: only what it lists for the target is fitting.
  const listed = (versions: CatalogVersion[]): CatalogData => ({
    projects: new Map([['bskyblock', bskyblock]]),
    fitting: new Map([['bskyblock', versions.filter((v) => v.gameVersions.includes('26.2'))]]),
    versions: new Map(versions.map((v) => [v.versionId, v])),
  })
  const wanted = { target: paper, wanted: [{ projectId: 'bskyblock' }] }

  test('a tested version fits its target where nothing the catalog lists does', () => {
    const data = listed([listsTo('b1', ['26.1.1'], '2026-04-01')])
    expect(resolve(request(wanted), data)).toEqual({
      kind: 'conflicts',
      conflicts: [{ kind: 'no_fitting_version', mod: 'BSkyBlock', projectId: 'bskyblock' }],
    })
    const tested = request({ ...wanted, tested: [{ projectId: 'bskyblock', versionId: 'b1' }] })
    // Asked for by id when the catalog hasn't shown it yet.
    expect(resolve(tested, { ...data, versions: new Map() })).toEqual({
      kind: 'need',
      projects: [],
      versions: ['b1'],
    })
    expect(summary(resolved(resolve(tested, data)))).toEqual([['BSkyBlock', 'b1', 'user', []]])
  })

  test('it covers that exact version: a newer release of the project is not covered', () => {
    const data = listed([listsTo('b2', ['26.1.1'], '2026-09-01'), listsTo('b1', ['26.1.1'], '2026-04-01')])
    const tested = request({ ...wanted, tested: [{ projectId: 'bskyblock', versionId: 'b1' }] })
    expect(summary(resolved(resolve(tested, data)))).toEqual([['BSkyBlock', 'b1', 'user', []]])
    // Nor is an owner's exact choice of the untested one.
    expect(resolve({ ...tested, wanted: [{ projectId: 'bskyblock', versionId: 'b2' }] }, data)).toMatchObject(
      { kind: 'conflicts' },
    )
  })

  test('a version the catalog lists for the target still wins, as before', () => {
    const data = listed([listsTo('b2', ['26.2'], '2026-09-01'), listsTo('b1', ['26.1.1'], '2026-04-01')])
    const tested = request({ ...wanted, tested: [{ projectId: 'bskyblock', versionId: 'b1' }] })
    expect(summary(resolved(resolve(tested, data)))).toEqual([['BSkyBlock', 'b2', 'user', []]])
    expect(resolve(tested, data)).toEqual(resolve(request(wanted), data))
  })
})

describe('resolve across catalogs', () => {
  test('pins each plugin to the catalog its id names, Modrinth and Hangar in one set', () => {
    const paper = { gameVersion: '26.2', loaders: ['paper', 'spigot', 'bukkit'] }
    const lifesteal = project('l8Uv7FzS', 'LifeStealZ')
    const ocm = project('hangar:2087', 'OldCombatMechanics')
    const data = catalog(
      [lifesteal, ocm],
      [
        version('l8Uv7FzS', 'LS1', { loaders: ['paper'], gameVersions: ['26.2'] }),
        version('hangar:2087', 'hangar:31271', { loaders: ['paper'], gameVersions: ['26.2'] }),
      ],
    )
    const mods = resolved(
      resolve(
        request({ target: paper, wanted: [{ projectId: 'l8Uv7FzS' }, { projectId: 'hangar:2087' }] }),
        data,
      ),
    )
    expect(mods.map((m) => m.source)).toEqual([
      { catalog: 'modrinth', projectId: 'l8Uv7FzS', versionId: 'LS1' },
      { catalog: 'hangar', projectId: 'hangar:2087', versionId: 'hangar:31271' },
    ])
  })
})
