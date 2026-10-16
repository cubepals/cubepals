// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What uploaded jars were found to be before any server runs them: each jar's check by its bytes,
 * and the lists of known malware they are held to, as last fetched from where each is published.
 */
import { index, integer, jsonb, pgEnum, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { createdAt, ts } from './columns.ts'

/**
 * `checking`: not read yet, so no server may have it. `clean`: nothing found. `flagged`: it does
 * something a mod rarely needs, which operators look at; it runs. `quarantined`: known malware,
 * kept out of every server.
 */
export const jarCheckState = pgEnum('jar_check_state', ['checking', 'clean', 'flagged', 'quarantined'])

/** One jar's check, by its bytes: the same jar uploaded by two owners is checked once. */
export const jarChecks = pgTable(
  'jar_checks',
  {
    sha512: text('sha512').primaryKey(),
    /** The other digests lists name jars by; null until the jar's bytes were read for them. */
    sha256: text('sha256'),
    sha1: text('sha1'),
    state: jarCheckState('state').notNull().default('checking'),
    /** What a quarantine matched: a list's digest or one of its signatures, and the list. */
    finding: jsonb('finding').$type<{ match: string; family: string | null; source: string }>(),
    /** What the bytecode does that a mod rarely needs, for operators; never a quarantine alone. */
    flags: text('flags').array().notNull().default([]),
    /**
     * The operator who looked at a quarantined jar and found it isn't malware: lists don't
     * quarantine it again.
     */
    releasedBy: text('released_by'),
    checkedAt: ts('checked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('jar_checks_state').on(t.state)],
)

/**
 * The entries of each list of known malware: digests of whole jars, and the class names and
 * string constants a scanner matches inside them. `allow-sha1` is a list's own word that a jar
 * it would otherwise match is not malware.
 */
export const malwareSignatures = pgTable(
  'malware_signatures',
  {
    source: text('source').notNull(),
    kind: text('kind', { enum: ['sha1', 'sha256', 'sha512', 'class', 'string', 'allow-sha1'] }).notNull(),
    value: text('value').notNull(),
    family: text('family'),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.kind, t.value] }),
    index('malware_signatures_value').on(t.kind, t.value),
  ],
)

/** Each list as last fetched: its bytes' digest says whether it changed since. */
export const malwareSources = pgTable('malware_sources', {
  source: text('source').primaryKey(),
  url: text('url').notNull(),
  digest: text('digest').notNull(),
  entries: integer('entries').notNull(),
  fetchedAt: ts('fetched_at').notNull(),
})
