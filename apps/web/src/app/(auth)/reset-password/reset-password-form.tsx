// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { PASSWORD_MIN_LENGTH } from '@blockly/contracts/limits'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type SubmitEvent, useState } from 'react'
import { type AuthErrorCode, authClient } from '../../../lib/auth'
import * as rules from '../../../lib/rules'
import { useChecked } from '../../../lib/use-checked'
import { Button, Note, TextField } from '../../../ui'
import styles from '../auth.module.css'

/**
 * `email`: the account's, kept in the form unseen so a password manager updates that login. A link
 * from before the email came with it has none.
 */
export function ResetPasswordForm({ token, email }: { token: string; email: string | null }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)
  const checked = useChecked(rules.password, password)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!checked.check()) return
    if (password !== again) {
      setMismatch(true)
      return
    }
    setBusy(true)
    setError(null)
    const { error: failure } = await authClient.resetPassword({ newPassword: password, token })
    setBusy(false)
    if (!failure) {
      router.push('/sign-in?reset=done')
      return
    }
    const code = failure.code as AuthErrorCode | undefined
    if (code === 'INVALID_TOKEN') setExpired(true)
    else if (code === 'PASSWORD_TOO_SHORT') setError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    else if (code === 'PASSWORD_TOO_LONG') setError('That password is too long.')
    else setError('We could not set your password. Try again in a moment.')
  }

  if (expired)
    return (
      <div className={styles.email}>
        <Note tone="danger">
          This reset link has expired or was already used.{' '}
          <Link href="/forgot-password">Send a new link</Link>.
        </Note>
      </div>
    )

  return (
    <form
      id="reset-password"
      method="post"
      className={styles.email}
      onSubmit={submit}
      aria-label="Choose a new password"
    >
      {email !== null && (
        <input type="email" id="email" name="email" autoComplete="username" value={email} readOnly hidden />
      )}
      <TextField
        label="New password"
        id="new-password"
        name="new-password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        required
        value={password}
        error={error ?? checked.error}
        help={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        onChange={(e) => setPassword(e.target.value)}
        {...checked.field}
      />
      <TextField
        label="Type it again"
        id="confirm-password"
        name="confirm-password"
        type="password"
        autoComplete="new-password"
        required
        value={again}
        error={mismatch ? 'The two passwords are different.' : null}
        onChange={(e) => {
          setAgain(e.target.value)
          setMismatch(false)
        }}
      />
      <Button variant="primary" size="lg" block type="submit" disabled={busy}>
        {busy ? 'Setting your password…' : 'Set new password'}
      </Button>
    </form>
  )
}
