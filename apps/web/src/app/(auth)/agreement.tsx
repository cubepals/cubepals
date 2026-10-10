// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The line under every way into an account, on sign-in and sign-up alike: continuing is agreeing
 * to the Terms and the Privacy Policy. It asks nothing; the 18-or-over rule is in the Terms (§3),
 * and the control plane keeps which version a new account was made under (`AGREED`).
 */
import Link from 'next/link'
import styles from './auth.module.css'

export function AgreementNote() {
  return (
    <p className={`type-body-sm ${styles.fineprint}`}>
      By continuing, you agree to the <Link href="/legal/terms">Terms of Service</Link> and{' '}
      <Link href="/legal/privacy">Privacy Policy</Link>.
    </p>
  )
}
