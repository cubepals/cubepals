// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' version numbers, read from the repository's tags rather than kept in a file, so that
 * nothing has to commit to `main` to release.
 *
 * - A production deploy is `vX.Y.Z`: the last one's patch plus one, or 0.1.0 for the first.
 * - A nightly is the version production would get next, the date and the run:
 *   `v0.1.4-nightly.20261009.12`. It is tagged once staging has run that commit and passed its check.
 *
 * Production deploys only a commit a nightly passed (production.ts), so a version that reaches
 * players has run on staging first.
 *
 *   bun scripts/versions.ts nightly <run>   the tag tonight's nightly would take
 */
import { spawnSync } from 'node:child_process'

const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/
const NIGHTLY = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/

/** The newest production version among `tags`, or null before the first. */
export function latestStable(tags: readonly string[]): string | null {
  let best: [number, number, number] | null = null
  for (const tag of tags) {
    const match = STABLE.exec(tag)
    if (!match) continue
    const version: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (best === null || compare(version, best) > 0) best = version
  }
  return best === null ? null : `v${best.join('.')}`
}

/** The version the next production deploy takes. */
export function nextVersion(tags: readonly string[]): string {
  const latest = latestStable(tags)
  if (latest === null) return '0.1.0'
  const [major, minor, patch] = latest.slice(1).split('.').map(Number)
  return `${major}.${minor}.${(patch ?? 0) + 1}`
}

/** A nightly's tag: the next version, the day it ran (UTC) and the workflow's run number. */
export function nightlyTag(tags: readonly string[], day: Date, run: number): string {
  const date = day.toISOString().slice(0, 10).replaceAll('-', '')
  return `v${nextVersion(tags)}-nightly.${date}.${run}`
}

export const isNightly = (tag: string) => NIGHTLY.test(tag)

/** Every tag the checkout knows. */
export function repositoryTags(): string[] {
  const result = spawnSync('git', ['tag', '--list'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git tag: ${result.stderr.trim()}`)
  return result.stdout.split('\n').filter(Boolean)
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

if (import.meta.main) {
  const [command, run] = process.argv.slice(2)
  if (command === 'nightly' && run && /^\d+$/.test(run)) {
    process.stdout.write(`${nightlyTag(repositoryTags(), new Date(), Number(run))}\n`)
  } else {
    process.stdout.write('Usage: bun scripts/versions.ts nightly <run>\n')
    process.exit(1)
  }
}
