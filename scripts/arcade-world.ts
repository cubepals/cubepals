// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the Arcade's world from the published maps it is made of (`ARCADE_MAPS`), and packs it as
 * the archive a new Arcade server starts on (`ARCADE_WORLD`). Run it again only when a map, its
 * place or the world's own additions change:
 *
 *     JAVA=/path/to/java25 bun scripts/arcade-world.ts
 *
 * 1. Each map's folder is fetched from its repository at the pinned commit, and converted by
 *    Chunker (HiveGamesOSS/Chunker, MIT, at a pinned commit) to Java 26.2: NetherGames' worlds are
 *    Bedrock, Overcast's are old Java worlds.
 * 2. A Paper 26.2 server is started on a void world, with each map as a dimension of its own
 *    (a datapack of this build's, `arcadebuild:<key>`). Each map is cloned, slab by slab, into the
 *    overworld at its place, and Minecraft writes every block as 26.2 has it, lit.
 * 3. The world's own changes are made: no real person's likeness (`arcade-likeness.ts`); the hall
 *    in Cubepals' colours, lit, with a doorway (`arcade-hall.ts`), buried in the ground
 *    (`arcade-ground.ts`) under the landing page's house, a few steps from a doorway to it
 *    (`arcade-house.ts`); a copy of the falling floor's floors to put them back from
 *    (`arcade-additions.ts`); and Cubepals: the mark on the hall's screens and the pads
 *    (`arcade-brand.ts`). The Cubepals signs are the datapack's, which builds them as it starts.
 * 4. The overworld alone is packed as `arcade-world.tar.gz`, with `CREDITS.txt`, and its SHA-512
 *    and size printed for `ARCADE_WORLD`. `bun scripts/arcade-upload.ts` puts it in a
 *    deployment's archive store; the maps never go into this repository.
 *
 * Everything is kept under `local/arcade-world/`, so a second run reuses what the first fetched.
 * Not the games: those are the datapack every Arcade server carries (`minecraft/arcade.ts`).
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { creditsText, MAP_SOURCES } from '../apps/control/src/minecraft/arcade/credits.ts'
import { HUB_SPAWN } from '../apps/control/src/minecraft/arcade/datapack.ts'
import { ARCADE_MAPS, type ArcadeMap } from '../apps/control/src/minecraft/arcade/maps.ts'
import { RCON_PORT } from '../apps/control/src/minecraft/ports.ts'
import { ADDITIONS } from './lib/arcade-additions.ts'
import { BRAND_COMMANDS } from './lib/arcade-brand.ts'
import { GROUND, GROUND_COMMANDS } from './lib/arcade-ground.ts'
import { HALL_COMMANDS, HALL_LIGHTS } from './lib/arcade-hall.ts'
import { HOUSE_COMMANDS, INSIDE } from './lib/arcade-house.ts'
import { LIKENESS_COMMANDS } from './lib/arcade-likeness.ts'
import { rcon } from './lib/rcon.ts'

const WORK = resolve('local/arcade-world')
const JAVA = process.env.JAVA ?? 'java'
const CHUNKER = {
  repo: 'https://github.com/HiveGamesOSS/Chunker',
  commit: '50aaf6d82e8b68929279161b790d95fdddfe0a40',
}
const PAPER = {
  url: 'https://fill-data.papermc.io/v1/objects/3cce0a4922baf79bd8e1275ee5ff9f073f24675770e09b0d4be9442d513e7a6b/paper-26.2-134.jar',
  sha256: '3cce0a4922baf79bd8e1275ee5ff9f073f24675770e09b0d4be9442d513e7a6b',
}
const PASSWORD = 'arcade-build'
const LEVEL = 'arcade'
const say = (line: string) => process.stdout.write(`${line}\n`)

function run(command: string, args: string[], cwd = WORK): void {
  const done = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
  })
  if (done.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${done.status}`)
}

/** A repository's folders at one commit, without the rest of its history or files. */
function fetchFolders(repo: string, commit: string, paths: string[]): string {
  const dir = join(WORK, 'sources', createHash('sha256').update(repo).digest('hex').slice(0, 12))
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true })
    run('git', ['init', '-q'], dir)
    run('git', ['config', 'gc.auto', '0'], dir)
    run('git', ['remote', 'add', 'origin', repo], dir)
  }
  run('git', ['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit], dir)
  run('git', ['checkout', '-q', commit, '--', ...paths], dir)
  return dir
}

function chunker(): string {
  const dir = join(WORK, 'chunker')
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true })
    run('git', ['init', '-q'], dir)
    run('git', ['fetch', '-q', '--depth', '1', CHUNKER.repo, CHUNKER.commit], dir)
    run('git', ['checkout', '-q', 'FETCH_HEAD'], dir)
  }
  const jar = join(dir, 'build/libs')
  if (!existsSync(jar)) run('./gradlew', ['-q', ':cli:shadowJar', '--no-daemon'], dir)
  const built = readdirSync(jar).find((name) => name.startsWith('chunker-cli-') && name.endsWith('.jar'))
  if (built === undefined) throw new Error('Chunker built no CLI jar')
  return join(jar, built)
}

/** Each map as a Java 26.2 world of its own. */
function convert(jar: string, map: ArcadeMap): string {
  const out = join(WORK, 'java', map.key)
  if (existsSync(join(out, 'level.dat'))) return out
  const source = MAP_SOURCES[map.key]
  if (source === undefined) throw new Error(`No source for the Arcade map ${map.key}`)
  const src = join(fetchFolders(source.repo, source.commit, [source.path]), source.path)
  run(JAVA, ['-jar', jar, '-i', src, '-f', 'JAVA_26_2', '-o', out])
  return out
}

async function paperJar(): Promise<string> {
  const jar = join(WORK, 'server', 'paper.jar')
  if (existsSync(jar) && sha256(jar) === PAPER.sha256) return jar
  mkdirSync(join(WORK, 'server'), { recursive: true })
  writeFileSync(jar, new Uint8Array(await (await fetch(PAPER.url)).arrayBuffer()))
  if (sha256(jar) !== PAPER.sha256) throw new Error('Paper jar does not match its checksum')
  return jar
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * Puts each map's regions into its dimension. Paper reads a dimension it finds on disk as one it
 * made, with settings of its own, so the regions go in only once it has made them, while stopped.
 */
function addRegions(worlds: Map<string, string>): void {
  for (const [key, world] of worlds)
    cpSync(
      join(world, 'dimensions', 'minecraft', 'overworld', 'region'),
      join(WORK, 'server', LEVEL, 'dimensions', 'arcadebuild', key, 'region'),
      { recursive: true },
    )
}

/** A void overworld, and each map as a dimension of the build's own datapack. */
function prepareServer(worlds: Map<string, string>): void {
  const server = join(WORK, 'server')
  rmSync(join(server, LEVEL), { recursive: true, force: true })
  const pack = join(server, LEVEL, 'datapacks', 'arcade-build')
  mkdirSync(join(pack, 'data', 'arcadebuild', 'dimension'), { recursive: true })
  writeFileSync(
    join(pack, 'pack.mcmeta'),
    JSON.stringify({ pack: { description: 'Arcade build', min_format: 88, max_format: 1000 } }),
  )
  const voidGenerator = {
    type: 'minecraft:flat',
    settings: {
      biome: 'minecraft:the_void',
      layers: [],
      lakes: false,
      features: false,
      structure_overrides: [],
    },
  }
  for (const key of worlds.keys()) {
    writeFileSync(
      join(pack, 'data', 'arcadebuild', 'dimension', `${key}.json`),
      JSON.stringify({ type: 'minecraft:overworld', generator: voidGenerator }),
    )
  }
  writeFileSync(join(server, 'eula.txt'), 'eula=true\n')
  writeFileSync(
    join(server, 'server.properties'),
    [
      `level-name=${LEVEL}`,
      'level-type=minecraft\\:flat',
      `generator-settings=${JSON.stringify({ biome: 'minecraft:the_void', layers: [{ block: 'minecraft:air', height: 1 }], lakes: false, features: false, structure_overrides: [] }).replaceAll(':', '\\:')}`,
      'online-mode=false',
      'server-port=25600',
      'enable-rcon=true',
      `rcon.port=${RCON_PORT}`,
      `rcon.password=${PASSWORD}`,
      'spawn-protection=0',
      'view-distance=4',
      '',
    ].join('\n'),
  )
}

async function startServer(jar: string): Promise<() => Promise<void>> {
  const child = spawn(JAVA, ['-Xmx6G', '-jar', jar, '--nogui'], {
    cwd: join(WORK, 'server'),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((done, fail) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Done (')) done()
    })
    child.on('exit', (code) => fail(new Error(`Paper exited ${code} before it was up`)))
  })
  return async () => {
    await console_('stop')
    await new Promise((done) => child.on('exit', done))
  }
}

const console_ = (command: string) => rcon('127.0.0.1', command, PASSWORD)

/** Runs a command, and stops the build if the game refuses it. */
async function must(command: string): Promise<string> {
  const said = await console_(command)
  if (/Unknown|Incorrect|not loaded|too many|No blocks|Expected|Invalid/i.test(said))
    throw new Error(`${command}: ${said}`)
  return said
}

/**
 * Runs a command once the chunks it reaches are in: forcing chunks to load returns before they
 * are, and a command run on one not yet loaded does nothing.
 */
async function onceLoaded(command: string): Promise<string> {
  for (let tries = 0; ; tries++) {
    const said = await console_(command)
    if (!said.includes('not loaded')) return said
    if (tries === 120) throw new Error(`${command}: the chunks never loaded`)
    await new Promise((done) => setTimeout(done, 500))
  }
}

/** Keeps the chunks of a box loaded in a dimension, in pieces of at most 256 chunks. */
async function forceload(
  dimension: string,
  [x0, , z0]: number[],
  [x1, , z1]: number[],
  add: boolean,
): Promise<void> {
  for (let x = x0; x <= x1; x += 256)
    for (let z = z0; z <= z1; z += 256)
      await console_(
        `execute in ${dimension} run forceload ${add ? 'add' : 'remove'} ${x} ${z} ${Math.min(x + 255, x1)} ${Math.min(z + 255, z1)}`,
      )
}

/** Minecraft's sixteen dye colours, as its concrete and powder are named. */
const COLOURS =
  'white orange magenta light_blue yellow lime pink gray light_gray cyan purple blue brown green red black'.split(
    ' ',
  )

/** Clones a map from its dimension into the overworld at its place, a few layers at a time. */
async function place(map: ArcadeMap): Promise<void> {
  const [ox, oy, oz] = map.offset
  const target = (b: readonly number[]) => [(b[0] ?? 0) + ox, (b[1] ?? 0) + oy, (b[2] ?? 0) + oz]
  await forceload(`arcadebuild:${map.key}`, [...map.from], [...map.to], true)
  await forceload('minecraft:overworld', target(map.from), target(map.to), true)
  const [x0, y0, z0] = map.from
  const [x1, y1, z1] = map.to
  // Concrete powder a map floats would fall as it is cloned, and what stands on it with it: it
  // goes in as concrete of its colour. Game rules are each dimension's own, so the map's dimension
  // takes a whole map in one fill too.
  await must(`execute in arcadebuild:${map.key} run gamerule max_block_modifications 2147483647`)
  for (const colour of COLOURS) {
    const said = await onceLoaded(
      `execute in arcadebuild:${map.key} run fill ${x0} ${y0} ${z0} ${x1} ${y1} ${z1} minecraft:${colour}_concrete replace minecraft:${colour}_concrete_powder`,
    )
    if (!/filled|No blocks/.test(said)) throw new Error(`${map.title}'s ${colour} concrete powder: ${said}`)
  }
  const step = Math.max(1, Math.floor(400_000 / ((x1 - x0 + 1) * (z1 - z0 + 1))))
  for (let y = y0; y <= y1; y += step) {
    const top = Math.min(y + step - 1, y1)
    await console_(
      `clone from arcadebuild:${map.key} ${x0} ${y} ${z0} ${x1} ${top} ${z1} to minecraft:overworld ${x0 + ox} ${y + oy} ${z0 + oz}`,
    )
  }
  await forceload(`arcadebuild:${map.key}`, [...map.from], [...map.to], false)
  say(`placed ${map.title} at ${target(map.from).join(' ')}`)
}

