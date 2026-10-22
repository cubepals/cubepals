// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Java players at a sizing edge (size.ts), beside the Bedrock ones: a few loops, each a status ping
 * and a login to the server behind the edge, timed, one after another for a while. Prints the times.
 *
 *   bun java-load.ts <edge host> <loops> <seconds>
 */

import { join } from '../../../../scripts/lib/minecraft.ts'

const [host = '', loops = '5', seconds = '60'] = process.argv.slice(2)
const until = Date.now() + Number(seconds) * 1000
const times: number[] = []
let failures = 0

async function loop(index: number) {
  for (let n = 0; Date.now() < until; n++) {
    try {
      times.push(await join({ host, port: 25565 }, 'a.play.bsize', `Java${index}x${n}`.slice(0, 16), 30_000))
    } catch {
      failures++
    }
    await Bun.sleep(1000)
  }
}

await Promise.all(Array.from({ length: Number(loops) }, (_, i) => loop(i)))
times.sort((a, b) => a - b)
const at = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? null
process.stdout.write(
  `${JSON.stringify({ joins: times.length, failures, p50: at(0.5), p95: at(0.95), max: at(1) })}\n`,
)
