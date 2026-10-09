import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { ensureStanding } from '../../app/accounts/persistence.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { type Auth, authHandler, createAuth } from './better-auth.ts'

const ORIGIN = 'https://blockly.test'
/** Where the web tier's rewrite delivers every request: the api's own host. */
const API = 'http://api.internal:4000'
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token'
const GITHUB_USER = 'https://api.github.com/user'
const GITHUB_EMAILS = 'https://api.github.com/user/emails'
/** The Terms the sign-in and sign-up pages send with a new account. */
const AGREEMENT = { terms: TERMS_VERSION }
const agreeing = <T extends object>(body: T) => ({ ...body, agreement: AGREEMENT })
/** The "Continue with GitHub" button, as the sign-in page sends it. */
const GITHUB_BUTTON = {
  provider: 'github',
  callbackURL: '/servers',
  newUserCallbackURL: '/servers/new',
  errorCallbackURL: '/sign-in?via=github',
  additionalData: { agreement: AGREEMENT },
}

// GitHub sign-in (§14, an optional provider): the real Better Auth with its GitHub provider, and
// stand-ins only for GitHub's three endpoints: the code exchange, the profile and its emails.
describe.skipIf(!hasDatabase)('GitHub sign-in', () => {
  let h: Harness
  let auth: Auth
  let handle: (request: Request) => Promise<Response>
  const realFetch = globalThis.fetch
  const exchanges: URLSearchParams[] = []
  /** The GitHub account the stand-ins answer for. */
  let person = { id: 0, login: '', email: '', verified: true }

  beforeAll(async () => {
    h = await startHarness()
    auth = createAuth({
      clientAddressHeader: 'x-blockly-client-address',
      db: h.db,
      mailer: { send: async () => {} },
      canonicalOrigin: ORIGIN,
      trustedOrigins: [],
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      cookiePrefix: 'blockly-test',
      github: { clientId: 'github-client', clientSecret: 'github-secret' },
      google: null,
      oauthProxy: null,
      onAccountCreated: (userId) => ensureStanding(h.db, userId),
    })
    handle = authHandler(auth)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === GITHUB_TOKEN) {
        exchanges.push(new URLSearchParams(String(init?.body ?? '')))
        return Response.json({
          access_token: 'gho_test',
          token_type: 'bearer',
          scope: 'read:user,user:email',
        })
      }
      if (url === GITHUB_USER)
        return Response.json({
          id: person.id,
          login: person.login,
          name: 'Octo Tester',
          email: null,
          avatar_url: null,
        })
      if (url === GITHUB_EMAILS)
        return Response.json([
          { email: person.email, primary: true, verified: person.verified, visibility: 'private' },
          {
            email: `${person.login}@users.noreply.github.com`,
            primary: false,
            verified: true,
            visibility: null,
          },
        ])
      return realFetch(input, init)
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
  /** The "Continue with GitHub" button, as the sign-in page sends it. */
  const startGitHub = async () => {
    const response = await handle(
      new Request(`${API}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(GITHUB_BUTTON),
      }),
    )
    expect(response.status).toBe(200)
    const github = new URL(((await response.json()) as { url: string }).url)
    return { github, cookie: cookieOf(response) }
  }
  /** GitHub sends the browser back to the callback the OAuth app registers. */
  const githubReturns = (query: string, cookie: string) =>
    handle(new Request(`${API}/api/auth/callback/github?${query}`, { headers: { cookie } }))
  const signInAs = (verified = true) => {
    const tag = randomUUID().slice(0, 8)
    person = {
      id: Number.parseInt(tag, 16),
      login: `octo-${tag}`,
      email: `octo-${tag}@example.test`,
      verified,
    }
    return person
  }
  const sessionOf = async (response: Response) => {
    const session = await handle(
      new Request(`${API}/api/auth/get-session`, { headers: { cookie: cookieOf(response) } }),
    )
    return (await session.json()) as { user: { id: string; email: string; emailVerified: boolean } } | null
  }

  test('a GitHub sign-in makes the account with the address GitHub confirmed, and signs in after', async () => {
    const { email } = signInAs()
    const { github, cookie } = await startGitHub()
    expect(`${github.origin}${github.pathname}`).toBe('https://github.com/login/oauth/authorize')
    expect(github.searchParams.get('client_id')).toBe('github-client')
    expect(github.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/github`)
    expect(github.searchParams.get('scope')?.split(' ')).toEqual(['read:user', 'user:email'])

    const back = await githubReturns(`code=granted&state=${github.searchParams.get('state')}`, cookie)
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/servers/new')
    expect(exchanges.at(-1)?.get('code')).toBe('granted')
    expect(exchanges.at(-1)?.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/github`)
    const first = await sessionOf(back)
    expect(first?.user).toMatchObject({ email, emailVerified: true })

    // The same GitHub account again is the same Blockly account, now an existing one.
    const again = await startGitHub()
    const returned = await githubReturns(
      `code=granted&state=${again.github.searchParams.get('state')}`,
      again.cookie,
    )
    expect(returned.headers.get('location')).toBe('/servers')
    expect((await sessionOf(returned))?.user.id).toBe(first?.user.id ?? 'missing')
  })

  test('an address GitHub has not confirmed makes an unconfirmed account, which must confirm it', async () => {
    const { email } = signInAs(false)
    const { github, cookie } = await startGitHub()
    const back = await githubReturns(`code=granted&state=${github.searchParams.get('state')}`, cookie)
    expect(back.headers.get('location')).toBe('/servers/new')
    expect((await sessionOf(back))?.user).toMatchObject({ email, emailVerified: false })
  })

  test('GitHub joins an existing account only once both sides confirmed the address', async () => {
    // An email sign-up nobody confirmed yet: GitHub vouching for the address isn't enough.
    const { email } = signInAs()
    const signUp = await handle(
      new Request(`${API}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(agreeing({ email, password: 'a-long-enough-password', name: 'Mail First' })),
      }),
    )
    expect(signUp.status).toBe(200)
    const refused = await startGitHub()
    const back = await githubReturns(
      `code=granted&state=${refused.github.searchParams.get('state')}`,
      refused.cookie,
    )
    expect(back.headers.get('location')).toBe('/sign-in?via=github&error=account_not_linked')
    expect(back.headers.getSetCookie().some((c) => c.includes('session_token='))).toBe(false)

    // Confirmed, but GitHub hasn't confirmed its side: still refused.
    await h.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, email))
    person.verified = false
    const unverified = await startGitHub()
    const again = await githubReturns(
      `code=granted&state=${unverified.github.searchParams.get('state')}`,
      unverified.cookie,
    )
    expect(again.headers.get('location')).toBe('/sign-in?via=github&error=account_not_linked')

    // Both confirmed: GitHub joins the account, and the person is signed in to it.
    person.verified = true
    const joined = await startGitHub()
    const done = await githubReturns(
      `code=granted&state=${joined.github.searchParams.get('state')}`,
      joined.cookie,
    )
    expect(done.headers.get('location')).toBe('/servers')
    expect((await sessionOf(done))?.user.email).toBe(email)
  })

  test('declining on GitHub comes back to the page, marked with the provider', async () => {
    signInAs()
    const { github, cookie } = await startGitHub()
    const back = await githubReturns(`error=access_denied&state=${github.searchParams.get('state')}`, cookie)
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/sign-in?via=github&error=access_denied')
  })
})
