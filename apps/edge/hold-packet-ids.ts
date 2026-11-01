// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The packet ids the dialog hold speaks, by the client's protocol number, as each release's own
 * server reports them (`hold-packets.json`, made by `bun scripts/hold-packets.ts bump`). Not for
 * how the packets are written (`dialog-hold.ts`).
 */
import table from './hold-packets.json' with { type: 'json' }

export interface HoldPackets {
  login: { finished: number; acknowledged: number }
  configuration: {
    disconnect: number
    keepAlive: number
    showDialog: number
    transfer: number
    keepAliveAnswer: number
  }
}

const byProtocol = new Map<number, HoldPackets>(table.protocols.map((entry) => [entry.protocol, entry]))

/** The ids for a client speaking `protocol`; null where no release's report covers it. */
export const packetsFor = (protocol: number): HoldPackets | null => byProtocol.get(protocol) ?? null
