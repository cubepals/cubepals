// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Use as this account", end to end: the real Better Auth admin plugin on a real database, reached
 * through the api's own HTTP surface the way the browser reaches it, cookies and all. Only an admin,
 * only a test account, both ends audited, admin pages refused meanwhile, and Switch back returns
 * the admin's own session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { Impersonation } from '../../app/accounts/impersonation.ts'
import { ensureStanding, grantAdmin } from '../../app/accounts/persistence.ts'
import { createApiApp } from '../../interfaces/http/api.ts'
import type { Services } from '../../interfaces/trpc/trpc.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { authMail } from '../../testing/outbox.ts'
import { betterAuthenticator } from './better-auth.ts'

const ORIGIN = 'http://localhost:3000'

/** A browser's cookies for the one origin: set, replaced, and removed as responses say. */
class Jar {
  readonly #cookies = new Map<string, string>()

  take(response: Response): this {
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';')
      const name = pair.slice(0, pair.indexOf('='))
      const value = pair.slice(pair.indexOf('=') + 1)
      const gone = value === '' || attributes.some((a) => a.trim().toLowerCase() === 'max-age=0')
      if (gone) this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
    return this
  }

  /** A copy without the cookies whose name ends in `suffix`, as a browser that dropped them. */
  without(suffix: string): Jar {
    const copy = new Jar()
    for (const [name, value] of this.#cookies) if (!name.endsWith(suffix)) copy.#cookies.set(name, value)
    return copy
  }

  get header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

let h: Harness
let app: ReturnType<typeof createApiApp>

// One harness for the file, where there is a database: booting is the slow part.
beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness()
  const auth = betterAuthenticator({
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
    onAccountCreated: (userId) => ensureStanding(h.db, userId),
  })
  app = createApiApp({
    auth,
    methods: { google: false, github: false },
    addresses: { proxySecret: null, hostHeader: null },
    origins: [ORIGIN],
    services: {
      accounts: h.app.accounts,
      accountQueries: h.app.accountQueries,
      impersonation: new Impersonation({ db: h.db }),
      insight: { report: () => undefined },
    } as unknown as Services,
  })
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await h.close()
})

