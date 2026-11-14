// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hosts servers booted on, where their runtime names the host: one row a host, with the CPU
 * its machines read there (`app/runtimes/hosts.ts`). Not which server is on which host: a boot's
 * own record keeps that, in its operation's steps.
 */
import { integer, pgTable, primaryKey, real, text } from 'drizzle-orm/pg-core'
import { ts } from './columns.ts'

/**
 * A host by its provider's own names: the provider's region, and its name for the host there
 * (on Fly, the zone of a volume). The clock is kept as the last reading and as the least and the
 * most ever read, since a name that reads both slow and fast is not one kind of host.
 */
export const runtimeHosts = pgTable(
  'runtime_hosts',
  {
    provider: text('provider').notNull(),
    region: text('region').notNull(),
    host: text('host').notNull(),
    /** The CPU's model as the last machine read it there; null where it named none. */
    model: text('model'),
    /** The clock in MHz: as last read, and the least and the most of every reading. */
    mhz: real('mhz').notNull(),
    mhzMin: real('mhz_min').notNull(),
    mhzMax: real('mhz_max').notNull(),
    readings: integer('readings').notNull().default(1),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.region, t.host] })],
)
