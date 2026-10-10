// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentSession } from '../../../lib/session'
import { AuthEntry } from '../auth-entry'
import { authMethods, firstParam, localPath } from '../auth-methods'
import { SignInForm } from './sign-in-form'

export const metadata: Metadata = { title: 'Sign in' }

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [methods, params, session] = await Promise.all([authMethods(), searchParams, currentSession()])
  const next = localPath(params.next) ?? '/servers'
  // Already signed in: nothing to do here, so on to where they were headed.
  if (session !== null) redirect(next)
  // Where they were headed stays with them if they go on to make an account instead.
  const back = next === '/servers' ? '' : `?next=${encodeURIComponent(next)}`
  const failure = firstParam(params.error)
  // Back from choosing a new password, which signed out every device.
  const reset = firstParam(params.reset) === 'done'
  return (
    <AuthEntry
      title="Welcome back"
      methods={methods}
      redirects={{
        callbackURL: next,
        // Someone new who came to star a server or leave a note goes back to it, not to making one.
        newUserCallbackURL: next === '/servers' ? '/servers/new' : next,
        errorCallbackURL: `/sign-in${back}`,
      }}
      failure={failure}
      failedVia={firstParam(params.via)}
      notice={reset ? 'Your password was changed. Sign in with the new one.' : undefined}
      // An account a provider could not join is one whose password still works; a new password
      // is what someone just set.
      emailOpen={failure === 'account_not_linked' || reset}
      footer={
        <>
          Don't have an account? <Link href={`/sign-up${back}`}>Create one</Link>
        </>
      }
    >
      <SignInForm next={next} />
    </AuthEntry>
  )
}
