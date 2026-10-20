// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The steps Blockly runs as root on a server's volume stay inside it, whatever links code running on
 * the server (an owner's plugin, as the server's own user) leaves there: a link where a step writes
 * is replaced, and said so, and a record line the step never wrote is passed over. Each test stands
 * a folder in for `/data` and a sibling folder for the rest of the machine, and runs the real step
 * in a real shell.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { writeAccessFiles } from '../../minecraft/access.ts'
import { toRuntimeSpec } from '../../minecraft/runtime-spec.ts'

const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '26.1.2',
  loader: 'paper',
  loaderVersion: '40',
  settings: defaultSettings({ name: 'Island', gameMode: 'survival', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  files: [{ path: 'plugins/LifeStealZ/config.yml', content: 'startHearts: 7\n' }],
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
}

const input = {
  serverId: 's-1',
  revision,
  world: {
    id: 'w',
    serverId: 's-1',
    levelName: 'world',
    name: 'World',
    seed: null,
    levelType: 'minecraft:normal',
    hardcore: false,
    generatedOnVersion: '26.1.2',
  },
  memoryTier: '4g' as const,
  rconPassword: 'secret',
  artifactUrl: () => 'http://127.0.0.1:1/x.jar',
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
  compat: [],
}

let root = ''
afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

/** A volume and, beside it, a file standing in for one of the machine's own (`/etc/...`). */
function machine() {
  root = mkdtempSync(join(tmpdir(), 'volume-links-'))
  const data = join(root, 'data')
  const outside = join(root, 'etc')
  mkdirSync(data)
  mkdirSync(outside)
  writeFileSync(join(outside, 'passwd'), 'root:x:0:0\n')
  return { data, outside }
}

/** The start's script as far as the image's own start, on `data`; what it said, and how it ended. */
async function start(data: string, of = revision): Promise<{ exitCode: number; stderr: string }> {
  const spec = toRuntimeSpec({ ...input, revision: of })
  const step = (spec.entrypoint?.[2] ?? '')
    // `/data` itself: not the `/data` inside `/datapacks`, or a folder `data` under another path.
    .replace(/(?<![\w/])\/data(?![A-Za-z])/g, data)
    .replace('exec /image/scripts/start "$@"', 'true')
  const env = Object.fromEntries(Object.entries(spec.env).filter(([name]) => name.startsWith('BLOCKLY_')))
  const run = Bun.spawn(['/bin/sh', '-c', step], {
    env: { ...env, VERSION: '26.1.2', PAPER_BUILD: '40', LEVEL: 'world', USES_PROXY_PROTOCOL: 'TRUE' },
    stderr: 'pipe',
  })
  return { exitCode: await run.exited, stderr: await new Response(run.stderr).text() }
}

describe('root steps on the volume stay inside it', () => {
  test('a carried file whose path is a link replaces the link, and the log says so', async () => {
    const { data, outside } = machine()
    mkdirSync(join(data, 'plugins/LifeStealZ'), { recursive: true })
    symlinkSync(join(outside, 'passwd'), join(data, 'plugins/LifeStealZ/config.yml'))
    const { exitCode, stderr } = await start(data)
    expect(exitCode).toBe(0)
    // The machine's own file is untouched, and the carried file is in place of the link.
    expect(readFileSync(join(outside, 'passwd'), 'utf8')).toBe('root:x:0:0\n')
    expect(lstatSync(join(data, 'plugins/LifeStealZ/config.yml')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(data, 'plugins/LifeStealZ/config.yml'), 'utf8')).toBe('startHearts: 7\n')
    expect(stderr).toContain('Cubepals replaced a link at plugins/LifeStealZ/config.yml')
  })

  test('a folder on the way that is a link is replaced too', async () => {
    const { data, outside } = machine()
    mkdirSync(join(data, 'plugins'))
    symlinkSync(outside, join(data, 'plugins/LifeStealZ'))
    expect((await start(data)).exitCode).toBe(0)
    expect(existsSync(join(outside, 'config.yml'))).toBe(false)
    expect(readFileSync(join(data, 'plugins/LifeStealZ/config.yml'), 'utf8')).toBe('startHearts: 7\n')
  })

  test("a line of the step's own record that it never wrote removes nothing", async () => {
    const { data, outside } = machine()
    writeFileSync(join(data, '.blockly-files'), '../etc/passwd\n')
    await start(data)
    expect(existsSync(join(outside, 'passwd'))).toBe(true)
  })

  test("a world's datapack record, as an uploaded world can bring it, removes nothing outside the volume", async () => {
    const { data, outside } = machine()
    mkdirSync(join(data, 'world'))
    writeFileSync(join(data, 'world/.blockly-datapacks'), '../../../etc/passwd\n')
    await start(data)
    expect(existsSync(join(outside, 'passwd'))).toBe(true)
  })

  test("Paper's config folder as a link: the PROXY step writes its file inside the volume", async () => {
    const { data, outside } = machine()
    symlinkSync(outside, join(data, 'config'))
    expect((await start(data)).exitCode).toBe(0)
    expect(existsSync(join(outside, 'paper-global.yml'))).toBe(false)
    expect(readFileSync(join(data, 'config/paper-global.yml'), 'utf8')).toBe(
      'proxies:\n  proxy-protocol: true\n',
    )
  })

  test('the access files written over exec replace a link rather than follow it', async () => {
    const { data, outside } = machine()
    symlinkSync(join(outside, 'passwd'), join(data, 'whitelist.json'))
    const [sh, flag, script = '', ...rest] = writeAccessFiles({ 'whitelist.json': '[]' }, false)
    const exitCode = await Bun.spawn([sh ?? 'sh', flag ?? '-c', script.replaceAll('/data', data), ...rest], {
      stderr: 'ignore',
    }).exited
    expect(exitCode).toBe(0)
    expect(readFileSync(join(outside, 'passwd'), 'utf8')).toBe('root:x:0:0\n')
    expect(readFileSync(join(data, 'whitelist.json'), 'utf8')).toBe('[]')
  })
})

describe('a world Paper ran last, opened by another server type, stays inside the volume', () => {
  // Fabric reads the Nether, the End and the world's settings where Minecraft does.
  const fabric: ServerRevision = { ...revision, loader: 'fabric', loaderVersion: '0.17.2', files: [] }
  const overworld = 'world/dimensions/minecraft/overworld'

  /** A world as Paper leaves it: its overworld's own state and Paper's folder. */
  function paperWorld(data: string) {
    mkdirSync(join(data, overworld, 'data/minecraft'), { recursive: true })
    mkdirSync(join(data, overworld, 'data/paper'), { recursive: true })
    writeFileSync(join(data, overworld, 'data/minecraft/weather.dat'), 'weather')
  }

  test('a world folder that is a link: the Nether moves nowhere outside the volume', async () => {
    const { data, outside } = machine()
    mkdirSync(join(data, 'world_nether/DIM-1'), { recursive: true })
    symlinkSync(outside, join(data, 'world'))
    expect((await start(data, fabric)).exitCode).toBe(0)
    expect(existsSync(join(outside, 'DIM-1'))).toBe(false)
  })

  test("the world's settings go back into the world, not through a link out of it", async () => {
    const { data, outside } = machine()
    paperWorld(data)
    symlinkSync(outside, join(data, 'world/data'))
    const { exitCode, stderr } = await start(data, fabric)
    expect(exitCode).toBe(0)
    expect(existsSync(join(outside, 'minecraft'))).toBe(false)
    expect(readFileSync(join(data, 'world/data/minecraft/weather.dat'), 'utf8')).toBe('weather')
    expect(stderr).toContain('Cubepals replaced a link at world/data')
  })

  test("Paper's files are set aside inside the volume, whatever link stands where they go", async () => {
    const { data, outside } = machine()
    paperWorld(data)
    symlinkSync(outside, join(data, '.blockly-paper'))
    expect((await start(data, fabric)).exitCode).toBe(0)
    expect(existsSync(join(outside, 'world'))).toBe(false)
    expect(existsSync(join(data, '.blockly-paper/world/dimensions/minecraft/overworld/data/paper'))).toBe(
      true,
    )
  })

  test('a dimension that is a link: nothing outside the volume is moved or removed', async () => {
    const { data, outside } = machine()
    paperWorld(data)
    mkdirSync(join(outside, 'data/minecraft'), { recursive: true })
    mkdirSync(join(outside, 'data/paper'), { recursive: true })
    writeFileSync(join(outside, 'data/minecraft/world_clocks.dat'), 'theirs')
    symlinkSync(outside, join(data, 'world/dimensions/minecraft/the_nether'))
    expect((await start(data, fabric)).exitCode).toBe(0)
    expect(readFileSync(join(outside, 'data/minecraft/world_clocks.dat'), 'utf8')).toBe('theirs')
    expect(existsSync(join(outside, 'data/paper'))).toBe(true)
    expect(existsSync(join(data, '.blockly-paper/world/dimensions/minecraft/the_nether'))).toBe(false)
  })
})
