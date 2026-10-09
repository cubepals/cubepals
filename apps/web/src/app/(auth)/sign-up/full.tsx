'use client'

/**
 * What sign-up shows once Cubepals has as many free accounts as it takes for now
 * (docs/money-guards.md): that it's full, calmly, and a place to leave an email for when there's
 * room. Leaving one is optional, and nothing else is asked. Whether it's full is the control
 * plane's to say; the page that decides to show this is `page.tsx`.
 */
import { useMutation } from '@tanstack/react-query'
import { Moon } from 'lucide-react'
import Link from 'next/link'
import { type SubmitEvent, useState } from 'react'
import { ApiProvider, messageOf, useTRPC } from '../../../lib/api'
import * as rules from '../../../lib/rules'
import { useChecked } from '../../../lib/use-checked'
import { Button, EmptyState, Note, TextField } from '../../../ui'
import styles from '../auth.module.css'

/** The page's own API client around the view, for a page outside the app's frame. */
export function SignupsFull({ source }: { source: string | null }) {
  return (
    <ApiProvider>
      <Full source={source} />
    </ApiProvider>
  )
}

function Full({ source }: { source: string | null }) {
  const trpc = useTRPC()
  const [email, setEmail] = useState('')
  const checked = useChecked(rules.email, email)
  const join = useMutation(trpc.platform.joinWaitlist.mutationOptions())
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!checked.check()) return
    join.mutate({ email, source })
  }
  return (
    <EmptyState
      art={<Moon size={48} strokeWidth={1.5} color="var(--forest-ink)" aria-hidden />}
      title="We're full for now"
      description="Cubepals is letting people in a few at a time while we make sure it runs well. Every place is taken today."
      action={
        join.isSuccess ? (
          <Note tone="success">Thanks. We'll email you once, when there's room.</Note>
        ) : (
          <form className={styles.email} onSubmit={submit} aria-label="Hear when there's room">
            <TextField
              label="Email (optional)"
              type="email"
              autoComplete="email"
              value={email}
              help="We'll write once, when there's room, and use it for nothing else."
              error={join.isError ? messageOf(join.error) : checked.error}
              onChange={(e) => setEmail(e.target.value)}
              {...checked.field}
            />
            <Button variant="primary" size="lg" block type="submit" disabled={join.isPending}>
              {join.isPending ? 'Adding you…' : 'Tell me when there’s room'}
            </Button>
            <p className="type-body-sm">
              Already have an account? <Link href="/sign-in">Sign in</Link>
            </p>
          </form>
        )
      }
    />
  )
}
