/**
 * Datapacks and the void, as a container: the spec of a revision with datapacks, the step that puts
 * them into the world it opens, run by a real shell against a volume in a temporary directory, and
 * the settings a void world is made with. Which pins are datapacks is the resolver's and
 * `installsAsDatapack`'s.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { DATAPACKS_STEP, datapackName } from '../../minecraft/datapacks.ts'
import { installCheck } from '../../minecraft/install-check.ts'
import { toRuntimeSpec, withoutFilesStep } from '../../minecraft/runtime-spec.ts'
import { levelTypeEnv, VOID_LEVEL } from '../../minecraft/worlds.ts'

const sha512 = (bytes: string) => createHash('sha512').update(bytes).digest('hex')

function pin(name: string, loaders: string[], bytes = name): PinnedMod {
  return {
    source: { catalog: 'modrinth', projectId: name, versionId: `${name}-1` },
    name,
    versionLabel: '1',
    artifact: {
      ref: { kind: 'remote', url: `https://cdn.test/${name}` },
      sha512: sha512(bytes),
      sizeBytes: bytes.length,
      fileName: loaders.includes('datapack') ? `${name} v1.zip` : `${name}.jar`,
    },
    environment: 'server',
    loaders,
    gameVersions: ['26.2'],
    origin: 'user',
    requiredBy: [],
  }
}

const manhunt = pin('Manhunt', ['datapack'])
const lithium = pin('Lithium', ['fabric'])

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
    generatedOnVersion: '26.2',
  },
  memoryTier: '3g' as const,
  rconPassword: 'secret',
  artifactUrl: (artifact: { fileName: string }) =>
    `https://control.test/a/${encodeURIComponent(artifact.fileName)}`,
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
}
const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '26.2',
  loader: 'vanilla',
  loaderVersion: '40',
  settings: {
    difficulty: 'normal',
    defaultGameMode: 'survival',
    pvp: true,
    viewDistance: 10,
    simulationDistance: 10,
    maxPlayers: 10,
    motd: 'Game night',
    spawnProtection: 0,
    onlineMode: true,
  },
  mods: [],
  files: [],
  modpack: null,
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
}

describe('datapacks in a revision', () => {
  test('each has a name unique to its bytes that Minecraft reads as a zip', () => {
    expect(datapackName(manhunt.artifact)).toBe(`${manhunt.artifact.sha512.slice(0, 12)}-Manhunt_v1.zip`)
    const jar = { ...manhunt.artifact, fileName: 'counter.jar' }
    expect(datapackName(jar)).toEndWith('-counter.jar.zip')
  })

  test('plain Minecraft with a datapack stays plain, on Paper, and lists it for its world', () => {
    const spec = toRuntimeSpec({ ...input, revision: { ...revision, mods: [manhunt] } })
    expect(spec.env.TYPE).toBe('PAPER')
    expect(spec.env.PAPER_BUILD).toBe('40')
    expect(spec.env.MODS).toBeUndefined()
    expect(spec.env.PLUGINS).toBeUndefined()
    expect(spec.env.BLOCKLY_DATAPACKS).toBe(
      `${manhunt.artifact.sha512} ${datapackName(manhunt.artifact)} https://control.test/a/Manhunt%20v1.zip`,
    )
    // Data, not classes: the heap stays plain Minecraft's.
    expect(spec.env.MEMORY).toBe(toRuntimeSpec({ ...input, revision }).env.MEMORY)
  })

  test('a mod server installs its jars as jars and its datapacks into the world', () => {
    const fabric = {
      ...revision,
      loader: 'fabric' as const,
      loaderVersion: '0.17.2',
      mods: [lithium, manhunt],
    }
    const spec = toRuntimeSpec({ ...input, revision: fabric })
    expect(spec.env.MODS).toBe('https://control.test/a/Lithium.jar')
    expect(spec.env.BLOCKLY_DATAPACKS?.split('\n')).toHaveLength(1)
    // The jar check after a start hashes the jars; the step checked the datapacks before it.
    expect(installCheck(fabric)?.expected.map((jar) => jar.mod)).toEqual(['Lithium'])
    expect(installCheck({ ...revision, mods: [manhunt] })).toBeNull()
  })

  test('every server runs the step, which drift leaves out: a running server never restarts for it', () => {
    const plain = toRuntimeSpec({ ...input, revision })
    expect(plain.entrypoint?.[2]).toContain(DATAPACKS_STEP)
    expect(plain.env.BLOCKLY_DATAPACKS).toBeUndefined()
    expect(withoutFilesStep(plain.entrypoint)).toBeUndefined()
    const icon = toRuntimeSpec({ ...input, revision, iconUrl: 'http://control.test/grass.png' })
    expect(withoutFilesStep(icon.entrypoint)?.[2]).toStartWith('if [ -n "$ICON" ]')
  })
})

describe('the void', () => {
  test("is vanilla's superflat preset The Void: air over the void biome, with its start platform", () => {
    expect(levelTypeEnv('minecraft:amplified')).toEqual({ LEVEL_TYPE: 'minecraft:amplified' })
    const env = levelTypeEnv(VOID_LEVEL)
    expect(env.LEVEL_TYPE).toBe('minecraft:flat')
    expect(JSON.parse(env.GENERATOR_SETTINGS ?? '{}')).toEqual({
      biome: 'minecraft:the_void',
      features: true,
      lakes: false,
      layers: [{ block: 'minecraft:air', height: 1 }],
      structure_overrides: [],
    })
    const spec = toRuntimeSpec({ ...input, revision, world: { ...input.world, levelType: VOID_LEVEL } })
    expect(spec.env.LEVEL_TYPE).toBe('minecraft:flat')
    expect(spec.env.GENERATOR_SETTINGS).toBe(env.GENERATOR_SETTINGS)
  })
})

describe('the datapacks step', () => {
  const files: Record<string, string> = { '/manhunt': 'manhunt bytes', '/counter': 'counter bytes' }
  let fetched: string[] = []
  let server: ReturnType<typeof Bun.serve>
  let volume = ''

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        fetched.push(path)
        const body = files[path]
        return body === undefined ? new Response('gone', { status: 404 }) : new Response(body)
      },
    })
    volume = await mkdtemp(join(tmpdir(), 'blockly-datapacks-'))
  })
  afterAll(async () => {
    server.stop(true)
    await rm(volume, { recursive: true, force: true })
  })

  const line = (path: string, name: string, bytes = files[path] ?? '') =>
    `${sha512(bytes)} ${name} http://127.0.0.1:${server.port}${path}`
  // Run apart from the test, which serves the downloads meanwhile.
  const run = async (level: string, lines: string[]) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', LEVEL: level }
    if (lines.length > 0) env.BLOCKLY_DATAPACKS = lines.join('\n')
    const script = DATAPACKS_STEP.replaceAll('"/data/', `"${volume}/`)
    const step = Bun.spawn(['sh', '-c', script], { env, stderr: 'pipe' })
    return { exitCode: await step.exited, stderr: await new Response(step.stderr).text() }
  }
  const packs = (level: string) => readdir(join(volume, level, 'datapacks')).catch(() => [])

  test('installs what is listed, checks it, and leaves the owner’s own datapacks alone', async () => {
    // Nothing listed, nothing put there before: nothing to do.
    expect((await run('world', [])).exitCode).toBe(0)
    expect(await packs('world')).toEqual([])

    await Bun.write(join(volume, 'world', 'datapacks', 'castle-loot.zip'), 'the owner’s own')
    const both = [line('/manhunt', 'aa-manhunt.zip'), line('/counter', 'bb-counter.zip')]
    expect((await run('world', both)).exitCode).toBe(0)
    expect((await packs('world')).sort()).toEqual(['aa-manhunt.zip', 'bb-counter.zip', 'castle-loot.zip'])
    expect(await readFile(join(volume, 'world', 'datapacks', 'aa-manhunt.zip'), 'utf8')).toBe('manhunt bytes')
    expect(await readFile(join(volume, 'world', '.blockly-datapacks'), 'utf8')).toBe(
      'aa-manhunt.zip\nbb-counter.zip\n',
    )

    // A file already as pinned is never fetched again; one that changed on disk is.
    fetched = []
    await writeFile(join(volume, 'world', 'datapacks', 'bb-counter.zip'), 'cut short')
    expect((await run('world', both)).exitCode).toBe(0)
    expect(fetched).toEqual(['/counter'])
    expect(await readFile(join(volume, 'world', 'datapacks', 'bb-counter.zip'), 'utf8')).toBe('counter bytes')

    // One taken off the list goes; only what Blockly put there is ever removed.
    expect((await run('world', [both[0] ?? ''])).exitCode).toBe(0)
    expect((await packs('world')).sort()).toEqual(['aa-manhunt.zip', 'castle-loot.zip'])
  })

  test('a download that isn’t the pinned bytes stops the start and leaves nothing behind', async () => {
    const wrong = line('/counter', 'cc-counter.zip', 'other bytes')
    const result = await run('world', [line('/manhunt', 'aa-manhunt.zip'), wrong])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('The datapack cc-counter.zip did not download as chosen.')
    expect((await packs('world')).sort()).toEqual(['aa-manhunt.zip', 'castle-loot.zip'])
    // Its record is still the last start's, so the next start knows what it put there.
    expect(await readFile(join(volume, 'world', '.blockly-datapacks'), 'utf8')).toBe('aa-manhunt.zip\n')
    expect((await run('world', [line('/missing', 'dd-missing.zip', 'x')])).exitCode).not.toBe(0)
  })

  test('a world switched to gets them at its first start; one switched back to follows the list', async () => {
    const listed = [line('/manhunt', 'aa-manhunt.zip')]
    expect((await run('world-2', listed)).exitCode).toBe(0)
    expect(await packs('world-2')).toEqual(['aa-manhunt.zip'])
    // The datapacks were removed from the server while world-2 played: the first world loses its
    // copy when it runs again, and keeps the owner's own.
    expect((await run('world', [])).exitCode).toBe(0)
    expect(await packs('world')).toEqual(['castle-loot.zip'])
    expect(await packs('world-2')).toEqual(['aa-manhunt.zip'])
  })
})
