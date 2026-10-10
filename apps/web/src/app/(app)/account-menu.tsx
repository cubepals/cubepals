'use client'

/**
 * The signed-in account at the foot of the sidebar: its email, quiet, and pressed it opens the one
 * thing done to the account from anywhere, signing out. Kept behind a press so it is never hit by
 * accident on the way to something else. The account's own page is the Account item above it.
 */
import { ChevronsUpDown, LogOut } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { authClient } from '../../lib/auth'
import { Popover } from '../../ui'

/** The foot's icons: smaller than the items' above, as the foot is quieter than they are. */
const SMALL = { size: 16, strokeWidth: 1.75 } as const

export function AccountMenu({ email }: { email: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const signOut = async () => {
    setLeaving(true)
    await authClient.signOut()
    router.push('/')
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Your account"
      placement="top-start"
      anchor={(reference) => (
        <button
          type="button"
          className="bk-appnav__me"
          aria-label={`Your account, ${email}`}
          {...reference()}
        >
          <span>{email}</span>
          <ChevronsUpDown {...SMALL} aria-hidden />
        </button>
      )}
    >
      <div className="bk-menu">
        <p className="bk-menu__note">Signed in as {email}</p>
        <button type="button" className="bk-menu__item" disabled={leaving} onClick={signOut}>
          <LogOut {...SMALL} aria-hidden />
          {leaving ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </Popover>
  )
}
