/**
 * What sign-up shows when the control plane can't say whether there's room for another free
 * account (docs/money-guards.md): no form, because sign-up offers only a place it knows is there.
 * Said once, calmly; reloading asks again. Full, for certain, is `full.tsx`'s page, not this one.
 */
import { Hourglass } from 'lucide-react'
import Link from 'next/link'
import { EmptyState } from '../../../ui'

export function SignupsUnknown() {
  return (
    <EmptyState
      art={<Hourglass size={48} strokeWidth={1.5} color="var(--forest-ink)" aria-hidden />}
      title="Sign-up is paused for a moment"
      description="Cubepals can't check for room just now. Reload to try again."
      action={
        <p className="type-body-sm">
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      }
    />
  )
}
