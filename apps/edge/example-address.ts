// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' example address (`EXAMPLE_ADDRESS`), shown in Cubepals' pages and ads. No server has
 * it and no player can take it (the control plane holds it, `held-names.ts`), so the edge answers
 * it itself: the server list hears what it is, and a join where to make a server of one's own.
 * mc-router sends it to the agent's sleeping notice (`mappings.ts`), which asks here what to say.
 * A browser at it goes home, as at any address no server has (`browser-redirect.ts`).
 */
// Copied into the image beside the agent (Dockerfile): the example address, written once.
import { EXAMPLE_ADDRESS } from '../../packages/contracts/src/example-address.ts'
import { hostnameOf, type NoticeText } from './notice.ts'

/** What the example address is answered with: the server list's two lines, and a join's message. */
export const EXAMPLE: NoticeText = {
  status: process.env.EXAMPLE_MOTD ?? 'Just an example address\nMake your own at cubepals.com',
  join:
    process.env.EXAMPLE_JOIN ??
    'You found our example address. Make a server of your own at cubepals.com and send your friends its address.',
}

/**
 * What a connection that dialled `address` is told, where it dialled the example address and no
 * server's route names that hostname (`known`); null for any other address.
 */
export function exampleAt(address: string, known: ReadonlySet<string>): NoticeText | null {
  const hostname = hostnameOf({ address })
  return hostname.split('.')[0] === EXAMPLE_ADDRESS && !known.has(hostname) ? EXAMPLE : null
}
