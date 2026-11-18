// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The packet ids the dialog hold speaks, and how its release lays out the two packets the hold
 * writes itself, by the client's protocol number, as each release's own server gives them
 * (`hold-packets.json`, made by `bun scripts/hold-packets.ts bump`). Not for how the packets are
 * written (`dialog-hold.ts`).
 */
import table from './hold-packets.json' with { type: 'json' }

/**
 * The layouts of Login Finished the hold can write: the game profile; then, from 26.2, a session
 * uuid; then, from 26.4, the connection options byte.
 */
export const LOGIN_FINISHED_LAYOUTS = ['profile', 'profile+session', 'profile+session+options'] as const
/** The layouts of Transfer the hold can write: host and port; then, from 26.4, query properties. */
export const TRANSFER_LAYOUTS = ['host+port', 'host+port+properties'] as const

export interface Layouts {
  loginFinished: (typeof LOGIN_FINISHED_LAYOUTS)[number]
  transfer: (typeof TRANSFER_LAYOUTS)[number]
}

export interface HoldPackets {
  login: { finished: number; acknowledged: number }
  configuration: {
    disconnect: number
    keepAlive: number
    showDialog: number
    transfer: number
    keepAliveAnswer: number
  }
  layouts: Layouts
}

const known = <T extends string>(list: readonly T[], value: unknown): value is T =>
  (list as readonly unknown[]).includes(value)

/** An entry of the table as the hold can use it; null where it lacks a layout the hold can write. */
function usable(entry: (typeof table.protocols)[number]): HoldPackets | null {
  const layouts: { loginFinished?: unknown; transfer?: unknown } = 'layouts' in entry ? entry.layouts : {}
  if (!known(LOGIN_FINISHED_LAYOUTS, layouts.loginFinished) || !known(TRANSFER_LAYOUTS, layouts.transfer))
    return null
  return { ...entry, layouts: { loginFinished: layouts.loginFinished, transfer: layouts.transfer } }
}

const byProtocol = new Map<number, HoldPackets>()
for (const entry of table.protocols) {
  const packets = usable(entry)
  if (packets !== null) byProtocol.set(entry.protocol, packets)
}

/** The ids and layouts for a client speaking `protocol`; null where no release's report covers it. */
export const packetsFor = (protocol: number): HoldPackets | null => byProtocol.get(protocol) ?? null
