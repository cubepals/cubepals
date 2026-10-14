// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The pictures owners gave their servers, as the database keeps them: a few per server. */
import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, desc, eq, ne, notInArray } from 'drizzle-orm'

/** A picture an owner gave their server, as Blockly keeps it and hands it to Minecraft. */
export interface OwnIcon {
  png: Buffer
  sha256: string
}

const icons = schema.serverIcons
const servers = schema.minecraftServers

/**
 * How many of a server's pictures are kept: the one it shows and a few before it, which a machine
 * that restarts on the configuration it booted with may still ask for.
 */
const KEPT = 5

/**
 * What an owner's save sends for the picture, kept and turned into the server's change: a new
 * picture's hash, null when it takes the owner's own away, nothing when it leaves it be.
 */
export async function keepSentIcon(
  tx: Tx,
  server: { id: string; ownIcon: string | null },
  icon: OwnIcon | null | undefined,
): Promise<{ ownIcon?: string | null }> {
  if (icon === undefined) return {}
  const next = icon?.sha256 ?? null
  if (next === server.ownIcon) return {}
  if (icon !== null) await storeOwnIcon(tx, server.id, icon)
  return { ownIcon: next }
}

/** Keeps a picture for a server, as its newest; giving the same one again makes it newest again. */
async function storeOwnIcon(tx: Tx, serverId: string, icon: OwnIcon): Promise<void> {
  const now = new Date()
  await tx
    .insert(icons)
    .values({ serverId, sha256: icon.sha256, png: icon.png, createdAt: now })
    .onConflictDoUpdate({ target: [icons.serverId, icons.sha256], set: { createdAt: now } })
  const newest = tx
    .select({ sha256: icons.sha256 })
    .from(icons)
    .where(eq(icons.serverId, serverId))
    .orderBy(desc(icons.createdAt))
    .limit(KEPT)
  await tx.delete(icons).where(and(eq(icons.serverId, serverId), notInArray(icons.sha256, newest)))
}

/** One server's picture by its hash; another server's, or a purged one's, is never found. */
export async function loadOwnIcon(q: Queryable, serverId: string, sha256: string): Promise<Buffer | null> {
  const [row] = await q
    .select({ png: icons.png })
    .from(icons)
    .innerJoin(servers, eq(servers.id, icons.serverId))
    .where(and(eq(icons.serverId, serverId), eq(icons.sha256, sha256), ne(servers.status, 'purged')))
  return row?.png ?? null
}
