// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a signal keeps of the provider's proxy (`provider-said.ts`): which moments it reads between,
 * and that no address is left in a line it keeps.
 */
import { describe, expect, test } from 'bun:test'
import type { LogLine } from '../ports/platform.ts'
import { providerSaid } from './provider-said.ts'

const left = new Date('2026-11-12T10:05:10.538Z')
const session = (end: Record<string, unknown> = {}) => ({ leftAt: left, detail: { session: end } })

describe('what the provider’s proxy said around a cut-off session', () => {
  test('is read from just before the quiet began to after the session ended', async () => {
    const asked: Date[][] = []
    await providerSaid(
      async (from, to) => {
        asked.push([from, to])
        return []
      },
      session({ quietAtEndMs: 26_914 }),
    )
    expect(asked).toEqual([[new Date('2026-11-12T10:04:38.624Z'), new Date('2026-11-12T10:05:40.538Z')]])
    // No word of how long the quiet was: from the end.
    await providerSaid(async (from, to) => {
      asked.push([from, to])
      return []
    }, session())
    expect(asked[1]).toEqual([new Date('2026-11-12T10:05:05.538Z'), new Date('2026-11-12T10:05:40.538Z')])
  })

  test('is read from the quiet the session ended in, not a longer one the player came back from', async () => {
    const asked: Date[] = []
    await providerSaid(
      async (from) => {
        asked.push(from)
        return []
      },
      session({ longestQuietMs: 40_000, longestQuietFrom: '2026-11-12T07:00:00.000Z', quietAtEndMs: 26_914 }),
    )
    expect(asked).toEqual([new Date('2026-11-12T10:04:38.624Z')])
  })

  test('keeps its last lines without the addresses in them', async () => {
    const lines: LogLine[] = [
      {
        at: new Date('2026-11-12T10:05:11Z'),
        text: 'could not reach 203.0.113.7:25565 for [2001:db8::1f]:52555',
      },
      { at: new Date('2026-11-12T10:05:14.098Z'), text: '[PP03] could not proxy TCP data to/from instance' },
    ]
    expect(await providerSaid(async () => lines, session())).toEqual([
      { at: '2026-11-12T10:05:11.000Z', said: 'could not reach <address>:25565 for <address>:52555' },
      { at: '2026-11-12T10:05:14.098Z', said: '[PP03] could not proxy TCP data to/from instance' },
    ])
  })

  test('takes an IPv6 address out in every form it is written in, and leaves a time alone', async () => {
    const said = async (text: string) =>
      (await providerSaid(async () => [{ at: left, text }], session()))?.map((line) => line.said)
    expect(await said('from [2600::1]:52555 at 10:05:14')).toEqual(['from <address>:52555 at 10:05:14'])
    expect(await said('from [2600:1234:5678::]:52555')).toEqual(['from <address>:52555'])
    expect(await said('from ::1, 2600:1234:5678:9abc:def0:1234:5678:9abc.')).toEqual([
      'from <address>, <address>.',
    ])
    expect(await said('from ::ffff:203.0.113.7 and fe80::1%eth0')).toEqual([
      'from <address> and <address>%eth0',
    ])
  })

  test('nothing said is an empty list; no proxy to say anything is null, as is a session still open', async () => {
    expect(await providerSaid(async () => [], session())).toEqual([])
    expect(await providerSaid(async () => null, session())).toBeNull()
    expect(await providerSaid(async () => [], { leftAt: null, detail: {} })).toBeNull()
  })
})
