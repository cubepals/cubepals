// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How long a server made for a while lasts: from when it is made, and from when it comes back out
 * of the trash. Keeping one for good is `service.ts`'s `keep`; deleting one whose time is up is the
 * expiry sweep's (`operations/schedules/expiring.ts`).
 */
import { HOUR_MS } from '@blockly/contracts/durations'
import type { MinecraftServer } from '../../domain/server/server.ts'

/**
 * How long a server made for a while lasts. A day covers the thing people ask for — an evening
 * with friends, a modpack someone wants to try — and it is one number rather than a question
 * with options. Keeping it is one press, and Blockly says the exact time from the start.
 */
export const TEMPORARY_HOURS = 24

/**
 * How long a server in the trash lasts once restored, or null for one kept for good: the time it
 * had left when it went in, or, when its time was up by then, the time a new one starts with.
 */
export function lastsOnceRestored(server: Pick<MinecraftServer, 'expiresAt' | 'deletedAt'>): number | null {
  if (server.expiresAt === null || server.deletedAt === null) return null
  const left = server.expiresAt.getTime() - server.deletedAt.getTime()
  return left > 0 ? left : TEMPORARY_HOURS * HOUR_MS
}
