// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signs the Bedrock test account in for the Bedrock check, or forgets its sign-in. A maintainer
 * runs it, with STAGING_STATE in the environment (or local/staging/state.json), when the nightly
 * says the account must be signed in again, and once at the start.
 *
 *   bun scripts/bedrock-xbox-sign-in.ts            sign in, and store the sign-in for CI
 *   bun scripts/bedrock-xbox-sign-in.ts --forget   delete the stored sign-in
 *
 * Signing in prints Microsoft's address and a code: whoever holds the dedicated test account (never
 * a person's own account) opens it and signs in. The sign-in, prismarine-auth's cache directory,
 * is then sealed with a key derived from staging's auth secret and stored in staging's bucket
 * (`lib/xbox-sign-in-store.ts`), and the account's gamertag is printed. Nothing secret is printed or
 * written outside a private directory, which is deleted after.
 *
 * How the sign-in lasts: prismarine-auth renews the Microsoft token from its refresh token on each
 * use, and the nightly writes the renewed one back, so it lasts while the nightly runs. It ends when
 * the account's owner revokes it (account.microsoft.com, Privacy, "Apps and services" that can
 * access the account; or a new password, or signing out everywhere), when it goes unused for
 * Microsoft's refresh-token lifetime (about 90 days), when staging's auth secret changes, or with
 * --forget. Then the nightly's step fails with one line naming this command, and running it is the
 * whole fix.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quietEnv } from './lib/bedrock-client.ts'
import { bucketStore, readCache, seal, sealingKey } from './lib/xbox-sign-in-store.ts'
import type { Bucket } from './preview-uploads.ts'

const STATE_FILE = 'local/staging/state.json'
const state = JSON.parse(
  existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf8') : (process.env.STAGING_STATE ?? '{}'),
) as { authSecret?: string; bucket?: Bucket }
if (state.authSecret === undefined || state.bucket === undefined) {
  console.error(
    'No staging state with an auth secret and a bucket: set STAGING_STATE, or run bun scripts/staging.ts up.',
  )
  process.exit(2)
}
const store = bucketStore(state.bucket)

if (process.argv.includes('--forget')) {
  await store.forget()
  process.stdout.write(
    `${'The stored Xbox sign-in is deleted; the Bedrock check fails until the account signs in again.'}\n`,
  )
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'bedrock-xbox-'))
try {
  // Microsoft's address and code go to the terminal; the last line out is the gamertag.
  const child = Bun.spawn(['bun', 'xbox-sign-in.ts', '--cache', dir], {
    cwd: 'tools/bedrock-join',
    stdout: 'pipe',
    stderr: 'inherit',
    env: quietEnv(),
  })
  const [out, exited] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (exited !== 0) {
    console.error('The sign-in did not finish; nothing was stored.')
    process.exitCode = 1
  } else {
    await store.put(seal(readCache(dir), sealingKey(state.authSecret)))
    process.stdout.write(
      `${`Signed in as ${out.trim().split('\n').at(-1) ?? '?'}, and stored for the Bedrock check.`}\n`,
    )
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
