/**
 * No account without the Terms it is made under, through the real Better Auth handler on a real
 * database: an email sign-up without them is refused with the reason, a provider's round trip
 * without them makes nothing, and the account's audit log keeps which version was agreed to.
 * GitHub's three endpoints are stand-ins.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { authMail } from '../../testing/outbox.ts'
import { createAuth } from './better-auth.ts'

const ORIGIN = 'https://blockly.test'
const AGREED = { terms: TERMS_VERSION }
/** What a forged request might send in the agreement's place. */
const SHORT_OF_IT = [undefined, {}, { terms: 'the latest' }, 'yes']

/** GitHub as the stand-ins answer for it: one person, with one confirmed address. */
let person = { id: 0, email: '' }
const realFetch = globalThis.fetch
const github = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === 'https://github.com/login/oauth/access_token')
    return Response.json({ access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' })
  if (url === 'https://api.github.com/user')
    return Response.json({
      id: person.id,
      login: `octo-${person.id}`,
      name: 'Octo',
      email: null,
      avatar_url: null,
    })
  if (url === 'https://api.github.com/user/emails')
    return Response.json([{ email: person.email, primary: true, verified: true, visibility: 'private' }])
  return realFetch(input, init)
}) as typeof fetch

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
const signedIn = (response: Response) =>
  response.headers.getSetCookie().some((c) => c.includes('session_token='))

/** What the audit log says the account agreed to. */
async function agreedBy(db: Db, email: string): Promise<unknown[]> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (user === undefined) return []
  const rows = await db
    .select({ data: schema.auditLog.data })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectId, user.id), eq(schema.auditLog.action, 'account.agreed')))
  return rows.map((row) => row.data)
}

describe.skipIf(!hasDatabase)('the agreement an account is made with', () => {
  let h: Harness
  let handle: (request: Request) => Promise<Response>

  beforeAll(async () => {
    h = await startHarness()
    const auth = createAuth({
      clientAddressHeader: 'x-blockly-client-address',
      db: h.db,
      ...authMail(),
      canonicalOrigin: ORIGIN,
      trustedOrigins: [],
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      cookiePrefix: 'blockly-test',
      github: { clientId: 'github-client', clientSecret: 'github-secret' },
      google: null,
      oauthProxy: null,
      onAccountCreated: (userId, agreement) => h.app.accounts.opened(userId, agreement),
    })
    handle = auth.handler
    globalThis.fetch = github
  }, 30_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await h.close()
  })

  const post = (path: string, body: unknown) =>
    handle(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  /** A round trip through GitHub from the sign-in page, carrying `additionalData`. */
  const throughGitHub = async (additionalData: object) => {
    const started = await post('/sign-in/social', {
      provider: 'github',
      callbackURL: '/servers',
      newUserCallbackURL: '/servers/new',
      errorCallbackURL: '/sign-in',
      additionalData,
    })
    const state = new URL(((await started.json()) as { url: string }).url).searchParams.get('state')
    return handle(
      new Request(`${ORIGIN}/api/auth/callback/github?code=granted&state=${state}`, {
        headers: { cookie: cookieOf(started) },
      }),
    )
  }
  const someone = () => {
    person = {
      id: Number.parseInt(randomUUID().slice(0, 8), 16),
      email: `agree-${randomUUID().slice(0, 8)}@example.test`,
    }
    return person.email
  }

  test('by email: refused with the reason without it, and kept with the account with it', async () => {
    const email = someone()
    const signUp = (agreement: unknown) =>
      post('/sign-up/email', { email, password: 'a-long-enough-password', name: '', agreement })
    for (const short of SHORT_OF_IT) {
      const refused = await signUp(short)
      expect(refused.status).toBe(400)
      expect(((await refused.json()) as { code: string }).code).toBe('AGREEMENT_REQUIRED')
    }
    expect(await h.db.select().from(schema.users).where(eq(schema.users.email, email))).toEqual([])

    expect((await signUp(AGREED)).status).toBe(200)
    expect(await agreedBy(h.db, email)).toEqual([AGREED])
  })

  test('through a provider: from either page, and only with it', async () => {
    const email = someone()
    // A request that leaves the Terms out, or puts something else in their place.
    for (const short of SHORT_OF_IT) {
      const forged = await throughGitHub(short === undefined ? {} : { agreement: short })
      expect(forged.headers.get('location')).toBe('/sign-in?error=unable_to_create_user')
      expect(signedIn(forged)).toBe(false)
    }
    expect(await h.db.select().from(schema.users).where(eq(schema.users.email, email))).toEqual([])

    const made = await throughGitHub({ agreement: AGREED })
    expect(made.headers.get('location')).toBe('/servers/new')
    expect(signedIn(made)).toBe(true)
    expect(await agreedBy(h.db, email)).toEqual([AGREED])
  })
})
