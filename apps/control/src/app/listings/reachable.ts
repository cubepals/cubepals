// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether strangers may reach a server: through its public page, and through its invitation. One
 * rule each, read by everything that hangs off them (the page, its status, badge and card, its
 * guestbook and stars, Report, chipping in, copying, joining), so none of them opens where another
 * says "not found". The directory's own rule, which asks more, is `listings/queries.ts`'.
 */
import type { Queryable } from '@blockly/db'
import { outOfView } from '../../domain/listing/trust.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { loadControls, loadStanding } from '../accounts/persistence.ts'
import { loadListing } from './persistence.ts'

/**
 * Whether anyone may open this server's page: its owner made it public, no admin removed it or
 * restricted the account, its name passes, public pages aren't paused, its owner is in good
 * standing, and it isn't deleted.
 */
export async function pageShown(
  q: Queryable,
  server: Pick<MinecraftServer, 'id' | 'ownerId' | 'deletedAt'>,
): Promise<boolean> {
  if (server.deletedAt !== null) return false
  const listing = await loadListing(q, server.id)
  if (listing === null || listing.visibility !== 'published' || listing.moderation !== 'clear') return false
  if (outOfView(listing.ineligibleReasons)) return false
  if (!(await loadControls(q)).publicListingEnabled) return false
  return (await loadStanding(q, server.ownerId)).status === 'active'
}

/**
 * Whether an invitation still lets people in. It is the owner's own link and works while the
 * server is private, so only a takedown or the owner's standing stops it.
 */
export async function inviteOpen(
  q: Queryable,
  server: Pick<MinecraftServer, 'id' | 'ownerId'>,
): Promise<boolean> {
  if ((await loadListing(q, server.id))?.moderation === 'removed') return false
  return (await loadStanding(q, server.ownerId)).status === 'active'
}
