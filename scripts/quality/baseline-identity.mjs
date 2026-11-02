// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Bind baseline reuse to exact source, protected tooling, runner configuration and calendar. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { HOUR_MS } from '../../packages/contracts/src/durations.ts'
import { legacyCalendarCases } from './legacy-calendar-case.mjs'
import { git } from './partition-plan.mjs'

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function calendarKey(at = new Date()) {
  if (!Number.isFinite(+at)) throw new Error('Invalid baseline calendar')
  const month = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)
  return `${at.toISOString().slice(0, 10)}-${legacyCalendarCases.map((entry) => Number(+at - month < entry.hours * HOUR_MS)).join('')}`
}

export const cacheAllowed = (at = new Date()) =>
  Number.isFinite(+at) && at.getUTCDate() !== 1 && at.getUTCHours() !== 23

export function runtimeIdentity() {
  return {
    node: process.version,
    bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(),
    platform: platform(),
    arch: arch(),
    imageOS: process.env.ImageOS ?? '',
    imageVersion: process.env.ImageVersion ?? '',
    lang: process.env.LANG ?? '',
    timezone: process.env.TZ ?? '',
  }
}

export function measurementFingerprint(root, runtime = runtimeIdentity()) {
  const files = git(root, 'ls-files', '-z')
    .split('\0')
    .filter(
      (path) =>
        path &&
        (path.startsWith('scripts/quality/') ||
          path.startsWith('.github/workflows/') ||
          /(?:^|\/)(?:package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json)$/.test(path) ||
          ['apps/edge/Dockerfile', 'packages/contracts/src/durations.ts', '.node-version'].includes(path)),
    )
    .sort()
  const inputs = files.map((path) => {
    const absolute = join(root, path)
    if (!lstatSync(absolute).isFile())
      throw new Error(`Baseline configuration is not a regular file: ${path}`)
    return [path, digest(readFileSync(absolute))]
  })
  return digest(JSON.stringify({ version: 1, runtime, inputs }))
}

export function baselineIdentity(root, source, at = new Date(), runtime = runtimeIdentity()) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Baseline source must be an exact commit SHA')
  const fingerprint = measurementFingerprint(root, runtime)
  const calendar = calendarKey(at)
  return {
    version: 1,
    source,
    fingerprint,
    calendar,
    key: `baseline-v1-${source}-${fingerprint}-${calendar}`,
  }
}

/** These fields are normalized from GitHub's run API, never trusted from a downloaded manifest. */
export function trustedProducer(run, repository, repositoryId) {
  return (
    run?.conclusion === 'success' &&
    run.branch === 'main' &&
    ['push', 'workflow_dispatch'].includes(run.event) &&
    run.workflow === '.github/workflows/ci.yml' &&
    run.repository === repository &&
    String(run.repositoryId) === String(repositoryId) &&
    Number.isSafeInteger(run.id) &&
    /^[a-f0-9]{40}$/.test(run.head ?? '')
  )
}
