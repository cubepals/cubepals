import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { UnsecuredJWT } from 'jose'
import { ensureStanding } from '../../app/accounts/persistence.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { type Auth, authHandler, createAuth } from './better-auth.ts'

/** The "Continue with Google" button, as the sign-in page sends it, with the Terms agreed to. */
const GOOGLE_BUTTON = {
  provider: 'google',
  callbackURL: '/servers',
  newUserCallbackURL: '/servers/new',
  errorCallbackURL: '/sign-in',
  additionalData: { agreement: { terms: TERMS_VERSION } },
}

/** The environment's canonical web origin: the only callback its Google client registers. */
const CANONICAL = 'https://staging.blockly.test'
/** A preview deployment of the web app, matching the team's pattern. */
const PREVIEW = 'https://blockly-git-feature-team.vercel.app'
/** Where the web tier's rewrite delivers every request: the api's own host. */
const API = 'http://api.internal:4000'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

// Google sign-in from a preview deployment (§14): the real Better Auth and oAuthProxy, requests
// arriving as the rewrite delivers them, and a stand-in only for Google's token endpoint, which
// answers the code exchange the canonical callback makes.
describe.skipIf(!hasDatabase)('OAuth from preview deployments', () => {
  let h: Harness
  let auth: Auth
  let handle: (request: Request) => Promise<Response>
  const realFetch = globalThis.fetch
  const exchanges: URLSearchParams[] = []
  let person = { sub: '', email: '' }

  beforeAll(async () => {
    h = await startHarness()
    auth = createAuth({
      clientAddressHeader: 'x-blockly-client-address',
      db: h.db,
      mailer: { send: async () => {} },
      canonicalOrigin: CANONICAL,
      trustedOrigins: ['https://blockly-*-team.vercel.app'],
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      cookiePrefix: 'blockly-test',
      github: null,
      google: { clientId: 'google-client', clientSecret: 'google-secret' },
      oauthProxy: { secret: 'a-proxy-secret-for-this-environment' },
      onAccountCreated: (userId) => ensureStanding(h.db, userId),
    })
    handle = authHandler(auth)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== GOOGLE_TOKEN) return realFetch(input, init)
      exchanges.push(new URLSearchParams(String(init?.body ?? '')))
      const idToken = new UnsecuredJWT({
        ...person,
        email_verified: true,
        name: 'Preview Tester',
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
        scope: 'openid email profile',
        id_token: idToken,
      })
    }) as typeof fetch
  }, 30_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await h.close()
  })

  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
  const hasSession = (response: Response) =>
    response.headers.getSetCookie().some((c) => c.includes('session_token='))
  /** The sign-in button: a fetch from the page's origin, through its /api rewrite. */
  const startGoogle = async (origin: string) => {
    const response = await handle(
      new Request(`${API}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(GOOGLE_BUTTON),
      }),
    )
    expect(response.status).toBe(200)
    const google = new URL(((await response.json()) as { url: string }).url)
    return { google, cookie: cookieOf(response) }
  }
  /** Google sends the browser to the callback it registered, on the canonical origin. */
  const googleReturns = (state: string, cookie = '') =>
    handle(
      new Request(`${API}/api/auth/callback/google?code=granted&state=${encodeURIComponent(state)}`, {
        headers: cookie ? { cookie } : {},
      }),
    )
  const signInAs = () => {
    person = { sub: `google-${randomUUID()}`, email: `preview-${randomUUID().slice(0, 8)}@example.test` }
    return person
  }

  test('a preview signs in through the canonical callback and gets the session itself', async () => {
    const { email } = signInAs()
    const { google } = await startGoogle(PREVIEW)
    expect(`${google.origin}${google.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(google.searchParams.get('redirect_uri')).toBe(`${CANONICAL}/api/auth/callback/google`)

    const back = await googleReturns(google.searchParams.get('state') ?? '')
    expect(back.status).toBe(302)
    expect(exchanges.at(-1)?.get('redirect_uri')).toBe(`${CANONICAL}/api/auth/callback/google`)
    // The canonical origin makes no session of its own: it hands the profile to the preview.
    expect(hasSession(back)).toBe(false)
    const handoff = new URL(back.headers.get('location') ?? '')
    expect(`${handoff.origin}${handoff.pathname}`).toBe(`${PREVIEW}/api/auth/callback/google/oauth-proxy`)

    // The browser follows it to the preview, whose rewrite delivers it like any other request.
    const done = await handle(new Request(`${API}${handoff.pathname}${handoff.search}`))
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe('/servers/new')
    expect(hasSession(done)).toBe(true)
    const session = await handle(
      new Request(`${API}/api/auth/get-session`, { headers: { cookie: cookieOf(done) } }),
    )
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(email)

    // The hand-off works once, and only briefly.
    const replay = await handle(new Request(`${API}${handoff.pathname}${handoff.search}`))
    expect(hasSession(replay)).toBe(false)
  })

  test('the canonical origin signs in directly, without the hand-off', async () => {
    const { email } = signInAs()
    const { google, cookie } = await startGoogle(CANONICAL)
    expect(google.searchParams.get('redirect_uri')).toBe(`${CANONICAL}/api/auth/callback/google`)
    const back = await googleReturns(google.searchParams.get('state') ?? '', cookie)
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).not.toContain('oauth-proxy')
    expect(hasSession(back)).toBe(true)
    const session = await handle(
      new Request(`${API}/api/auth/get-session`, { headers: { cookie: cookieOf(back) } }),
    )
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(email)
  })

  test('an origin outside the pattern never receives a profile', async () => {
    signInAs()
    const { google } = await startGoogle('https://blockly-evil.vercel.app')
    const back = await googleReturns(google.searchParams.get('state') ?? '')
    const handoff = new URL(back.headers.get('location') ?? '')
    expect(handoff.origin).toBe(CANONICAL)
  })
})
