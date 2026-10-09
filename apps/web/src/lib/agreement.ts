import { type CheckoutConsent, type SignUpAgreement, TERMS_VERSION } from '@blockly/contracts'

/**
 * What the web app sends when someone agrees: at sign-up, the Terms that the line under the
 * buttons links to; before paying, that they agree to the Terms and want the plan to start now,
 * null until both boxes are ticked so nothing is sent half-agreed. The control plane checks the
 * same shapes (`@blockly/contracts` agreements) and refuses without them.
 */

/** What a new account is made under: continuing past the line that says so is agreeing. */
export const AGREED: SignUpAgreement = { terms: TERMS_VERSION }

/** The checkout consent once both its boxes are ticked. */
export const consentFor = (terms: boolean, startNow: boolean): CheckoutConsent | null =>
  terms && startNow ? { terms: TERMS_VERSION, startNow: true } : null

/** What someone is told who tries to pay without ticking both boxes. */
export const UNCONSENTED = 'Tick both boxes to continue to payment.'
