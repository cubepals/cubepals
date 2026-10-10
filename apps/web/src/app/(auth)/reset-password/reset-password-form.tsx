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
import { Button, Note, TextField } from '../../../ui'
import styles from '../auth.module.css'

export function ResetPasswordForm({ token }: { token: string }) {
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
    if (failure.code === 'INVALID_TOKEN') setExpired(true)
    else if (failure.code === 'PASSWORD_TOO_SHORT') setError('Use at least 10 characters.')
    else if (failure.code === 'PASSWORD_TOO_LONG') setError('That password is too long.')
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
    <form className={styles.email} onSubmit={submit} aria-label="Choose a new password">
      <TextField
        label="New password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        required
        value={password}
        error={error ?? checked.error}
        help="At least 10 characters."
        onChange={(e) => setPassword(e.target.value)}
        {...checked.field}
      />
      <TextField
        label="Type it again"
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
