// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a request to Polar fails, for PolarBilling: Polar out of reach as BillingUnavailable, and a
 * refusal in Polar's own words. The requests themselves are PolarBilling's.
 */
import { PolarClientError, PolarError, PolarRateLimitError } from '@polar-sh/sdk'
import type { models } from '@polar-sh/sdk/2026-10'
import { BillingUnavailable } from '../../app/ports/optional.ts'

/**
 * What Polar said was wrong with a request: its first problem's message, or its own summary. A
 * 422 lists its problems (`HTTPValidationError`); a 400, which the SDK doesn't map, says one.
 */
export function refusal(error: PolarClientError): string {
  const body = error.error as models.HTTPValidationError | Partial<models.BadRequest> | null
  const detail = body?.detail
  if (typeof detail === 'string') return detail
  return detail?.find((problem) => problem.msg)?.msg ?? error.message
}

/**
 * Polar's outage, rate limit or an unreachable network is billing being unavailable. So is Polar
 * refusing Blockly's own token (revoked, or short a scope): it waits for a person to fix it, and
 * nothing asked meanwhile is at fault for it.
 */
export async function call<T>(what: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    const unavailable =
      error instanceof PolarRateLimitError ||
      (error instanceof PolarClientError && (error.statusCode === 401 || error.statusCode === 403)) ||
      (error instanceof PolarError && !(error instanceof PolarClientError))
    if (unavailable) throw new BillingUnavailable(`${what}: ${(error as Error).message}`)
    throw error
  }
}
