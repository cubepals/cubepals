// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { SIGNUPS_FULL } from '@blockly/contracts'
import { useRouter } from 'next/navigation'
import { type SubmitEvent, useState } from 'react'
import { AGREED } from '../../../lib/agreement'
import { authClient } from '../../../lib/auth'
import * as rules from '../../../lib/rules'
import { useChecked } from '../../../lib/use-checked'
import { Button, TextField } from '../../../ui'
import styles from '../auth.module.css'

/**
 * The Terms the line under the buttons links to, which the control plane refuses an account
 * without. Better Auth's client doesn't know the field, so it goes in as extra body.
 */
const AGREEING = { agreement: AGREED }

export function SignUpForm({ next }: { next: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const checkedEmail = useChecked(rules.email, email)
  const checkedPassword = useChecked(rules.password, password)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    // Both fields have their say before anything is sent, so a typo is answered here rather
    // than by a round trip.
    if (![checkedEmail.check(), checkedPassword.check()].every(Boolean)) return
    setBusy(true)
    setError(null)
    const { error: failure } = await authClient.signUp.email({
      // Better Auth's sign-up takes a name, but nothing in Blockly shows one yet. It stays empty
      // until something needs it; a Google sign-up fills it from the profile.
      name: '',
      email,
      password,
      callbackURL: next,
      ...AGREEING,
    })
    setBusy(false)
    // Filled up between the page and the form: the page says so, with its waitlist.
    if (failure?.code === SIGNUPS_FULL) {
      router.push(`/sign-up?error=${SIGNUPS_FULL}`)
      router.refresh()
      return
    }
    if (failure) {
      setError(
        failure.code === 'USER_ALREADY_EXISTS' || failure.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'
          ? 'There is already an account with that email. Sign in instead.'
          : (failure.message ?? 'We could not create your account. Try again.'),
      )
      return
    }
    router.push(`/check-email?email=${encodeURIComponent(email)}`)
  }

  return (
    <form className={styles.email} onSubmit={submit} aria-label="Create an account with email">
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        help="We send one email to confirm it's you."
        error={checkedEmail.error}
        onChange={(e) => setEmail(e.target.value)}
        {...checkedEmail.field}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        required
        value={password}
        error={error ?? checkedPassword.error}
        help="At least 10 characters."
        onChange={(e) => setPassword(e.target.value)}
        {...checkedPassword.field}
      />
      <Button variant="primary" size="lg" block type="submit" disabled={busy}>
        {busy ? 'Creating your account…' : 'Create account'}
      </Button>
    </form>
  )
}
