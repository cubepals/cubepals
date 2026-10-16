// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Uploaded jars' checks as they are kept (`jar_checks`), and what they mean wherever a jar is
 * pinned, installed or handed to a server: a quarantined jar goes nowhere, and one still being
 * checked can't be added yet. A jar uploaded before checks existed has none, and runs as it did
 * until its check is done. Running the checks is `jar-checks.ts`'s.
 */
import { createHash } from 'node:crypto'
import { type Queryable, schema } from '@blockly/db'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { AppError } from '../errors.ts'

const checks = schema.jarChecks
const signatures = schema.malwareSignatures

export type JarCheck = typeof checks.$inferSelect
export type Finding = NonNullable<JarCheck['finding']>

/** The digests lists name a jar by: the bytes' own, in lowercase hex. */
export interface JarDigests {
  sha1: string
  sha256: string
  sha512: string
}

export const digestsOf = (bytes: Uint8Array): JarDigests => ({
  sha1: createHash('sha1').update(bytes).digest('hex'),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  sha512: createHash('sha512').update(bytes).digest('hex'),
})

export async function checksOf(q: Queryable, sha512s: readonly string[]): Promise<Map<string, JarCheck>> {
  if (sha512s.length === 0) return new Map()
  const rows = await q
    .select()
    .from(checks)
    .where(inArray(checks.sha512, [...new Set(sha512s)]))
  return new Map(rows.map((row) => [row.sha512, row]))
}

/** Of these jars, the ones kept out of every server. */
export async function quarantinedOf(q: Queryable, sha512s: readonly string[]): Promise<Set<string>> {
  if (sha512s.length === 0) return new Set()
  const rows = await q
    .select({ sha512: checks.sha512 })
    .from(checks)
    .where(
      and(
        inArray(checks.sha512, [...new Set(sha512s)]),
        eq(checks.state, 'quarantined'),
        isNull(checks.releasedBy),
      ),
    )
  return new Set(rows.map((row) => row.sha512))
}

/** A list's entry for one of these digests, the first by the list's name; null when none names it. */
export async function knownBad(q: Queryable, digests: Partial<JarDigests>): Promise<Finding | null> {
  const asked = (['sha1', 'sha256', 'sha512'] as const).flatMap((kind) => {
    const value = digests[kind]
    return value ? [and(eq(signatures.kind, kind), eq(signatures.value, value))] : []
  })
  if (asked.length === 0) return null
  const [row] = await q
    .select()
    .from(signatures)
    .where(or(...asked))
    .orderBy(signatures.source)
    .limit(1)
  return row ? { match: `${row.kind} ${row.value}`, family: row.family, source: row.source } : null
}

/** Whether a list says a jar it would otherwise match isn't malware. */
export async function allowed(q: Queryable, sha1: string): Promise<boolean> {
  const [row] = await q
    .select({ value: signatures.value })
    .from(signatures)
    .where(and(eq(signatures.kind, 'allow-sha1'), eq(signatures.value, sha1)))
    .limit(1)
  return row !== undefined
}

/** The sentence an owner reads for an upload Cubepals won't install; null while it may be. */
export function refusalOf(fileName: string, check: JarCheck | undefined): string | null {
  if (check === undefined || check.releasedBy !== null) return null
  if (check.state === 'quarantined') return `We didn’t install ${fileName}: it matches known malware.`
  if (check.state === 'checking') return `We’re still checking ${fileName}. Add it once that’s done.`
  return null
}

/** Refuses uploads being added that are quarantined or not yet checked. */
export async function requireInstallable(
  q: Queryable,
  uploads: ReadonlyArray<{ sha512: string; fileName: string }>,
): Promise<void> {
  const found = await checksOf(
    q,
    uploads.map((u) => u.sha512),
  )
  for (const upload of uploads) {
    const refusal = refusalOf(upload.fileName, found.get(upload.sha512))
    if (refusal !== null) throw new AppError('invalid_upload', refusal)
  }
}
