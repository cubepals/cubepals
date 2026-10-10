// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// After `next build`: uploads the browser bundle's source maps to PostHog, so the errors it shows
// read as the code was written, then deletes them, so no map is served. Runs only when the build
// has POSTHOG_PERSONAL_API_KEY (a personal API key with error tracking write) and
// POSTHOG_PROJECT_ID; without them it says so and does nothing. next.config.ts emits the maps on
// the same condition.
import { spawnSync } from 'node:child_process'

const key = process.env.POSTHOG_PERSONAL_API_KEY
const project = process.env.POSTHOG_PROJECT_ID
if (!key || !project) {
  process.stdout.write(
    'sourcemaps: no POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID, so none are uploaded\n',
  )
  process.exit(0)
}

const result = spawnSync(
  'npx',
  [
    '--yes',
    '@posthog/cli@0.18.9',
    '--host',
    process.env.POSTHOG_API_HOST || 'https://eu.posthog.com',
    'sourcemap',
    'process',
    '--directory',
    '.next/static',
    '--release-name',
    'cubepals-web',
    '--release-version',
    (process.env.GIT_COMMIT_SHA ?? 'local').slice(0, 12),
    '--delete-after',
  ],
  { stdio: 'inherit', env: { ...process.env, POSTHOG_CLI_API_KEY: key, POSTHOG_CLI_PROJECT_ID: project } },
)
// A failed upload fails the build: maps left behind would be served to anyone.
process.exit(result.status ?? 1)
