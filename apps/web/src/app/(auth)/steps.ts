// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What signing up and signing in report, so it can be seen where a way in fails:
 *
 * - `signup_started` and `signin_started`: a way in was tried. `method` is `google`, `github` or
 *   `email`; email counts once the form's own checks pass and it is sent.
 * - `signup_failed` and `signin_failed`: it came back refused. `method`, and `reason`: the code
 *   Better Auth or the provider gave (lowercase), `rate_limited`, `unreachable`, or `other`.
 * - `verification_resent`: a new confirmation link was asked for; `sent` says whether it went.
 *
 * Success is the control plane's `signed_up`, kept once per account; it isn't said again here.
 * No email address, password or name is ever sent, and PostHog runs cookieless (lib/insight.tsx).
 */
import { asCode, capture } from '../../lib/insight'

/** The events, by what they report. Their names are a contract with the analytics built on them. */
const AUTH_EVENTS = {
  signup: { started: 'signup_started', failed: 'signup_failed' },
  signin: { started: 'signin_started', failed: 'signin_failed' },
  resent: 'verification_resent',
} as const

/** Making an account, or coming back to one. */
export type Flow = keyof Omit<typeof AUTH_EVENTS, 'resent'>
type Method = 'google' | 'github' | 'email'

/** A way in was tried. */
export function started(flow: Flow, method: Method): void {
  capture(AUTH_EVENTS[flow].started, { method })
}

/** A way in came back refused, with the refusal's code: never its message, which may hold the address. */
export function failed(flow: Flow, method: Method, reason: string | null | undefined): void {
  capture(AUTH_EVENTS[flow].failed, { method, reason: asCode(reason) })
}

/** The email form's answer from Better Auth: reported as failed where it was refused, by its code. */
export function answered(
  flow: Flow,
  failure: { status?: number | undefined; code?: string | undefined } | null | undefined,
): void {
  if (failure) failed(flow, 'email', failure.status === 429 ? 'rate_limited' : failure.code)
}

/** A new confirmation link was asked for, and whether it was sent. */
export function resent(sent: boolean): void {
  capture(AUTH_EVENTS.resent, { sent })
}
