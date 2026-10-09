/**
 * Plain Minecraft on Paper, as a container: the spec of a plain revision with a Paper build, the
 * step that starts a Paper jar already installed with no call to Paper's API, and the one that
 * gives any other server type back the Nether and End a Paper one kept beside the world. Drift
 * sees neither step. Whether a revision runs on Paper is `runsOnPaper`'s.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { installOf, toRuntimeSpec, withoutFilesStep } from '../../minecraft/runtime-spec.ts'

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
    generatedOnVersion: '1.21.11',
  },
  memoryTier: '3g' as const,
  rconPassword: 'secret',
  artifactUrl: () => 'https://example.test/a.jar',
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
}
const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '1.21.11',
  loader: 'vanilla',
  loaderVersion: null,
  settings: defaultSettings({ name: 'Sunset Valley', gameMode: 'survival', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
}

describe('plain Minecraft on Paper', () => {
  test('plain Minecraft with a Paper build runs on Paper, and seeds no install of Mojang’s', () => {
    const onPaper = { ...revision, gameVersion: '1.21.11', loaderVersion: '132' }
    const spec = toRuntimeSpec({ ...input, revision: onPaper })
    expect(spec.env.TYPE).toBe('PAPER')
    expect(spec.env.PAPER_BUILD).toBe('132')
    expect(spec.env.PLUGINS).toBeUndefined()
    // Paper keeps the world as it lays it out: nothing is moved for it.
    expect(spec.entrypoint?.[2]).not.toContain('DIM-1')
    expect(installOf(onPaper)).toBeNull()
    expect(spec.storage.reconstructible).toBeUndefined()
    const mojang = { ...onPaper, loaderVersion: null }
    expect(toRuntimeSpec({ ...input, revision: mojang }).env.TYPE).toBe('VANILLA')
    expect(toRuntimeSpec({ ...input, revision: mojang }).env.PAPER_BUILD).toBeUndefined()
    expect(installOf(mojang)).not.toBeNull()
  })

  test('a server not on Paper first moves back the Nether and End a Paper one kept beside the world', () => {
    const script = toRuntimeSpec({ ...input, revision }).entrypoint?.[2] ?? ''
    const data = mkdtempSync(join(tmpdir(), 'dimensions-'))
    const put = (path: string, text: string) => {
      mkdirSync(dirname(`${data}/${path}`), { recursive: true })
      writeFileSync(`${data}/${path}`, text)
    }
    put('world/level.dat', 'level')
    put('world_nether/DIM-1/region/r.0.0.mca', 'paper nether')
    put('world_the_end/DIM1/region/r.0.0.mca', 'paper end')
    // An End the world already has of its own stays, and Paper's copy is left where it is.
    put('world/DIM1/region/r.0.0.mca', 'own end')
    const step = script.replaceAll('/data', data).replace('exec /image/scripts/start "$@"', 'true')
    const run = () => Bun.spawnSync(['/bin/sh', '-c', step], { env: { LEVEL: 'world' } }).exitCode
    expect(run()).toBe(0)
    expect(readFileSync(`${data}/world/DIM-1/region/r.0.0.mca`, 'utf8')).toBe('paper nether')
    expect(existsSync(`${data}/world_nether/DIM-1`)).toBe(false)
    expect(readFileSync(`${data}/world/DIM1/region/r.0.0.mca`, 'utf8')).toBe('own end')
    expect(existsSync(`${data}/world_the_end/DIM1/region/r.0.0.mca`)).toBe(true)
    // Again, and on a world Paper never ran, it does nothing.
    expect(run()).toBe(0)
    expect(readFileSync(`${data}/world/DIM-1/region/r.0.0.mca`, 'utf8')).toBe('paper nether')
    rmSync(data, { recursive: true })
  })

  test('a Paper server whose pinned jar the image installed starts it with no call to Paper’s API', () => {
    const onPaper = { ...revision, loaderVersion: '132' }
    const script = toRuntimeSpec({ ...input, revision: onPaper }).entrypoint?.[2] ?? ''
    const data = mkdtempSync(join(tmpdir(), 'paper-jar-'))
    const step = script
      .replaceAll('/data', data)
      .replace('exec /image/scripts/start "$@"', 'echo "$PAPER_CUSTOM_JAR"')
    const jar = () =>
      Bun.spawnSync(['/bin/sh', '-c', step], { env: { VERSION: '1.21.11', PAPER_BUILD: '132' } })
        .stdout.toString()
        .trim()
    // A first start: no jar yet, so the image installs it through the API.
    expect(jar()).toBe('')
    // A jar the image never finished installing, its results file naming none, is installed again.
    writeFileSync(`${data}/paper-1.21.11-132.jar`, 'jar')
    expect(jar()).toBe('')
    writeFileSync(`${data}/.paper.env`, `SERVER="${data}/paper-1.21.11-132.jar"\n`)
    expect(jar()).toBe(`${data}/paper-1.21.11-132.jar`)
    // Another build pinned is installed through the API.
    writeFileSync(`${data}/.paper.env`, `SERVER="${data}/paper-1.21.11-131.jar"\n`)
    expect(jar()).toBe('')
    rmSync(data, { recursive: true })
  })

  test('drift sees the entrypoint as it was before its first step', () => {
    const icon = 'http://control.test/grass.png'
    const withIcon = toRuntimeSpec({ ...input, revision, iconUrl: icon }).entrypoint
    const before = withoutFilesStep(withIcon)
    expect(before?.[2]).toStartWith('if [ -n "$ICON" ]')
    expect(before?.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(before?.[3]).toBe('start')
    // Paper's step goes the same way, leaving what Paper servers ran before.
    const paper = toRuntimeSpec({ ...input, revision: { ...revision, loader: 'paper' }, iconUrl: icon })
    expect(paper.entrypoint?.[2]).toContain('PAPER_CUSTOM_JAR')
    expect(withoutFilesStep(paper.entrypoint)?.[2]).toEqual(before?.[2])
    // With nothing after it, nothing is left: as a plain server without an icon started before.
    expect(withoutFilesStep(toRuntimeSpec({ ...input, revision }).entrypoint)).toBeUndefined()
    expect(
      withoutFilesStep(
        toRuntimeSpec({ ...input, revision: { ...revision, loaderVersion: '132' } }).entrypoint,
      ),
    ).toBeUndefined()
  })
})
