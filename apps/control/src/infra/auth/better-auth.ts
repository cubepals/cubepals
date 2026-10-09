import { SIGNUPS_FULL, type SignUpAgreement } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { oAuthProxy } from 'better-auth/plugins/oauth-proxy'
import type { Authenticator } from '../../app/ports/auth.ts'
import type { Mailer } from '../../app/ports/platform.ts'
import { agreementOf, refuseWithoutAgreement } from './agreement.ts'

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
   * A new account: the application opens its standing before anything else reads it, and keeps
   * the Terms it was made under (null only for an account made outside a request).
   */
  onAccountCreated: (userId: string, agreement: SignUpAgreement | null) => Promise<void>
  /** Told about every account that is created or changes, with whether its email is confirmed. */
  onAccount?: (user: { id: string; email: string; emailVerified: boolean }) => Promise<void>
  /** Told when someone sets a new password through a reset link, for the account's audit log. */
  onPasswordReset?: (userId: string) => Promise<void>
}

/** How long a reset link works. */
const RESET_LINK_SECONDS = 60 * 60

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
      minPasswordLength: 10,
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
    plugins: options.oauthProxy
      ? [oAuthProxy({ productionURL: options.canonicalOrigin, secret: options.oauthProxy.secret })]
      : [],
    databaseHooks: {
      user: {
        create: {
          // Without the person's agreement to the Terms nothing is written: an email sign-up
          // without it is refused with the reason, and a provider's round trip without it creates
          // nothing. Accounts made outside a request (none are, today) have no one to ask. Nor past
          // the free-account cap, whichever way the person came in. That check comes last, right
          // before the write, because admitting takes a free place until the account exists.
          async before(user, context) {
            if (context) {
              const agreement = await agreementOf(context)
              if (agreement === null) return refuseWithoutAgreement(context.path)
              agreements.set(context, agreement)
            }
            const allowlist = options.signupAllowlist ?? []
            if (allowlist.length > 0 && !listed(allowlist, user.email))
              throw new APIError('FORBIDDEN', {
                message: 'This Cubepals is a private test site. Ask the team to add your email.',
              })
            if (options.admitAccount && !(await options.admitAccount(user.email)))
              throw new APIError('FORBIDDEN', {
                code: SIGNUPS_FULL,
                message: "Cubepals is full for now. Leave your email and we'll tell you when there's room.",
              })
          },
          async after(user, context) {
            await options.onAccountCreated(user.id, (context && agreements.get(context)) ?? null)
            await options.onAccount?.(user)
            // Google or GitHub vouched for the address, so the account is ready now. An email
            // sign-up, or a provider that didn't vouch, is welcomed once it confirms.
            if (user.emailVerified) await welcome(user)
          },
        },
        // Confirming an email is an update; a listed admin becomes one only once it is confirmed.
        update: {
          async after(user) {
            await options.onAccount?.(user)
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>

/** Better Auth as the application's `Authenticator`. */
export function betterAuthenticator(options: AuthOptions): Authenticator {
  const auth = createAuth(options)
  const handle = authHandler(auth)
  return {
    handle,
    async userOf(headers) {
      return (await auth.api.getSession({ headers }))?.user.id ?? null
    },
  }
}

/**
 * Serves /api/auth/*. Behind the web tier's rewrite, a request's URL carries the api's own host;
 * Better Auth sees it at the origin the browser sent it to instead, read from the Origin header
 * and only when this deployment trusts that origin. oAuthProxy reads it to bring a preview's
 * sign-in back to the preview. The web tier's X-Forwarded-Host can't say it: Vercel's external
 * rewrites set it to the upstream's host.
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
