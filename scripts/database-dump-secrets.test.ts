// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * On cubepals/cubepals' own Actions runs, the nightly Database dump fails when none of its values
 * reached it. GitHub gives a secret that isn't there as an empty string, so a `production`
 * environment that was renamed, deleted or recreated, or secrets removed while rotating them,
 * must fail the run and email, not pass it with no dump taken.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./database-dump.ts', import.meta.url))

describe('the nightly dump with its secrets gone', () => {
  test('fails the run rather than passing it', () => {
    // As the workflow runs it once the environment's secrets are gone: each one an empty string.
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'cubepals/cubepals',
        GITHUB_EVENT_NAME: 'schedule',
        DATABASE_URL: '',
        DUMP_S3_ENDPOINT: '',
        DUMP_S3_BUCKET: '',
        DUMP_S3_ACCESS_KEY_ID: '',
        DUMP_S3_SECRET_ACCESS_KEY: '',
      },
    })
    expect(result.status).not.toBe(0)
  })

  test('still passes, saying so, where nothing was ever set up: a fork or a local run', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'someone/cubepals' },
    })
    expect(result.stdout).toContain("isn't set up")
    expect(result.status).toBe(0)
  })
})
