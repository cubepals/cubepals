// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { DISPOSABLE_EMAIL, PASSWORD_MIN_LENGTH, SIGNUPS_FULL, type SignUpAgreement } from '@blockly/contracts'
import { HOUR_S, MINUTE_S } from '@blockly/contracts/durations'
import { type Db, schema } from '@blockly/db'
import { betterAuth, type GenericEndpointContext } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api'
import { expireCookie } from 'better-auth/cookies'
import { captcha } from 'better-auth/plugins'
import { admin } from 'better-auth/plugins/admin'
import { defaultAc } from 'better-auth/plugins/admin/access'
import { oAuthProxy } from 'better-auth/plugins/oauth-proxy'
import type { Authenticator } from '../../app/ports/auth.ts'
import type { Mailer } from '../../app/ports/platform.ts'
import { agreementOf, refuseWithoutAgreement } from './agreement.ts'
import { disposable, emailKey } from './email-signals.ts'

/** An email as the application writes it: the subject and both parts. */
type Email = { subject: string; text: string; html: string }

export interface AuthOptions {
  db: Db
  mailer: Mailer
  /**
   * The emails sign-in sends, written by the application (app/emails/account.ts): each for its
   * link, and for the web origin its pictures load from.
   */
  emails: {
    verifyEmail(url: string, origin: string): Email
    resetPassword(url: string, origin: string): Email
    passwordChanged(origin: string): Email
    welcome(origin: string): Email
  }
  /** Where people reach the web app; auth is served under it at /api/auth through the proxy. */
  canonicalOrigin: string
  trustedOrigins: readonly string[]
  secret: string
  cookiePrefix: string
  github: OAuthClient | null
  google: OAuthClient | null
  /** Sign-in with a provider from a preview origin goes through the canonical one (§14). */
  oauthProxy: { secret: string } | null
  /** The header each request's client address arrives in (the port's CLIENT_ADDRESS_HEADER). */
  clientAddressHeader: string
  /**
   * Whether an account may be made for this address now, taking its free place when it may:
   * false when sign-up is full (`AccountService.admits`). Absent, every sign-up is admitted.
   */
  admitAccount?: (email: string) => Promise<boolean>
  /**
   * The addresses and `@domain`s that may make an account at all (SIGNUP_ALLOWLIST, with the
   * admins). Absent or empty, anyone may.
   */
  signupAllowlist?: readonly string[]
  /**
   * Cloudflare Turnstile's secret, checked against the answer the email sign-up form sends
   * (`x-captcha-response`). Null or absent, sign-up asks nothing.
   */
  turnstile?: { secretKey: string } | null
  /**
   * A new account's inbox, as `emailKey` writes it, and the address it signed up from when known:
   * for one person's one set of free hours. The address is only ever a weak signal there.
   */
  onSignedUp?: (userId: string, emailKey: string, address: string | null) => Promise<void>
  /**
   * A new account: the application opens its standing before anything else reads it, and keeps
   * the Terms it was made under (null only for an account made outside a request).
   */
  onAccountCreated: (userId: string, agreement: SignUpAgreement | null) => Promise<void>
  /**
   * Told about every account that is created or changes, with whether its email is confirmed,
   * and the session the request carries for it, the one to keep (null: none).
   */
  onAccount?: (
    user: { id: string; email: string; emailVerified: boolean },
    keep: string | null,
  ) => Promise<void>
  /** Told when someone sets a new password through a reset link, for the account's audit log. */
  onPasswordReset?: (userId: string) => Promise<void>
}

/** How long a reset link works. */
const RESET_LINK_SECONDS = HOUR_S

/** How long an admin may use a test account before signing in again (app/accounts/impersonation.ts). */
const IMPERSONATION_SECONDS = HOUR_S

/**
 * How long a sign-in with a provider may take: Better Auth keeps its state ten minutes
 * (`generateState` in better-auth/dist/oauth2/state.mjs, which exports no constant for it), but
 * the browser's half of it, the `state` cookie, only five. A trip to the provider that takes longer
 * comes back without the cookie and is refused.
 */
