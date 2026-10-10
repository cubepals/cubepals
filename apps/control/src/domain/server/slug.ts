// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's slug is the only addressing state Blockly owns. The address people type is the slug
 * plus deployment configuration, so a slug must be a valid DNS label on its own.
 */

declare const slugBrand: unique symbol
export type Slug = string & { readonly [slugBrand]: true }

const PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/

/** Names a platform might use for its own hosts under any domain. Never handed to a server. */
const RESERVED: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'blockly',
  'cdn',
  'console',
  'cubepals',
  'dashboard',
  'docs',
  'edge',
  'help',
  'internal',
  'mail',
  'play',
  'realtime',
  'rt',
  'static',
  'status',
  'support',
  'www',
])

export type SlugProblem = 'too_short' | 'too_long' | 'bad_characters' | 'reserved'

export function checkSlug(candidate: string): { ok: true; slug: Slug } | { ok: false; problem: SlugProblem } {
  if (candidate.length < 3) return { ok: false, problem: 'too_short' }
  if (candidate.length > 40) return { ok: false, problem: 'too_long' }
  if (!PATTERN.test(candidate) || candidate.includes('--')) return { ok: false, problem: 'bad_characters' }
  if (RESERVED.has(candidate)) return { ok: false, problem: 'reserved' }
  return { ok: true, slug: candidate as Slug }
}

/** Turns a server name into the slug people would expect: "Sunset Valley!" → "sunset-valley". */
/**
 * A name turned into something that can be a DNS label. `@sindresorhus/slugify` does this, and
 * better — but the domain layer imports no packages at all (`scripts/check-boundaries.ts`), so
 * that it stays a description of Blockly's rules rather than of somebody's library. Checked
 * 2026-09-23 and kept deliberately: the boundary is worth more here than the edge cases, and
 * what a slug may be is Blockly's rule either way (`checkSlug`, `RESERVED`).
 */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

/**
 * Candidates to try in order when the preferred slug is taken or unusable. The caller checks
 * availability; this stays pure.
 */
export function slugCandidates(name: string, random: () => number): string[] {
  const base = slugFromName(name)
  const stem = checkSlug(base).ok ? base : 'world'
  const suffix = () => Math.floor(random() * 9000 + 1000).toString()
  const trimmed = stem.slice(0, 35).replace(/-+$/g, '')
  return [stem, ...Array.from({ length: 5 }, () => `${trimmed}-${suffix()}`)].filter((s) => checkSlug(s).ok)
}
