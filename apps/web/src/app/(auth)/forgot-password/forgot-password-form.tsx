// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { type SubmitEvent, useState } from 'react'
import { authClient } from '../../../lib/auth'
import * as rules from '../../../lib/rules'
import { useChecked } from '../../../lib/use-checked'
import { Button, Note, TextField } from '../../../ui'
import styles from '../auth.module.css'

/**
 * Asks for a reset link. The answer is the same whether or not the email has an account, so the
 * page never tells anyone who uses Blockly.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const checked = useChecked(rules.email, email)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!checked.check()) return
    setBusy(true)
    setError(null)
    const { error: failure } = await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' })
    setBusy(false)
    if (failure) {
      setError(
        failure.status === 429
          ? 'Too many requests. Wait a minute, then try again.'
          : 'We could not send the link. Try again in a moment.',
      )
      return
    }
    setSentTo(email)
  }

  if (sentTo !== null)
    return (
      <div className={styles.email}>
        <Note tone="success">
          If an account uses {sentTo}, we sent it a link to choose a new password. The link works once, for an
          hour.
        </Note>
        <Button variant="ghost" block onClick={() => setSentTo(null)}>
          Use a different email
        </Button>
      </div>
    )

  return (
    <form className={styles.email} onSubmit={submit} aria-label="Ask for a reset link">
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        error={error ?? checked.error}
        onChange={(e) => setEmail(e.target.value)}
        {...checked.field}
      />
      <Button variant="primary" size="lg" block type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  )
}