const SIGN_IN_STATE_SECONDS = 10 * MINUTE_S

/**
 * Better Auth's admin plugin, for its impersonation only: the session it makes for the test
 * account, the admin's kept in a signed cookie, and the way back. Who is an admin and who may be
 * used is the application's to say, so its role check passes for everyone, and none of its
 * endpoints are served over HTTP (`disabledPaths`): the application calls the two it needs.
 */
const impersonation = admin({
  impersonationSessionDuration: IMPERSONATION_SECONDS,
  roles: { user: defaultAc.newRole({ user: ['impersonate'], session: [] }) },
  adminRoles: [],
})
const ADMIN_PATHS = Object.values(impersonation.endpoints).map((endpoint) => endpoint.path)

/** Whether `email` is one the allowlist names, itself or by its `@domain`. */
export function listed(allowlist: readonly string[], email: string): boolean {
  const address = email.toLowerCase()
  const domain = address.slice(address.lastIndexOf('@'))
  return allowlist.includes(address) || allowlist.includes(domain)
}

interface OAuthClient {
  clientId: string
  clientSecret: string
}

/**
 * Better Auth, reached only through the web origin's /api rewrite: every cookie is host-only on
 * the web origin, so no cookie domain exists to configure or to leak across environments.
 */
export function createAuth(options: AuthOptions) {
  // What each sign-up request agreed to, from the check before the account is written to the
  // record of it after: the two hooks see the same request.
  const agreements = new WeakMap<object, SignUpAgreement>()
  const secure = new URL(options.canonicalOrigin).protocol === 'https:'
  const origin = options.canonicalOrigin
  const send = (to: string, email: Email) =>
    options.mailer.send({ to, subject: email.subject, text: email.text, html: email.html })
  // Once an account is ready: its email confirmed, or made already confirmed by Google or GitHub.
  // A welcome that fails is logged and the request goes on, as Better Auth does with a
  // confirmation email that fails: nobody's sign-up or confirmation should fail over a welcome.
  const welcome = async (user: { id: string; email: string }) => {
    try {
      await send(user.email, options.emails.welcome(origin))
    } catch (error) {
      console.error(`welcome email to account ${user.id} failed`, error)
    }
  }
  return betterAuth({
    baseURL: options.canonicalOrigin,
    basePath: '/api/auth',
    secret: options.secret,
    trustedOrigins: [options.canonicalOrigin, ...options.trustedOrigins],
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      // The link lands on /api/auth/reset-password/<token>, which sends the browser on to the
      // web app's /reset-password with the token (or with `?error=INVALID_TOKEN`).
      resetPasswordTokenExpiresIn: RESET_LINK_SECONDS,
      async sendResetPassword({ user, url }) {
        await send(user.email, options.emails.resetPassword(url, origin))
      },
      // Whoever knew the old password is signed out everywhere, and the owner is told.
      revokeSessionsOnPasswordReset: true,
      async onPasswordReset({ user }) {
        await options.onPasswordReset?.(user.id)
        await send(user.email, options.emails.passwordChanged(origin))
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      async sendVerificationEmail({ user, url }) {
        await send(user.email, options.emails.verifyEmail(url, origin))
      },
      // Better Auth calls this only when the address goes from unconfirmed to confirmed, so a link
      // followed twice welcomes once. (It would call it for a changed email too; changing one is
      // off.)
      afterEmailVerification: welcome,
    },
    socialProviders: {
      ...(options.github ? { github: options.github } : {}),
      // The account chooser every time, so nobody lands in the wrong Google account by default.
      ...(options.google ? { google: { ...options.google, prompt: 'select_account' as const } } : {}),
    },
    // Account linking keeps Better Auth's defaults on purpose. A Google sign-in joins an existing
    // account only when Google vouches for the email and the account has confirmed it too
    // (`requireLocalEmailVerified`), so an unconfirmed sign-up cannot sit in wait for its owner.
    // Anything else comes back to the page as `?error=account_not_linked`.
    advanced: {
      cookiePrefix: options.cookiePrefix,
      useSecureCookies: secure,
      // The browser keeps its half of a provider's sign-in as long as the server keeps the rest.
      cookies: { state: { attributes: { maxAge: SIGN_IN_STATE_SECONDS } } },
      // Better Auth turns origin and callback checks off when NODE_ENV is `test`; they stay on
      // here, so tests run the checks production runs.
      disableOriginCheck: false,
      // Its limits (three sign-ins a person every ten seconds, kept in memory on each api machine)
      // count by address. Behind the web tier and the host's proxy, `x-forwarded-for` holds a chain
      // it won't guess from, and every request fell into one bucket shared by everyone; the HTTP
      // layer says whose it is instead.
      ipAddress: { ipAddressHeaders: [options.clientAddressHeader] },
    },
    // An OAuth failure that cannot tell which page it started on (a stale or forged callback)
    // lands on sign-in with its `?error=`, not on Better Auth's own error page.
    onAPIError: { errorURL: `${options.canonicalOrigin}/sign-in` },
    // Providers register one callback per environment, on its canonical origin. A sign-in that
    // starts on a preview goes out and back through it, and the preview gets the session.
    plugins: [
      impersonation,
      // A person, not a script: Turnstile on the email sign-up form. Google and GitHub sign-ups
      // already passed their own checks.
      ...(options.turnstile
        ? [
            captcha({
              provider: 'cloudflare-turnstile',
              secretKey: options.turnstile.secretKey,
              endpoints: ['/sign-up/email'],
            }),
          ]
        : []),
      ...(options.oauthProxy
        ? [oAuthProxy({ productionURL: options.canonicalOrigin, secret: options.oauthProxy.secret })]
        : []),
    ],
    disabledPaths: ADMIN_PATHS,
    hooks: {
      // The way back keeps the "don't remember me" marker the test account's session was given,
      // and while it stays the admin's own session is never extended. Nobody signs in to Cubepals
      // that way, so it goes.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/admin/stop-impersonating' && !isAPIError(ctx.context.returned))
          expireCookie(ctx, ctx.context.authCookies.dontRememberToken)
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Without the person's agreement to the Terms nothing is written: an email sign-up
          // without it is refused with the reason, and a provider's round trip without it creates
          // nothing. Accounts made outside a request (none are, today) have no one to ask. Then
          // `admitSignUp`, whichever way the person came in.
          async before(user, context) {
            if (context) {
              const agreement = await agreementOf(context)
              if (agreement === null) return refuseWithoutAgreement(context.path)
              agreements.set(context, agreement)
            }
            await admitSignUp(options, user.email)
          },
          async after(user, context) {
            await options.onAccountCreated(user.id, (context && agreements.get(context)) ?? null)
            const address = context?.request?.headers.get(options.clientAddressHeader) ?? null
            await options.onSignedUp?.(user.id, emailKey(user.email), address)
            await options.onAccount?.(user, null)
            // Google or GitHub vouched for the address, so the account is ready now. An email
            // sign-up, or a provider that didn't vouch, is welcomed once it confirms.
            if (user.emailVerified) await welcome(user)
          },
        },
        // Confirming an email is an update, the only one /verify-email makes (changing an email is
        // off). Only the browser that confirmed stays signed in, and a listed admin becomes one
        // only once it is confirmed.
        update: {
          async after(user, context) {
            const confirmed = context?.path === '/verify-email' && user.emailVerified
            const keep = confirmed && context ? await sessionFor(user.id, context) : null
            if (confirmed && context) await endSessionsBut(context, user.id, keep)
            await options.onAccount?.(user, keep)
          },
        },
      },
      session: {
        update: {
          // A session is extended as it is used, unless its cookies say not to remember it, which
          // the browser holds. An admin's hour as a test account ends when it ends, whatever the
          // browser sends.
          async before(session, context) {
            const current = context?.context.session?.session
            if (current?.impersonatedBy && session.expiresAt !== undefined)
              return { data: { ...session, expiresAt: current.expiresAt } }
          },
        },
      },
    },
  })
}

