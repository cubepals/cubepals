import { z } from 'zod'

/**
 * What a person agrees to: the Terms (which hold the 18-or-over rule) when they make an account,
 * and, before a paid plan starts, that it starts at once.
 * The web app asks; the control plane refuses an account or a checkout without it and keeps what
 * was said in the audit log. The policies themselves are pages on the web app (`/legal`).
 */

/**
 * The version of the Terms and policies in force: the day they last changed. A change that
 * matters to players is a new date here and on the pages, so the audit log can say which
 * version someone agreed to.
 */
export const TERMS_VERSION = '2026-10-10'

/** A version as the pages date it. Any well-formed date is kept as said: the log records it. */
const version = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * What the sign-in and sign-up pages send with a new account, by email or through a provider's
 * round trip: the version of the Terms the line under their buttons links to.
 */
export const SignUpAgreement = z.object({ terms: version })
export type SignUpAgreement = z.infer<typeof SignUpAgreement>

/**
 * What the checkout page sends before a paid plan's payment page opens: the person agreed to the
 * Terms and asked for the plan to start now, inside the 14 days they can cancel in, knowing they
 * pay for the hours they played if they do past the Refunds page's line.
 */
export const CheckoutConsent = z.object({
  terms: version,
  startNow: z.literal(true),
})
export type CheckoutConsent = z.infer<typeof CheckoutConsent>

/** The agreement in an untrusted value (a request body, an OAuth round trip's state), or null. */
export function signUpAgreementOf(value: unknown): SignUpAgreement | null {
  const parsed = SignUpAgreement.safeParse(value)
  return parsed.success ? parsed.data : null
}
