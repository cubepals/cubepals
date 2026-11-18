// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The packet ids the edge's dialog hold speaks (`apps/edge/dialog-hold.ts`), by protocol number,
 * as each release's own server reports them: `java -DbundlerMainClass=net.minecraft.data.Main -jar
 * server.jar --reports` writes `reports/packets.json`, every packet's id in every state. They move
 * between releases (26.3 put a packet before Show Dialog and Transfer), and minecraft-data lags
 * the newest releases, so the game itself is the source. With them goes how the release lays out
 * the two packets the hold writes itself, read from its jar with `javap` (`hold-layouts.ts`): a
 * release whose layout the edge can't write is refused, so its clients keep the login hold.
 *
 *   bun scripts/hold-packets.ts bump    run each release's server for its report and read its
 *                                       layouts; needs Java 25 (`JAVA=/path/to/java` where `java`
 *                                       is older, and its `javap`, or `JAVAP=`)
 *   bun scripts/hold-packets.ts check   the copy names the jars Mojang publishes for its releases,
 *                                       every protocol the edge knows from 1.21.6 on has one, and
 *                                       each has layouts the edge writes
 *
 * The protocols are the control plane's copy of minecraft-data's table
 * (apps/control/src/minecraft/protocol-versions.json, `scripts/protocols.ts`): a new release is a
 * bump there, then a bump here. A protocol with no entry keeps the login hold.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Layouts, LOGIN_FINISHED_LAYOUTS, TRANSFER_LAYOUTS } from '../apps/edge/hold-packet-ids.ts'
import { layoutsOf, Mappings } from './hold-layouts.ts'

const COPY = 'apps/edge/hold-packets.json'
const RELEASES = 'apps/control/src/minecraft/protocol-versions.json'
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
/** 1.21.6's number: the first whose clients take a dialog while they configure. */
export const FIRST_DIALOG = 771

/** What the edge sends and reads in each state, by the names the report gives them. */
const WANTED = {
  login: {
    clientbound: { finished: 'minecraft:login_finished' },
    serverbound: { acknowledged: 'minecraft:login_acknowledged' },
  },
  configuration: {
    clientbound: {
      disconnect: 'minecraft:disconnect',
      keepAlive: 'minecraft:keep_alive',
      showDialog: 'minecraft:show_dialog',
      transfer: 'minecraft:transfer',
    },
    serverbound: { keepAlive: 'minecraft:keep_alive' },
  },
} as const

type Report = Record<string, Record<string, Record<string, { protocol_id: number }>>>

export interface HoldPackets {
  protocol: number
  release: string
  /** The SHA-1 of the server jar whose report this is, as Mojang's manifest names it. */
  jar: string
  login: { finished: number; acknowledged: number }
  configuration: {
    disconnect: number
    keepAlive: number
    showDialog: number
    transfer: number
    keepAliveAnswer: number
  }
  /** How the release writes Login Finished and Transfer, read from its jar (`hold-layouts.ts`). */
  layouts: Layouts
}

/** The ids the hold needs from a server's `packets.json`; throws naming any the report lacks. */
export function idsOf(report: Report): Pick<HoldPackets, 'login' | 'configuration'> {
  const id = (state: string, direction: string, name: string): number => {
    const found = report[state]?.[direction]?.[name]?.protocol_id
    if (typeof found !== 'number') throw new Error(`the report has no ${state} ${direction} ${name}`)
    return found
  }
  const { login, configuration } = WANTED
  return {
    login: {
      finished: id('login', 'clientbound', login.clientbound.finished),
      acknowledged: id('login', 'serverbound', login.serverbound.acknowledged),
    },
    configuration: {
      disconnect: id('configuration', 'clientbound', configuration.clientbound.disconnect),
      keepAlive: id('configuration', 'clientbound', configuration.clientbound.keepAlive),
      showDialog: id('configuration', 'clientbound', configuration.clientbound.showDialog),
      transfer: id('configuration', 'clientbound', configuration.clientbound.transfer),
      keepAliveAnswer: id('configuration', 'serverbound', configuration.serverbound.keepAlive),
    },
  }
}

/** The newest release of each protocol from 1.21.6 on, newest first, from the edge's table. */
export function releasesToReport(releases: readonly { name: string; protocol: number }[]) {
  const newest = new Map<number, string>()
  for (const release of releases)
    if (release.protocol >= FIRST_DIALOG && !newest.has(release.protocol))
      newest.set(release.protocol, release.name)
  return [...newest].map(([protocol, release]) => ({ protocol, release }))
}

interface Manifest {
  versions: { id: string; url: string }[]
}

/** What the script reaches outside itself: the web, Java, and the two files. */
export interface World {
  fetch: (url: string) => Promise<Response>
  /** The Java that runs the servers: Mojang's 26.x servers need 25. */
  java: string
  /** The `javap` that reads a server's classes for the hold's layouts: any JDK's will do. */
  javap: string
  copy: string
  releases: string
  say: (line: string) => void
}

const json = async <T>(world: World, url: string): Promise<T> => {
  const response = await world.fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}

/** Each release's server jar, as Mojang's manifest publishes it. */
async function serverJar(
  world: World,
  manifest: Manifest,
  release: string,
): Promise<{ sha1: string; url: string; mappings?: string }> {
  const entry = manifest.versions.find((v) => v.id === release)
  if (entry === undefined) throw new Error(`Mojang's manifest has no ${release}`)
  const { downloads } = await json<{
    downloads: { server: { sha1: string; url: string }; server_mappings?: { url: string } }
  }>(world, entry.url)
  return {
    ...downloads.server,
    ...(downloads.server_mappings ? { mappings: downloads.server_mappings.url } : {}),
  }
}

