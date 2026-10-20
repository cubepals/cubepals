// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Google sign-up coming back with its state, through the real Better Auth, against a browser that
 * keeps each cookie only as long as its Max-Age says. Someone new to Google can spend minutes there
 * (signing in to it, agreeing to share their name), and still gets in; the trips that can't (another
 * browser, two tabs, past the state's ten minutes, a callback loaded twice) come back with the code
 * the page starts again on (apps/web/src/app/(auth)/restart.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { UnsecuredJWT } from 'jose'
import { ensureStanding } from '../../app/accounts/persistence.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { authMail } from '../../testing/outbox.ts'
import { authHandler, createAuth } from './better-auth.ts'

const ORIGIN = 'https://blockly.test'
const API = 'http://api.internal:4000'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

/** A browser's cookies for the site: each kept until its Max-Age runs out, as a browser keeps it. */
class Browser {
  private cookies = new Map<string, { value: string; until: number }>()
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim())
      const name = pair.slice(0, pair.indexOf('='))
      const value = pair.slice(pair.indexOf('=') + 1)
      const maxAge = attributes.find((a) => a.toLowerCase().startsWith('max-age='))
      const until = maxAge ? Date.now() + Number(maxAge.split('=')[1]) * SECOND_MS : Number.POSITIVE_INFINITY
      if (until <= Date.now()) this.cookies.delete(name)
      else this.cookies.set(name, { value, until })
    }
  }
  header() {
    return [...this.cookies]
      .filter(([, cookie]) => cookie.until > Date.now())
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join('; ')
  }
}

describe.skipIf(!hasDatabase)('the state a Google sign-in comes back with', () => {
  let h: Harness
  let handle: (request: Request) => Promise<Response>
  const realFetch = globalThis.fetch
  let person = { sub: '', email: '' }

  beforeAll(async () => {
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
        google: { clientId: 'google-client', clientSecret: 'google-secret' },
        oauthProxy: null,
        onAccountCreated: (userId) => ensureStanding(h.db, userId),
      }),
    )
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== GOOGLE_TOKEN) return realFetch(input, init)
      const idToken = new UnsecuredJWT({
        ...person,
        email_verified: true,
        name: 'New Player',
        iss: 'https://accounts.google.com',
        aud: 'google-client',
      })
        .setIssuedAt()
        .setExpirationTime('1h')
        .encode()
      return Response.json({
        access_token: 'ya29.test',
        expires_in: 3599,
        token_type: 'Bearer',
        id_token: idToken,
      })
    }) as typeof fetch
  }, 30_000)

  afterEach(() => setSystemTime())
  afterAll(async () => {
    globalThis.fetch = realFetch
    await h.close()
  })

  /** "Continue with Google" on the sign-up page: the state Google is sent off with. */
  const start = async (browser: Browser) => {
    person = { sub: `google-${randomUUID()}`, email: `new-${randomUUID().slice(0, 8)}@example.test` }
    const response = await handle(
      new Request(`${API}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: browser.header() },
        body: JSON.stringify({
          provider: 'google',
          callbackURL: '/servers',
          newUserCallbackURL: '/servers/new',
          errorCallbackURL: '/sign-up?via=google',
          additionalData: { agreement: { terms: TERMS_VERSION } },
        }),
      }),
    )
    browser.take(response)
    return new URL(((await response.json()) as { url: string }).url).searchParams.get('state') ?? ''
  }
  /** Google sends the browser back to the callback with the state it was given. */
  const back = async (browser: Browser, state: string) => {
    const response = await handle(
      new Request(`${API}/api/auth/callback/google?code=granted&state=${encodeURIComponent(state)}`, {
        headers: { cookie: browser.header() },
      }),
    )
    browser.take(response)
    return new URL(response.headers.get('location') ?? '', ORIGIN)
  }
  const at = (url: URL) => `${url.pathname}${url.search}`

  const account = async () =>
    (await h.db.select().from(schema.users).where(eq(schema.users.email, person.email))).length

  test('a first sign-up that takes six minutes at Google gets in', async () => {
    const browser = new Browser()
    const state = await start(browser)
    setSystemTime(Date.now() + 6 * MINUTE_MS)
    expect(at(await back(browser, state))).toBe('/servers/new')
    expect(await account()).toBe(1)
  })

  test('one that comes back after the state is gone is marked as lost, with nothing made', async () => {
    const browser = new Browser()
    const state = await start(browser)
    setSystemTime(Date.now() + 11 * MINUTE_MS)
    expect(at(await back(browser, state))).toBe('/sign-up?via=google&error=state_mismatch')
    expect(await account()).toBe(0)
  })

  test('one that comes back in another browser than the page is marked as lost', async () => {
    const state = await start(new Browser())
    expect(at(await back(new Browser(), state))).toBe('/sign-up?via=google&error=state_mismatch')
  })

  test('of two tabs, the one started first is marked as lost', async () => {
    const browser = new Browser()
    const first = await start(browser)
    const second = await start(browser)
    expect(at(await back(browser, first))).toBe('/sign-up?via=google&error=state_mismatch')
    expect(at(await back(browser, second))).toBe('/servers/new')
  })

  test('a callback loaded twice lands on plain sign-in, the account already made', async () => {
    const browser = new Browser()
    const state = await start(browser)
    const cookie = browser.header()
    await back(browser, state)
    // The browser kept the second answer, not the first: it holds the state cookie, no session.
    const reloaded = new Browser()
    reloaded.take(new Response(null, { headers: { 'set-cookie': cookie } }))
    expect(at(await back(reloaded, state))).toBe('/sign-in?error=state_mismatch')
    expect(await account()).toBe(1)
  })
})
