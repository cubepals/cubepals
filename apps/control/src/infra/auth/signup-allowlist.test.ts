// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SIGNUP_ALLOWLIST through the real Better Auth: a listed address and one at a listed domain get
 * an account, anyone else is refused with nothing written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { ensureStanding } from '../../app/accounts/persistence.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { authMail } from '../../testing/outbox.ts'
import { authHandler, createAuth, listed } from './better-auth.ts'

const ORIGIN = 'https://blockly.test'

let h: Harness
let handle: (request: Request) => Promise<Response>

beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness()
  handle = authHandler(
    createAuth({
      clientAddressHeader: 'x-blockly-client-address',
      db: h.db,
      ...authMail(),
      canonicalOrigin: ORIGIN,
      trustedOrigins: [],
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      cookiePrefix: 'blockly-test',
      github: null,
      google: null,
      oauthProxy: null,
      signupAllowlist: ['dev@team.test', '@check.test'],
      onAccountCreated: (userId) => ensureStanding(h.db, userId),
    }),
  )
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await h.close()
})

const signUp = (email: string) =>
  handle(
    new Request('http://api.internal:4000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'a-long-enough-password',
        name: '',
        agreement: { terms: TERMS_VERSION },
      }),
    }),
  )
const accountFor = async (email: string) =>
  (await h.db.select().from(schema.users).where(eq(schema.users.email, email))).length

test('an address is listed by itself or by its domain, in any case', () => {
  expect(listed(['dev@team.test', '@check.test'], 'Dev@Team.test')).toBe(true)
  expect(listed(['dev@team.test', '@check.test'], 'anyone@check.test')).toBe(true)
  expect(listed(['dev@team.test', '@check.test'], 'dev@team.test.evil')).toBe(false)
  expect(listed(['dev@team.test', '@check.test'], 'someone@team.test')).toBe(false)
})

describe.skipIf(!hasDatabase)('sign-up with an allowlist', () => {
  test('listed addresses get an account, anyone else is refused with nothing written', async () => {
    const domain = `c-${randomUUID().slice(0, 8)}@check.test`
    expect((await signUp(domain)).status).toBe(200)
    expect(await accountFor(domain)).toBe(1)

    const stranger = `s-${randomUUID().slice(0, 8)}@example.test`
    const refused = await signUp(stranger)
    expect(refused.status).toBe(403)
    expect(await accountFor(stranger)).toBe(0)
  })
})
