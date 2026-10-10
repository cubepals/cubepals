// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from 'next'
import Link from 'next/link'
import styles from '../auth.module.css'
import { ForgotPasswordForm } from './forgot-password-form'

export const metadata: Metadata = { title: 'Reset your password' }

export default function ForgotPasswordPage() {
  return (
    <div className={`${styles.entry} ${styles.alone}`}>
      <header className={styles.heading}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Reset your password
        </h1>
        <p className={`type-body ${styles.muted}`}>
          Enter the email you sign in with, and we'll send you a link to choose a new password.
        </p>
      </header>
      <ForgotPasswordForm />
      <p className={`type-body-sm ${styles.footer}`}>
        Remembered it? <Link href="/sign-in">Sign in</Link>
      </p>
    </div>
  )
}