/**
 * Whether an account may be made for this address: refused, with the reason, outside the
 * allowlist, for a throwaway address, or past the free-account cap. The cap comes last, right
 * before the write, because admitting takes a free place until the account exists. Where a
 * sign-up comes from never refuses it: one address is often a whole school or phone network.
 */
async function admitSignUp(options: AuthOptions, email: string): Promise<void> {
  const allowlist = options.signupAllowlist ?? []
  if (allowlist.length > 0 && !listed(allowlist, email))
    throw new APIError('FORBIDDEN', {
      message: 'This Cubepals is a private test site. Ask the team to add your email.',
    })
  if (disposable(email))
    throw new APIError('FORBIDDEN', {
      code: DISPOSABLE_EMAIL,
      message: 'That’s a throwaway email address. Sign up with one you keep, so you can always get back in.',
    })
  if (options.admitAccount && !(await options.admitAccount(email)))
    throw new APIError('FORBIDDEN', {
      code: SIGNUPS_FULL,
      message: "Cubepals is full for now. Leave your email and we'll tell you when there's room.",
    })
}

/** The session this request carries for the account, or null when it carries none of its own. */
async function sessionFor(userId: string, context: GenericEndpointContext): Promise<string | null> {
  const found = await getSessionFromCtx(context).catch(() => null)
  return found?.user.id === userId ? found.session.id : null
}