/**
 * The layouts `release` writes, read with `javap` from the game's own jar, which its server's
 * bundler unpacked into `dir` as it ran, and named by Mojang's mappings where the jar is obfuscated.
 */
async function layoutsIn(world: World, dir: string, release: string, mappingsUrl?: string): Promise<Layouts> {
  const versions = join(dir, 'versions')
  const unpacked = readdirSync(versions, { recursive: true, encoding: 'utf8' }).find((f) =>
    f.endsWith('.jar'),
  )
  if (unpacked === undefined) throw new Error(`${release}'s server unpacked no jar of the game`)
  const mappings =
    mappingsUrl === undefined ? Mappings.NONE : new Mappings(await (await world.fetch(mappingsUrl)).text())
  const javap = (className: string) => {
    const run = spawnSync(world.javap, ['-c', '-p', '-cp', join(versions, unpacked), className], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (run.status !== 0) throw new Error(`javap couldn't read ${className} in ${release}: ${run.stderr}`)
    return run.stdout
  }
  try {
    return layoutsOf(javap, mappings)
  } catch (error) {
    throw new Error(`${release}: ${(error as Error).message}`)
  }
}

/** Runs `release`'s server for its report, and takes the hold's ids from it. */
async function reportOf(
  world: World,
  manifest: Manifest,
  protocol: number,
  release: string,
): Promise<HoldPackets> {
  const jar = await serverJar(world, manifest, release)
  const bytes = new Uint8Array(await (await world.fetch(jar.url)).arrayBuffer())
  if (createHash('sha1').update(bytes).digest('hex') !== jar.sha1)
    throw new Error(`${release}'s server jar isn't the one Mojang names`)
  const dir = mkdtempSync(join(tmpdir(), 'hold-packets-'))
  try {
    writeFileSync(join(dir, 'server.jar'), bytes)
    const run = spawnSync(
      world.java,
      ['-DbundlerMainClass=net.minecraft.data.Main', '-jar', 'server.jar', '--reports', '--output', 'out'],
      { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    if (run.status !== 0) throw new Error(`${release}'s report failed: ${run.stderr || run.stdout}`)
    const report = JSON.parse(readFileSync(join(dir, 'out/reports/packets.json'), 'utf8')) as Report
    const layouts = await layoutsIn(world, dir, release, jar.mappings)
    return { protocol, release, jar: jar.sha1, ...idsOf(report), layouts }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const releasesIn = (world: World) =>
  releasesToReport(
    (JSON.parse(readFileSync(world.releases, 'utf8')) as { releases: { name: string; protocol: number }[] })
      .releases,
  )

/** Reports every protocol again, and writes the copy. */
async function bump(world: World): Promise<void> {
  const manifest = await json<Manifest>(world, MANIFEST)
  const protocols: HoldPackets[] = []
  for (const { protocol, release } of releasesIn(world)) {
    protocols.push(await reportOf(world, manifest, protocol, release))
    world.say(`${release} (${protocol}): reported`)
  }
  writeFileSync(world.copy, `${JSON.stringify({ source: 'server.jar --reports', protocols }, null, 2)}\n`)
}

/** Whether `layouts` are ones the edge's dialog hold writes. */
const writable = (layouts: Partial<Layouts> | undefined): boolean =>
  (LOGIN_FINISHED_LAYOUTS as readonly unknown[]).includes(layouts?.loginFinished) &&
  (TRANSFER_LAYOUTS as readonly unknown[]).includes(layouts?.transfer)

/** What is wrong with the copy, against Mojang's manifest and the edge's protocols; nothing when it is right. */
async function check(world: World): Promise<string[]> {
  const manifest = await json<Manifest>(world, MANIFEST)
  const held = (JSON.parse(readFileSync(world.copy, 'utf8')) as { protocols: Partial<HoldPackets>[] })
    .protocols
  const wrong: string[] = []
  for (const { protocol, release } of releasesIn(world)) {
    const entry = held.find((p) => p.protocol === protocol)
    if (entry === undefined) wrong.push(`${release} (${protocol}) has no entry`)
    else if (entry.release !== release || entry.jar !== (await serverJar(world, manifest, release)).sha1)
      wrong.push(`${release} (${protocol}) wasn't reported from its own jar`)
    else if (!writable(entry.layouts)) wrong.push(`${release} (${protocol}) has no layouts the edge writes`)
  }
  return wrong
}

/** Runs `bump` or `check`; the exit code. */
export async function main(args: readonly string[], world: World): Promise<number> {
  const [command] = args
  if (command === 'bump') {
    await bump(world)
    return 0
  }
  if (command === 'check') {
    const wrong = await check(world)
    world.say(
      wrong.length === 0
        ? `${world.copy} is each release's own report`
        : `${world.copy}: ${wrong.join('; ')}: run bump`,
    )
    return wrong.length === 0 ? 0 : 1
  }
  world.say('usage: bun scripts/hold-packets.ts bump | check')
  return 2
}

if (import.meta.main)
  process.exit(
    await main(process.argv.slice(2), {
      fetch,
      java: process.env.JAVA ?? 'java',
      javap: process.env.JAVAP ?? (process.env.JAVA ? join(dirname(process.env.JAVA), 'javap') : 'javap'),
      copy: COPY,
      releases: RELEASES,
      say: (line) => process.stdout.write(`${line}\n`),
    }),
  )