function pack(): string {
  const level = join(WORK, 'server', LEVEL)
  const out = join(WORK, 'arcade-world.tar.gz')
  // The overworld alone: not the build's dimensions, its datapack, players or Paper's own files,
  // nor its entities, which are only what the build dropped: cloning brings blocks alone. With it,
  // who made each map and what changed, as their licences ask.
  writeFileSync(join(level, 'CREDITS.txt'), creditsText())
  run('tar', [
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--mtime=@0',
    '-czf',
    out,
    '-C',
    level,
    'level.dat',
    'data/minecraft',
    'dimensions/minecraft/overworld/region',
    'dimensions/minecraft/overworld/data',
    'CREDITS.txt',
  ])
  return out
}

async function main(): Promise<void> {
  // Everyone starts inside the house: the datapack's spawn is where the house is built.
  if (!HUB_SPAWN.startsWith(`${INSIDE[0] + 0.5} ${INSIDE[1]} ${INSIDE[2] + 0.5} `))
    throw new Error(`HUB_SPAWN (${HUB_SPAWN}) is not inside the house (${INSIDE.join(' ')})`)
  mkdirSync(WORK, { recursive: true })
  const converter = chunker()
  const worlds = new Map(ARCADE_MAPS.map((map) => [map.key, convert(converter, map)]))
  prepareServer(worlds)
  const jar = await paperJar()
  await (await startServer(jar))()
  addRegions(worlds)
  const stop = await startServer(jar)
  try {
    await must('gamerule max_block_modifications 2147483647')
    for (const map of ARCADE_MAPS) await place(map)
    // The ground round the hall, and the house on it, loaded like the maps.
    await forceload('minecraft:overworld', [...GROUND.from], [...GROUND.to], true)
    for (const command of ADDITIONS) await must(command)
    // A fill that finds nothing to replace says so, which is no failure here; nor is a light block
    // kept out by something already there.
    for (const command of [...LIKENESS_COMMANDS, ...HALL_COMMANDS, ...HALL_LIGHTS]) await onceLoaded(command)
    for (const command of [...GROUND_COMMANDS, ...HOUSE_COMMANDS]) await onceLoaded(command)
    for (const command of BRAND_COMMANDS) await console_(command)
    await console_('forceload remove all')
    // Back to the game's own limit, which the world keeps.
    await must('gamerule max_block_modifications 32768')
    await must('datapack disable "file/arcade-build"')
    await console_('save-all flush')
  } finally {
    await stop()
  }
  const out = pack()
  const bytes = readFileSync(out)
  say(`${out}: sha512 ${createHash('sha512').update(bytes).digest('hex')}, ${bytes.length} bytes`)
}

await main()
