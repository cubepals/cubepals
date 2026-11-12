// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { LogLine } from '../ports/platform.ts'
import { providerSaid } from './provider-said.ts'

const left = new Date('2026-11-12T10:05:10.538Z')
const session = (quietFrom?: string) => ({
  leftAt: left,
  detail: { session: quietFrom === undefined ? {} : { longestQuietFrom: quietFrom } },
})

describe('what the provider’s proxy said around a cut-off session', () => {
  test('is read from just before the quiet began to after the session ended', async () => {
    const asked: Date[][] = []
    await providerSaid(async (from, to) => {
      asked.push([from, to])
      return []
    }, session('2026-11-12T10:04:43.624Z'))
    expect(asked).toEqual([[new Date('2026-11-12T10:04:38.624Z'), new Date('2026-11-12T10:05:40.538Z')]])
    // No word of when the quiet began: from the end.
    await providerSaid(async (from, to) => {
      asked.push([from, to])
      return []
    }, session())
    expect(asked[1]).toEqual([new Date('2026-11-12T10:05:05.538Z'), new Date('2026-11-12T10:05:40.538Z')])
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

  test('nothing said is an empty list; no proxy to say anything is null, as is a session still open', async () => {
    expect(await providerSaid(async () => [], session())).toEqual([])
    expect(await providerSaid(async () => null, session())).toBeNull()
    expect(await providerSaid(async () => [], { leftAt: null, detail: {} })).toBeNull()
  })
})
