// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type SubmitEvent, useState } from 'react'
import { authClient } from '../../../lib/auth'
import * as rules from '../../../lib/rules'
import { useChecked } from '../../../lib/use-checked'
import { Button, TextField } from '../../../ui'
import styles from '../auth.module.css'

export function SignInForm({ next }: { next: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const checked = useChecked(rules.email, email)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!checked.check()) return
    setBusy(true)
    setError(null)
    const { error: failure } = await authClient.signIn.email({ email, password })
    setBusy(false)
    if (failure) {
      // Only a wrong password is called one: a refusal for trying too often is said as that, and
      // anything else as ours.
      setError(
        failure.status === 429
          ? 'Too many tries from here. Wait a few seconds, then try again.'
          : failure.status === 401 || failure.code === 'INVALID_EMAIL_OR_PASSWORD'
            ? 'That email and password do not match. Check them and try again.'
            : 'We couldn’t sign you in just now. Try again in a moment.',
      )
      return
    }
    router.push(next)
  }

  return (
    <form className={styles.email} onSubmit={submit} aria-label="Sign in with email">
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        error={checked.error}
        onChange={(e) => setEmail(e.target.value)}
        {...checked.field}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        error={error}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Link href="/forgot-password" className={`type-body-sm ${styles.forgot}`}>
        Forgot your password?
      </Link>
      <Button variant="primary" size="lg" block type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
