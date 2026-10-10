// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { SignJWT } from 'jose'
import { ensureStanding } from '../../app/accounts/persistence.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { authMail, Outbox } from '../../testing/outbox.ts'
import { type Auth, createAuth } from './better-auth.ts'

const ORIGIN = 'http://localhost:3000'
const SECRET = 'a-test-secret-that-is-long-enough-for-better-auth'
/** A sign-up as the page sends it, with the Terms the line under its buttons links to. */
const agreeing = <T extends object>(body: T) => ({ ...body, agreement: { terms: TERMS_VERSION } })

// Email flows through the real Better Auth handler, on a real database. Password reset: the email,
// the link that lands on the web app's page, the one-time token, and everyone signed out
// afterwards. Confirmation: the link from sign-up, and a new one when that one is lost or expired.
describe.skipIf(!hasDatabase)('email flows', () => {
  let h: Harness
  let auth: Auth
  const outbox = new Outbox()

  beforeAll(async () => {
    h = await startHarness()
    auth = createAuth({
      clientAddressHeader: 'x-blockly-client-address',
      db: h.db,
      ...authMail(outbox),
      canonicalOrigin: ORIGIN,
      trustedOrigins: [],
      secret: SECRET,
      cookiePrefix: 'blockly-test',
      github: null,
      google: null,
      oauthProxy: null,
      onAccountCreated: (userId) => ensureStanding(h.db, userId),
      onPasswordReset: (userId) => h.app.accounts.passwordReset(userId),
    })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  /** A request the way the browser sends it, through the web origin. */
  const call = (path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) =>
    auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          origin: ORIGIN,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: 'manual',
      }),
    )
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
  const signIn = (email: string, password: string) => call('/sign-in/email', { body: { email, password } })
  const sessionOf = async (cookie: string) =>
    (await (await call('/get-session', { cookie })).json()) as { user: { email: string } } | null

  test('a reset link sets a new password once, and signs out every other session', async () => {
    const email = `reset-${randomUUID().slice(0, 8)}@example.test`
    const signedUp = await call('/sign-up/email', {
      body: agreeing({ email, password: 'first password 1', name: 'Reset' }),
    })
    expect(signedUp.status).toBe(200)
    const before = cookieOf(await signIn(email, 'first password 1'))
    expect((await sessionOf(before))?.user.email).toBe(email)

    const asked = await call('/request-password-reset', { body: { email, redirectTo: '/reset-password' } })
    expect(asked.status).toBe(200)
    const mail = outbox.to(email).at(-1)
    expect(mail?.subject).toBe('Reset your Cubepals password')
    const link = outbox.link(email)
    expect(link.startsWith(`${ORIGIN}/api/auth/reset-password/`)).toBe(true)

    // The emailed link sends the browser on to the web app's page, token in hand.
    const followed = await auth.handler(new Request(link, { redirect: 'manual' }))
    expect(followed.status).toBe(302)
    const landing = new URL(followed.headers.get('location') ?? '')
    expect(`${landing.origin}${landing.pathname}`).toBe(`${ORIGIN}/reset-password`)
    const token = landing.searchParams.get('token')
    expect(token).toBeTruthy()

    const tooShort = await call('/reset-password', { body: { token, newPassword: 'short' } })
    expect(tooShort.status).toBe(400)
    const reset = await call('/reset-password', { body: { token, newPassword: 'second password 2' } })
    expect(reset.status).toBe(200)

    // Once: the same link does nothing the second time.
    const again = await call('/reset-password', { body: { token, newPassword: 'third password 3' } })
    expect(again.status).toBe(400)
    expect(((await again.json()) as { code: string }).code).toBe('INVALID_TOKEN')

    expect(await sessionOf(before)).toBeNull()
    expect((await signIn(email, 'first password 1')).status).toBe(401)
    const after = cookieOf(await signIn(email, 'second password 2'))
    expect((await sessionOf(after))?.user.email).toBe(email)

    expect(outbox.to(email).at(-1)).toMatchObject({
      subject: 'Your Cubepals password was changed',
      text: expect.stringContaining(`${ORIGIN}/forgot-password`),
    })
    const [user] = await h.db.select().from(schema.users).where(eq(schema.users.email, email))
    const audit = await h.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.subjectId, user?.id ?? ''),
          eq(schema.auditLog.action, 'account.password_reset'),
        ),
      )
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actor).toBe(`user:${user?.id}`)
  })

  test('nobody learns whether an email has an account, and a bad link says so on the page', async () => {
    const before = outbox.sent.length
    const unknown = await call('/request-password-reset', {
      body: { email: `nobody-${randomUUID().slice(0, 8)}@example.test`, redirectTo: '/reset-password' },
    })
    expect(unknown.status).toBe(200)
    expect(outbox.sent.length).toBe(before)

    const forged = await auth.handler(
      new Request(`${ORIGIN}/api/auth/reset-password/not-a-token?callbackURL=%2Freset-password`, {
        redirect: 'manual',
      }),
    )
    expect(forged.status).toBe(302)
    const landing = new URL(forged.headers.get('location') ?? '')
    expect(landing.pathname).toBe('/reset-password')
    expect(landing.searchParams.get('error')).toBe('INVALID_TOKEN')

    // A link may only send people back to this deployment's own pages.
    const elsewhere = await call('/request-password-reset', {
      body: { email: 'someone@example.test', redirectTo: 'https://evil.example/reset' },
    })
    expect(elsewhere.status).toBe(403)
  })

  test('a lost or expired confirmation link can be replaced, and the new one confirms the account', async () => {
    const email = `confirm-${randomUUID().slice(0, 8)}@example.test`
    const signUp = await call('/sign-up/email', {
      body: agreeing({
        email,
        password: 'a-long-enough-password',
        name: 'Late Confirmer',
        callbackURL: '/servers/new',
      }),
    })
    expect(signUp.status).toBe(200)
    const cookie = cookieOf(signUp)
    expect(outbox.to(email).map((m) => m.subject)).toEqual(['Confirm your email for Cubepals'])
    const first = new URL(outbox.link(email))
    expect(first.searchParams.get('callbackURL')).toBe('/servers/new')

    // A link that doesn't verify, or one past its hour, lands on the page with the reason, which
    // the page turns into "That confirmation link has expired" and a way to get a new one.
    const landing = async (token: string) => {
      const response = await call(`/verify-email?token=${token}&callbackURL=%2Fservers%2Fnew`)
      expect(response.status).toBe(302)
      return response.headers.get('location')
    }
    expect(await landing('not-a-token')).toBe('/servers/new?error=INVALID_TOKEN')
    const expired = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(SECRET))
    expect(await landing(expired)).toBe('/servers/new?error=TOKEN_EXPIRED')
    expect((await sessionOf(cookie))?.user).toMatchObject({ email, emailVerified: false })

    // "Send a new link", signed in: a second email, whose link confirms the account.
    const resent = await call('/send-verification-email', {
      body: { email, callbackURL: '/servers/new' },
      cookie,
    })
    expect(resent.status).toBe(200)
    expect(outbox.to(email)).toHaveLength(2)
    const confirmed = await auth.handler(new Request(outbox.link(email), { redirect: 'manual' }))
    expect(confirmed.status).toBe(302)
    expect(confirmed.headers.get('location')).toBe('/servers/new')
    expect((await sessionOf(cookieOf(confirmed)))?.user).toMatchObject({ email, emailVerified: true })
    const [user] = await h.db.select().from(schema.users).where(eq(schema.users.email, email))
    expect(user?.emailVerified).toBe(true)

    // Nothing more to confirm, and nobody learns about an address that has no account.
    const again = await call('/send-verification-email', { body: { email }, cookie: cookieOf(confirmed) })
    expect(again.status).toBe(400)
    const before = outbox.sent.length
    const stranger = await call('/send-verification-email', {
      body: { email: `nobody-${randomUUID().slice(0, 8)}@example.test` },
    })
    expect(stranger.status).toBe(200)
    expect(outbox.sent.length).toBe(before)
  })
})
