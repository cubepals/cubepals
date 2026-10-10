// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type SignUpAgreement, signUpAgreementOf } from '@blockly/contracts'
import { APIError, getOAuthState } from 'better-auth/api'

/**
 * Where a request that creates an account carries the Terms the person agreed to: the body of an
 * email sign-up, or the state of a provider's round trip. The sign-in and sign-up pages send it
 * with the line under their buttons that says continuing is agreeing.
 */
export async function agreementOf(context: { body?: unknown }): Promise<SignUpAgreement | null> {
  const body = context.body
  if (typeof body === 'object' && body !== null && 'agreement' in body)
    return signUpAgreementOf((body as { agreement: unknown }).agreement)
  return signUpAgreementOf((await getOAuthState())?.agreement)
}

/** What someone is told when an account is asked for without the agreement. */
const AGREEMENT_REQUIRED = 'To create an account, agree to the Terms of Service.'

/**
 * An account asked for without the agreement: an email sign-up is refused with the reason, and a
 * provider's round trip creates nothing (it comes back with `?error=unable_to_create_user`).
 */
export function refuseWithoutAgreement(path: string): false {
  if (path === '/sign-up/email')
    throw new APIError('BAD_REQUEST', { code: 'AGREEMENT_REQUIRED', message: AGREEMENT_REQUIRED })
  return false
}
