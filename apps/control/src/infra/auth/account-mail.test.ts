// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What sign-in sends, through the real Better Auth handler on a real database: each email with an
 * HTML part whose pictures load from the web origin, and one welcome once an account is ready.
 * Ready is an email sign-up that confirmed its address, or an account Google or GitHub made with
 * an address they vouch for; the provider's round trip itself is github-sign-in.test.ts's, so here
 * the account is made with the call that round trip makes (`internalAdapter.createUser`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { ensureStanding } from '../../app/accounts/persistence.ts'
import type { Mailer } from '../../app/ports/platform.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { authMail, Outbox } from '../../testing/outbox.ts'
import { type Auth, createAuth } from './better-auth.ts'

const ORIGIN = 'http://localhost:3000'
const WELCOME = 'Welcome to Cubepals'
const CONFIRM = 'Confirm your email for Cubepals'
/** Where an account a provider's round trip makes says it came from. */
const FROM_GOOGLE = { method: 'oauth', oauth: { providerId: 'google' } } as const

let h: Harness
let auth: Auth
const outbox = new Outbox()

/** Better Auth as main.node.ts makes it, its mail going to `mailer`. */
const authWith = (mailer: Mailer): Auth =>
  createAuth({
    clientAddressHeader: 'x-blockly-client-address',
    db: h.db,
    ...authMail(),
    mailer,
    canonicalOrigin: ORIGIN,
    trustedOrigins: [],
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    cookiePrefix: 'blockly-test',
    github: null,
    google: null,
    oauthProxy: null,
    onAccountCreated: (userId) => ensureStanding(h.db, userId),
  })

const address = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@example.test`
const subjects = (email: string) => outbox.to(email).map((m) => m.subject)
const signUp = (to: Auth, email: string) =>
  to.handler(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'a-long-enough-password',
        name: 'New',
        callbackURL: '/servers/new',
        agreement: { terms: TERMS_VERSION },
      }),
    }),
  )
const follow = (to: Auth, link: string) => to.handler(new Request(link, { redirect: 'manual' }))

describe.skipIf(!hasDatabase)('account mail', () => {
  beforeAll(async () => {
    h = await startHarness()
    auth = authWith(outbox)
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('an email sign-up is welcomed once it confirms its email, and only once', async () => {
    const email = address('welcome')
    expect((await signUp(auth, email)).status).toBe(200)
    // Not ready yet: only the confirmation goes out.
    expect(subjects(email)).toEqual([CONFIRM])
    const link = outbox.link(email)

    expect((await follow(auth, link)).status).toBe(302)
    const welcome = outbox.to(email).at(-1)
    expect(welcome?.subject).toBe(WELCOME)
    expect(welcome?.text).toContain(`${ORIGIN}/servers/new`)
    expect(welcome?.html).toContain(`<img src="${ORIGIN}/email/moss-waving.gif"`)

    // The same link again confirms nothing new, and welcomes nobody twice.
    await follow(auth, link)
    expect(subjects(email)).toEqual([CONFIRM, WELCOME])
  })

  test('an account a provider made with an address it vouches for is welcomed at once', async () => {
    const context = await auth.$context
    const vouched = address('google')
    await context.internalAdapter.createUser({ email: vouched, name: 'V', emailVerified: true }, FROM_GOOGLE)
    expect(subjects(vouched)).toEqual([WELCOME])

    // One the provider didn't vouch for waits for its confirmation, like an email sign-up.
    const unvouched = address('google-unvouched')
    await context.internalAdapter.createUser(
      { email: unvouched, name: 'U', emailVerified: false },
      FROM_GOOGLE,
    )
    expect(subjects(unvouched)).toEqual([])
  })

  test('every email sign-in sends has an HTML part on the web origin', async () => {
    const email = address('html')
    await signUp(auth, email)
    await auth.handler(
      new Request(`${ORIGIN}/api/auth/request-password-reset`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email, redirectTo: '/reset-password' }),
      }),
    )
    const [confirm, reset] = outbox.to(email)
    expect(confirm?.html).toContain(`<img src="${ORIGIN}/email/worker-clipboard.png"`)
    expect(reset?.subject).toBe('Reset your Cubepals password')
    expect(reset?.html).toContain(`<img src="${ORIGIN}/email/lockup.png"`)
  })

  test('a welcome that fails to send fails neither the confirmation nor the account', async () => {
    const email = address('unsent')
    const failing = authWith({
      send: async (message) => {
        if (message.subject === WELCOME) throw new Error('SMTP is down')
        await outbox.send(message)
      },
    })
    expect((await signUp(failing, email)).status).toBe(200)
    const confirmed = await follow(failing, outbox.link(email))
    expect(confirmed.status).toBe(302)
    expect(confirmed.headers.getSetCookie().some((c) => c.includes('session_token='))).toBe(true)
    expect(subjects(email)).toEqual([CONFIRM])

    // Nor an account a provider made.
    const context = await failing.$context
    const made = await context.internalAdapter.createUser(
      { email: address('unsent-google'), name: 'Made', emailVerified: true },
      FROM_GOOGLE,
    )
    expect(made?.emailVerified).toBe(true)
  })
})