const send = (path: string, jar: Jar, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: ORIGIN,
      cookie: jar.header,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const trpc = (procedure: string, jar: Jar, input: unknown = {}) =>
  send(`/api/trpc/${procedure}?batch=1`, jar, { 0: input })
const read = (procedure: string, jar: Jar, input: unknown = {}) =>
  send(`/api/trpc/${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`, jar)
const sessionOf = async (jar: Jar) =>
  (await (await send('/api/auth/get-session', jar)).json()) as {
    user: { id: string; email: string }
    session: { impersonatedBy?: string | null; expiresAt: string }
  } | null

/** Someone signed up and signed in with a password, and their browser. */
const signedIn = async (name: string) => {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`
  const jar = new Jar()
  const response = await send('/api/auth/sign-up/email', jar, {
    email,
    password: 'a-long-enough-password',
    name,
    agreement: { terms: TERMS_VERSION },
  })
  expect(response.status).toBe(200)
  jar.take(response)
  const session = await sessionOf(jar)
  if (session === null) throw new Error('not signed in')
  return { jar, userId: session.user.id }
}
const anAdmin = async () => {
  const admin = await signedIn('staff')
  await grantAdmin(h.db, admin.userId, 'test')
  return admin
}
const aTestAccount = async (adminId: string, plan = 'plus') =>
  (
    await h.app.accounts.createTestAccount(
      { kind: 'admin', userId: adminId },
      `sre-${randomUUID().slice(0, 8)}@example.test`,
      plan,
    )
  ).userId
const audited = (subjectId: string, action: string) =>
  h.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectId, subjectId), eq(schema.auditLog.action, action)))

describe.skipIf(!hasDatabase)('using a test account', () => {
  test('an admin uses a test account, admin pages are refused meanwhile, and switches back', async () => {
    const admin = await anAdmin()
    const tester = await aTestAccount(admin.userId)
    const own = admin.jar.header

    const started = await trpc('admin.useAs', admin.jar, { userId: tester })
    expect(started.status).toBe(200)
    admin.jar.take(started)
    const using = await sessionOf(admin.jar)
    expect(using?.user.id).toBe(tester)
    expect(using?.session.impersonatedBy).toBe(admin.userId)
    // Short: an hour, not the weeks a sign-in lasts.
    const left = new Date(using?.session.expiresAt ?? 0).getTime() - Date.now()
    expect(left).toBeGreaterThan(55 * 60_000)
    expect(left).toBeLessThanOrEqual(60 * 60_000)
    // And it stays an hour when the browser leaves out the marker that keeps it from being extended.
    const unmarked = await sessionOf(admin.jar.without('dont_remember'))
    expect(unmarked?.user.id).toBe(tester)
    expect(unmarked?.session.expiresAt).toBe(using?.session.expiresAt ?? '')
    const [stored] = await h.db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, tester))
    expect(stored?.expiresAt.toISOString()).toBe(using?.session.expiresAt ?? '')
    expect(await audited(tester, 'account.use_as_started')).toMatchObject([
      { actor: `admin:${admin.userId}`, subjectType: 'account' },
    ])

    // Every page sees the test account, and none of the admin's.
    const me = await read('account.me', admin.jar)
    expect(me.status).toBe(200)
    expect(await me.text()).not.toContain('"admin":true')
    expect((await read('admin.accounts', admin.jar, { search: '' })).status).toBe(404)
    expect((await read('admin.account', admin.jar, { userId: admin.userId })).status).toBe(404)
    expect((await trpc('admin.useAs', admin.jar, { userId: tester })).status).toBe(404)
    // Still refused once the test account is made an admin: the session isn't the admin's own.
    await grantAdmin(h.db, tester, 'test')
    expect((await read('admin.accounts', admin.jar, { search: '' })).status).toBe(404)
    await h.db.delete(schema.platformAdmins).where(eq(schema.platformAdmins.userId, tester))

    const ended = await trpc('account.switchBack', admin.jar)
    expect(ended.status).toBe(200)
    admin.jar.take(ended)
    const back = await sessionOf(admin.jar)
    expect(back?.user.id).toBe(admin.userId)
    expect(back?.session.impersonatedBy ?? null).toBeNull()
    expect(admin.jar.header).toBe(own)
    expect((await read('admin.accounts', admin.jar, { search: '' })).status).toBe(200)
    expect(await audited(tester, 'account.use_as_ended')).toMatchObject([
      { actor: `admin:${admin.userId}`, subjectType: 'account' },
    ])
    // The test account's session is gone, not left to run out.
    const sessions = await h.db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, tester))
    expect(sessions).toHaveLength(0)

    // Nothing to switch back from now.
    expect((await trpc('account.switchBack', admin.jar)).status).toBe(409)
  })
})

describe.skipIf(!hasDatabase)('who may use one', () => {
  test('only a test account, never an admin, and only by an admin', async () => {
    const admin = await anAdmin()
    const person = await signedIn('player')
    const otherAdmin = await anAdmin()
    const adminTester = await aTestAccount(admin.userId)
    await grantAdmin(h.db, adminTester, 'test')
    const tester = await aTestAccount(admin.userId)

    for (const userId of [person.userId, otherAdmin.userId, adminTester, admin.userId]) {
      const refused = await trpc('admin.useAs', admin.jar, { userId })
      expect(refused.status).toBe(400)
      expect(await refused.text()).toContain('Only a test account')
      expect(await audited(userId, 'account.use_as_started')).toHaveLength(0)
    }
    expect((await sessionOf(admin.jar))?.user.id).toBe(admin.userId)

    // Someone who isn't an admin is told there's nothing here, and stays themselves.
    expect((await trpc('admin.useAs', person.jar, { userId: tester })).status).toBe(404)
    expect((await trpc('admin.useAs', new Jar(), { userId: tester })).status).toBe(401)
    expect((await sessionOf(person.jar))?.user.id).toBe(person.userId)
    expect(await audited(tester, 'account.use_as_started')).toHaveLength(0)
  })

  test('Better Auth’s own admin endpoints are not served, to admins or anyone', async () => {
    const admin = await anAdmin()
    const tester = await aTestAccount(admin.userId)
    for (const [path, body] of [
      ['/api/auth/admin/impersonate-user', { userId: tester }],
      ['/api/auth/admin/stop-impersonating', {}],
      ['/api/auth/admin/set-role', { userId: admin.userId, role: 'admin' }],
      ['/api/auth/admin/ban-user', { userId: tester }],
    ] as const)
      expect((await send(path, admin.jar, body)).status).toBe(404)
    expect((await send('/api/auth/admin/list-users', admin.jar)).status).toBe(404)
    expect((await sessionOf(admin.jar))?.user.id).toBe(admin.userId)
  })
})
