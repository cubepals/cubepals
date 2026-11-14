// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plugins Cubepals places on Paper servers itself, pinned by release and hash in
 * apps/control/src/minecraft/compat-pins.json (`compat-pins.ts` says why).
 *
 *   bun scripts/compat-pins.ts check   which plugin has a newer release than its pin; exits 1
 *                                      while any does, so the weekly run goes red
 *   bun scripts/compat-pins.ts bump    pin the newest of each: a release on Modrinth that runs on
 *                                      every Minecraft release Paper serves here, and GeyserMC's
 *                                      newest Floodgate build
 *
 * A pin is moved in a pull request of its own, whose nightly starts a Paper server with it before
 * any player's server does.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { CatalogVersion } from '../apps/control/src/domain/mods/catalog.ts'
import { GeyserMcService } from '../apps/control/src/infra/geysermc/geysermc.ts'
import { modrinthClient } from '../apps/control/src/infra/modrinth/client.ts'
import { ModrinthCatalog } from '../apps/control/src/infra/modrinth/modrinth-catalog.ts'
import type { CompatPin, CompatPins } from '../apps/control/src/minecraft/compat-pins.ts'
import { catalogLoadersFor } from '../apps/control/src/minecraft/mods.ts'
import { offeredVersions } from '../apps/control/src/minecraft/versions.ts'

const FILE = 'apps/control/src/minecraft/compat-pins.json'

/** Modrinth refuses a request that doesn't name its application. */
const USER_AGENT = 'cubepals/cubepals (scripts/compat-pins.ts)'

/** Each pin a newer release would replace, as `name: pinned -> newer`. */
export function behind(pinned: CompatPins, newest: CompatPins): string[] {
  const lines: string[] = []
  for (const pin of pinned.plugins) {
    const next = newest.plugins.find((p) => p.projectId === pin.projectId)
    if (next !== undefined && next.versionId !== pin.versionId)
      lines.push(`${pin.name}: ${pin.label} -> ${next.label}`)
  }
  const [was, now] = [pinned.floodgate, newest.floodgate]
  if (was !== null && now !== null && now.build !== was.build)
    lines.push(`Floodgate: ${was.version} build ${was.build} -> ${now.version} build ${now.build}`)
  return lines
}

/**
 * The newest listed release among `lists`, one list per Minecraft release, that is in every one:
 * a release that runs on all of them. Null where there is none.
 */
export function newestInAll(lists: readonly (readonly CatalogVersion[])[]): CatalogVersion | null {
  const [first, ...rest] = lists
  if (first === undefined) return null
  const fits = first
    .filter((v) => v.channel === 'release' && v.state === 'listed')
    .filter((v) => rest.every((list) => list.some((other) => other.versionId === v.versionId)))
  return fits.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0] ?? null
}

/**
 * Where a plugin has a release newer than the one `bump` would take, because it doesn't list every
 * Minecraft release a server here can run: which, as a line `check` fails on. Null where there is
 * none, so a release that can't be taken is never passed over in silence.
 */
export function heldBack(
  pin: CompatPin,
  lists: readonly (readonly CatalogVersion[])[],
  releases: readonly string[],
): string | null {
  const taken = newestInAll(lists)
  const newest = lists
    .flat()
    .filter((v) => v.channel === 'release' && v.state === 'listed')
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0]
  if (newest === undefined || newest.versionId === pin.versionId || newest.versionId === taken?.versionId)
    return null
  const missing = releases.filter((_, i) => !lists[i]?.some((v) => v.versionId === newest.versionId))
  return `${pin.name}: ${newest.versionLabel} is out but not for ${missing.join(', ')}, which servers here run; the pin stays`
}

async function newest(pinned: CompatPins): Promise<{ latest: CompatPins; held: string[] }> {
  const catalog = new ModrinthCatalog(modrinthClient(USER_AGENT))
  const loaders = catalogLoadersFor('paper')
  // Every release a Paper server here can run: Paper's own, and plain Minecraft's, which runs on
  // it, as the control plane pins for each (`CompatPlugins.#releases`).
  const releases = offeredVersions().map((offered) => offered.id)
  const plugins: CompatPin[] = []
  const held: string[] = []
  for (const pin of pinned.plugins) {
    const lists = await Promise.all(
      releases.map((gameVersion) => catalog.versions(pin.projectId, { loaders, gameVersion })),
    )
    const release = newestInAll(lists)
    plugins.push(
      release === null
        ? pin
        : { ...pin, versionId: release.versionId, label: release.versionLabel, sha512: release.file.sha512 },
    )
    const line = heldBack(pin, lists, releases)
    if (line !== null) held.push(line)
  }
  const floodgate = (await new GeyserMcService().latestFloodgate()) ?? pinned.floodgate
  return { latest: { plugins, floodgate }, held }
}

const read = (): CompatPins => JSON.parse(readFileSync(FILE, 'utf8'))

if (import.meta.main) {
  const command = process.argv[2]
  const pinned = read()
  const { latest, held } = await newest(pinned)
  const lines = behind(pinned, latest)
  if (command === 'check') {
    if (lines.length === 0 && held.length === 0) console.log('Every plugin is pinned to its newest release.')
    else {
      if (lines.length > 0)
        console.log(
          `Newer than the pins (bun scripts/compat-pins.ts bump, in a pull request):\n${lines.join('\n')}`,
        )
      if (held.length > 0) console.log(`Newer, but not for every release served here:\n${held.join('\n')}`)
      process.exit(1)
    }
  } else if (command === 'bump') {
    writeFileSync(FILE, `${JSON.stringify(latest, null, 2)}\n`)
    console.log(lines.length === 0 ? 'Nothing newer; the pins are as they were.' : lines.join('\n'))
    if (held.length > 0) console.log(held.join('\n'))
  } else {
    console.error('usage: bun scripts/compat-pins.ts check|bump')
    process.exit(2)
  }
}
