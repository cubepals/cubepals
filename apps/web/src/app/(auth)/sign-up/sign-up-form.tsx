// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { PASSWORD_MIN_LENGTH, SIGNUPS_FULL } from '@blockly/contracts'
import type { captcha } from 'better-auth/plugins'
import { useRouter } from 'next/navigation'
import { type SubmitEvent, useState } from 'react'
import { AGREED } from '../../../lib/agreement'
import { type AuthErrorCode, authClient } from '../../../lib/auth'
import * as rules from '../../../lib/rules'
import { useChecked } from '../../../lib/use-checked'
import { Button, TextField } from '../../../ui'
import styles from '../auth.module.css'
import { answered, started } from '../steps'
import { Turnstile } from './turnstile'

/**
 * The Terms the line under the buttons links to, which the control plane refuses an account
 * without. Better Auth's client doesn't know the field, so it goes in as extra body.
 */
const AGREEING = { agreement: AGREED }

/** Better Auth's names for a Turnstile answer that was missing or didn't pass: one it drops fails the build. */
type CheckCode = keyof ReturnType<typeof captcha>['$ERROR_CODES']
const CHECK_FAILED: readonly CheckCode[] = ['MISSING_RESPONSE', 'VERIFICATION_FAILED']

/** What a refused sign-up says: Better Auth's own words, unless Blockly has plainer ones. */
function refusal(failure: { code?: string | undefined; message?: string | undefined }): string {
  const code = failure.code as AuthErrorCode | CheckCode | undefined
  if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL')
    return 'There is already an account with that email. Sign in instead.'
  if (CHECK_FAILED.some((check) => check === code)) return 'We couldn’t check you’re a person. Try again.'
  return failure.message ?? 'We could not create your account. Try again.'
}

/** `turnstileSiteKey`: where the deployment checks that a person is signing up; null where it doesn't. */
export function SignUpForm({ next, turnstileSiteKey }: { next: string; turnstileSiteKey: string | null }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [used, setUsed] = useState(0)
  const checkedEmail = useChecked(rules.email, email)
  const checkedPassword = useChecked(rules.password, password)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    // Both fields have their say before anything is sent, so a typo is answered here rather
    // than by a round trip.
    if (![checkedEmail.check(), checkedPassword.check()].every(Boolean)) return
    // Turnstile answers on its own within a moment of the page opening, or asks for a click.
    if (turnstileSiteKey !== null && token === null) {
      setError('One moment: we’re checking you’re a person. Try again in a second.')
      return
    }
    setBusy(true)
    setError(null)
    started('signup', 'email')
    const { error: failure } = await authClient.signUp.email(
      {
        // Better Auth's sign-up takes a name, but nothing in Blockly shows one yet. It stays empty
        // until something needs it; a Google sign-up fills it from the profile.
        name: '',
        email,
        password,
        callbackURL: next,
        ...AGREEING,
      },
      token === null ? {} : { headers: { 'x-captcha-response': token } },
    )
    setBusy(false)
    // A Turnstile answer works once: the next try needs a fresh one.
    setToken(null)
    setUsed((n) => n + 1)
    answered('signup', failure)
    // Filled up between the page and the form: the page says so, with its waitlist.
    if (failure?.code === SIGNUPS_FULL) {
      router.push(`/sign-up?error=${SIGNUPS_FULL}`)
      router.refresh()
      return
    }
    if (failure) {
      setError(refusal(failure))
      return
    }
    router.push(`/check-email?email=${encodeURIComponent(email)}`)
  }

  return (
    <form
      id="sign-up"
      method="post"
      className={styles.email}
      onSubmit={submit}
      aria-label="Create an account with email"
    >
      <TextField
        label="Email"
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        help="We send one email to confirm it's you."
        error={checkedEmail.error}
        onChange={(e) => setEmail(e.target.value)}
        {...checkedEmail.field}
      />
      <TextField
        label="Password"
        id="new-password"
        name="new-password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        required
        value={password}
        error={error ?? checkedPassword.error}
        help={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        onChange={(e) => setPassword(e.target.value)}
        {...checkedPassword.field}
      />
      {turnstileSiteKey !== null && <Turnstile siteKey={turnstileSiteKey} onToken={setToken} reset={used} />}
      <Button variant="primary" size="lg" block type="submit" disabled={busy}>
        {busy ? 'Creating your account…' : 'Create account'}
      </Button>
    </form>
  )
}
