// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The waiting room refuses a frame whose length is negative, as the front door and the notices do,
 * rather than reading it again and again.
 *
 * `Held` runs on the agent's own event loop, so a call that never returned would hang the test
 * runner; the construction runs in a child bun and the test asserts it returns before a deadline.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const HOLD = join(import.meta.dir, 'hold.ts')
const NOTICE = join(import.meta.dir, 'notice.ts')

/** Builds a held join from one chunk; whether `Held`'s constructor returned before `ms`. */
async function construction(ms: number): Promise<boolean> {
  const script = `
    import { Held } from ${JSON.stringify(HOLD)}
    import { packet, string, varInt } from ${JSON.stringify(NOTICE)}
    const handshake = packet(0, [...varInt(767), ...string('anything.play.example'), 0x63, 0xdd, 2])
    const login = packet(0, [...string('Steve'), ...new Array(16).fill(0)])
    // A frame length that reads as a negative varint.
    const negative = Uint8Array.from([0xfb, 0xff, 0xff, 0xff, 0x0f])
    new Held({ address: 'anything.play.example', protocol: 767,
      bytes: Uint8Array.from([...handshake, ...login, ...negative]) })
    console.log('done')
  `
  const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => child.kill('SIGKILL'), ms)
  const out = await new Response(child.stdout).text()
  await child.exited
  clearTimeout(timer)
  return out.includes('done')
}

describe('a negative frame length in the waiting room', () => {
  test('a held join with a poisoned frame is handled, not looped on forever', async () => {
    expect(await construction(3_000)).toBe(true)
  }, 10_000)
})