/** Ends every session of the account but `keep` (null: every one), through Better Auth's own store. */
async function endSessionsBut(context: GenericEndpointContext, userId: string, keep: string | null) {
  const store = context.context.internalAdapter
  const ending = (await store.listSessions(userId)).filter((s) => s.id !== keep).map((s) => s.token)
  if (ending.length > 0) await store.deleteSessions(ending)
}

export type Auth = ReturnType<typeof createAuth>

/** Better Auth as the application's `Authenticator`. */
export function betterAuthenticator(options: AuthOptions): Authenticator {
  const auth = createAuth(options)
  const handle = authHandler(auth)
  return {
    handle,
    async sessionOf(headers) {
      const found = await auth.api.getSession({ headers })
      if (found === null) return null
      return {
        userId: found.user.id,
        sessionId: found.session.id,
        impersonatedBy: found.session.impersonatedBy ?? null,
      }
    },
    switchFor(request, response) {
      const keep = (set: Headers) => {
        for (const cookie of set.getSetCookie()) response.append('set-cookie', cookie)
      }
      return {
        async impersonate(userId) {
          keep(
            (await auth.api.impersonateUser({ body: { userId }, headers: request, returnHeaders: true }))
              .headers,
          )
        },
        async stopImpersonating() {
          keep((await auth.api.stopImpersonating({ headers: request, returnHeaders: true })).headers)
        },
      }
    },
  }
}

/**
 * Serves /api/auth/*. Behind the web tier's rewrite, a request's URL carries the api's own host;
 * Better Auth sees it at the origin the browser sent it to instead, read from the Origin header
 * and only when this deployment trusts that origin. oAuthProxy reads it to bring a preview's
 * sign-in back to the preview. The web tier's X-Forwarded-Host isn't read for it: what that says
 * is up to whichever host runs the rewrite, and has been the upstream's own host.
 */
export function authHandler(auth: Auth): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get('origin')
    if (origin === null || !(await auth.$context).isTrustedOrigin(origin)) return auth.handler(request)
    const url = new URL(request.url)
    const body =
      request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    return auth.handler(
      new Request(`${origin}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body,
      }),
    )
  }
}
