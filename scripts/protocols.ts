// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minecraft's protocol numbers, by release, as PrismarineJS' minecraft-data publishes them
 * (`data/pc/common/protocolVersions.json`, MIT). The control plane reads a copy of its releases
 * (apps/control/src/minecraft/protocol-versions.json) to tell which clients a server takes; the
 * package itself is far too large to install for one table, so the copy names the version it
 * came from, and this script makes it from that version and nothing else.
 *
 *   bun scripts/protocols.ts bump <version>   copy the releases of that minecraft-data version
 *   bun scripts/protocols.ts check            the copy is still what its version publishes
 *
 * A new Minecraft release is a bump, after minecraft-data has published it.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const COPY = 'apps/control/src/minecraft/protocol-versions.json'

interface Published {
  minecraftVersion: string
  version: number
  usesNetty: boolean
  /** Absent on the oldest entries, which name their kind only by their number. */
  releaseType?: string
}

/** A release's own number, as `1.21.11` or `26.2`: no snapshot, pre-release or candidate. */
const RELEASE = /^\d+\.\d+(\.\d+)?$/

/** The releases of minecraft-data `version`, newest first, as the copy holds them. */
async function releasesOf(version: string): Promise<string> {
  const url = `https://unpkg.com/minecraft-data@${version}/minecraft-data/data/pc/common/protocolVersions.json`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const published = (await response.json()) as Published[]
  // Before 1.7 the handshake was another format, whose numbers the edge never reads.
  const releases = published
    .filter(
      (entry) =>
        RELEASE.test(entry.minecraftVersion) &&
        (entry.releaseType ?? 'release') === 'release' &&
        entry.usesNetty,
    )
    .map((entry) => ({ name: entry.minecraftVersion, protocol: entry.version }))
  return `${JSON.stringify({ source: `minecraft-data ${version}`, releases }, null, 2)}\n`
}

const [command, version] = process.argv.slice(2)
if (command === 'bump' && version !== undefined) {
  writeFileSync(COPY, await releasesOf(version))
  process.stdout.write(`${COPY}: minecraft-data ${version}\n`)
} else if (command === 'check') {
  const held = readFileSync(COPY, 'utf8')
  const source = (JSON.parse(held) as { source: string }).source.replace(/^minecraft-data /, '')
  if ((await releasesOf(source)) !== held) {
    console.error(`${COPY} isn’t what minecraft-data ${source} publishes: run bump ${source}`)
    process.exit(1)
  }
  process.stdout.write(`${COPY} is minecraft-data ${source}’s\n`)
} else {
  console.error('usage: bun scripts/protocols.ts bump <version> | check')
  process.exit(2)
}
