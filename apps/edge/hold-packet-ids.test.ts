// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The registry must load and select the packet ids reported by the client's own release. */
import { expect, test } from 'bun:test'
import table from './hold-packets.json' with { type: 'json' }

test('the registry loads every reported release and refuses unreported protocols', async () => {
  const { packetsFor } = await import('./hold-packet-ids.ts')
  expect(table.protocols.length).toBeGreaterThan(0)
  for (const entry of table.protocols) expect(packetsFor(entry.protocol)).toEqual(entry)
  const protocols = table.protocols.map((entry) => entry.protocol)
  expect(packetsFor(Math.min(...protocols) - 1)).toBeNull()
  expect(packetsFor(Math.max(...protocols) + 1)).toBeNull()
})
