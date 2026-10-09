/**
 * Sign-up: the providers and email, with where the person came from carried through to the
 * first page after, or the waitlist when Cubepals is full for now (docs/money-guards.md). The
 * form itself is `sign-up-form.tsx`; the full page is `full.tsx`; the page for when nobody can
 * say whether there's room is `unknown.tsx`.
 */
import { SIGNUPS_FULL } from '@blockly/contracts'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentSession } from '../../../lib/session'
import { sourceOf, withSource } from '../../../lib/source'
import { AuthEntry } from '../auth-entry'
import { authMethods, firstParam, localPath, signupsOpen } from '../auth-methods'
import { SignupsFull } from './full'
import { SignUpForm } from './sign-up-form'
import { SignupsUnknown } from './unknown'

export const metadata: Metadata = { title: 'Create your account' }

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [methods, params, session, open] = await Promise.all([
    authMethods(),
    searchParams,
    currentSession(),
    signupsOpen(),
  ])
  // Someone who came here from a link they wanted to follow — a server to copy, a page to join —
  // is sent back to it once they have an account, rather than to an empty list of servers.
  const next = localPath(params.next)
  // Already has an account and is signed in: on to where they were headed, or their servers.
  if (session !== null) redirect(next ?? '/servers')
  const back = next === null ? '' : `?next=${encodeURIComponent(next)}`
  // Where they came from goes on to the first page after sign-up, which keeps it on the account.
  const source = sourceOf(params)
  // Full for now, said before anyone types anything, or after a sign-up came back refused.
  if (open === 'full' || firstParam(params.error) === SIGNUPS_FULL)
    return <SignupsFull source={source?.source ?? null} />
  // Nobody can say whether there's room: no form until someone can.
  if (open === 'unknown') return <SignupsUnknown />
  return (
    <AuthEntry
      title="Create your account"
      description="Free to start. No card needed."
      methods={methods}
      // Someone who already has an account and continues with a provider here is simply signed in.
      redirects={{
        callbackURL: next ?? '/servers',
        newUserCallbackURL: withSource(next ?? '/servers/new', source),
        errorCallbackURL: withSource(`/sign-up${back}`, source),
      }}
      failure={firstParam(params.error)}
      failedVia={firstParam(params.via)}
      footer={
        <>
          Already have an account? <Link href={`/sign-in${back}`}>Sign in</Link>
        </>
      }
    >
      <SignUpForm next={withSource(next ?? '/servers/new', source)} />
    </AuthEntry>
  )
}
