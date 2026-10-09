import type { Metadata } from 'next'
import Link from 'next/link'
import { Button, Note } from '../../../ui'
import styles from '../auth.module.css'
import { firstParam } from '../auth-methods'
import { ResetPasswordForm } from './reset-password-form'

export const metadata: Metadata = { title: 'Choose a new password' }

/**
 * Where a reset email's link lands: Better Auth sends the browser here with `?token=`, or with
 * `?error=INVALID_TOKEN` when the link expired or was used already.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const token = firstParam(params.token)
  const usable = token !== null && firstParam(params.error) === null
  return (
    <div className={`${styles.entry} ${styles.alone}`}>
      <header className={styles.heading}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Choose a new password
        </h1>
        <p className={`type-body ${styles.muted}`}>
          {usable
            ? 'Once it is set, every device signed in to your account is signed out.'
            : 'This link cannot set a password.'}
        </p>
      </header>
      {usable ? (
        <ResetPasswordForm token={token} />
      ) : (
        <div className={styles.email}>
          <Note tone="danger">
            This reset link has expired or was already used. Each link works once, for an hour. Ask for a new
            one.
          </Note>
          <Button variant="primary" size="lg" block href="/forgot-password">
            Send a new link
          </Button>
        </div>
      )}
      <p className={`type-body-sm ${styles.footer}`}>
        Remembered it? <Link href="/sign-in">Sign in</Link>
      </p>
    </div>
  )
}
