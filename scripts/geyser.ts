// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Geyser the edge runs for Bedrock players: one build of its standalone jar, pinned in
 * apps/edge/Dockerfile by version, build number and hash, and nowhere else.
 *
 *   bun scripts/geyser.ts version       the pinned version and build, alone, for scripts
 *   bun scripts/geyser.ts bump [build]  pin that build, or the newest: the Dockerfile's three lines
 *   bun scripts/geyser.ts check         the pinned hash is the one GeyserMC publishes for the build,
 *                                       and says whether a newer build exists
 *
 * Geyser takes one Java version and a range of Bedrock versions, and players' apps update on their
 * own, so a build is replaced when a new Bedrock release is out that the pinned one refuses.
 * Taking a build is its own pull request, whose staging check joins a Bedrock player to it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fetchRetrying } from './blocklyd.ts'

const DOCKERFILE = 'apps/edge/Dockerfile'
const API = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds'

const PIN = /^ARG GEYSER_VERSION=(\S+)\nARG GEYSER_BUILD=(\d+)\nARG GEYSER_SHA256=([0-9a-f]{64})$/m

export interface Pin {
  version: string
  build: number
  sha256: string
}

/** The pin in a Dockerfile's text; null where it has none. */
export function pinOf(dockerfile: string): Pin | null {
  const match = PIN.exec(dockerfile)
  return match === null
    ? null
    : { version: match[1] as string, build: Number(match[2]), sha256: match[3] as string }
}

/** The Dockerfile's text with `pin` in place of the one it has. */
export function repin(dockerfile: string, pin: Pin): string {
  return dockerfile.replace(
    PIN,
    `ARG GEYSER_VERSION=${pin.version}\nARG GEYSER_BUILD=${pin.build}\nARG GEYSER_SHA256=${pin.sha256}`,
  )
}

interface Build {
  version: string
  build: number
  downloads: { standalone: { sha256: string } }
}

/** What GeyserMC publishes of a build, or of the newest. */
async function published(build: number | 'latest'): Promise<Build> {
  const response = await fetchRetrying(`${API}/${build}`)
  if (!response.ok) throw new Error(`${API}/${build}: ${response.status}. Is it a build?`)
  return (await response.json()) as Build
}

function pinned(): Pin {
  const pin = pinOf(readFileSync(DOCKERFILE, 'utf8'))
  if (pin === null)
    throw new Error(`${DOCKERFILE} has no GEYSER_VERSION, GEYSER_BUILD and GEYSER_SHA256 lines`)
  return pin
}

async function bump(build: number | 'latest') {
  const made = await published(build)
  const pin = { version: made.version, build: made.build, sha256: made.downloads.standalone.sha256 }
  pinned()
  writeFileSync(DOCKERFILE, repin(readFileSync(DOCKERFILE, 'utf8'), pin))
  console.warn(`Pinned Geyser ${pin.version} build ${pin.build}. Commit ${DOCKERFILE}.`)
}

async function check() {
  const pin = pinned()
  const made = await published(pin.build)
  if (made.downloads.standalone.sha256 !== pin.sha256) {
    console.error(
      `${DOCKERFILE} pins ${pin.sha256} for build ${pin.build}, but GeyserMC publishes ${made.downloads.standalone.sha256}.\nRun \`bun scripts/geyser.ts bump ${pin.build}\`.`,
    )
    process.exit(1)
  }
  const newest = await published('latest')
  console.warn(
    newest.build > pin.build
      ? `Geyser ${pin.version} build ${pin.build} matches its hash; build ${newest.build} is newer (bun scripts/geyser.ts bump).`
      : `Geyser ${pin.version} build ${pin.build} matches its hash, and is the newest.`,
  )
}

if (import.meta.main) {
  const [command, argument] = process.argv.slice(2)
  if (command === 'version') {
    const { version, build } = pinned()
    process.stdout.write(`${version} ${build}\n`)
  } else if (command === 'bump') await bump(argument === undefined ? 'latest' : Number(argument))
  else if (command === 'check') await check()
  else {
    console.error('usage: bun scripts/geyser.ts version | bump [build] | check')
    process.exit(2)
  }
}
