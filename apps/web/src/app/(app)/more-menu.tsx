// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The bottom bar's last item on a phone or tablet, where the sidebar isn't shown: More, which
 * opens what the bar has no room for. That is the server pages past the bar's first few, then the
 * account: who is signed in, the Account page, Admin for admins, and Sign out. Feedback has its own
 * button at the foot of the page there, so it isn't repeated here.
 *
 * It does not decide which pages are in it: the frame (./frame.tsx) hands it what's left over.
 */
import type { LucideIcon } from 'lucide-react'
import { Ellipsis } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { ICON, Popover } from '../../ui'
import { SignOut, SMALL } from './account-menu'

/** A page the menu links to, as the frame lists its items. */
export type NavEntry = { href: string; label: string; icon: LucideIcon; trailing?: string | undefined }

export function MoreMenu({
  email,
  pages,
  account,
  admin,
  isAdmin,
  pathname,
}: {
  email: string
  /** The server's pages the bar has no room for; empty away from a server. */
  pages: readonly NavEntry[]
  account: NavEntry
  /** Admin, shown to an admin only. */
  admin: NavEntry
  isAdmin: boolean
  pathname: string
}) {
  const [open, setOpen] = useState(false)
  const yours = isAdmin ? [account, admin] : [account]
  // Pressed while on one of its pages, More is lit as the bar's other items are on theirs.
  const here = [...pages, ...yours].some((entry) => entry.href === pathname)
  const row = (entry: NavEntry) => (
    <Link
      key={entry.href}
      href={entry.href}
      className="bk-menu__item"
      aria-current={entry.href === pathname ? 'page' : undefined}
      onClick={() => setOpen(false)}
    >
      <entry.icon {...SMALL} aria-hidden />
      {entry.label}
      {entry.trailing !== undefined && <span className="bk-menu__trailing">{entry.trailing}</span>}
    </Link>
  )
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="More"
      placement="top-end"
      anchor={(reference) => (
        <button
          type="button"
          className="bk-appnav__item bk-appnav__more"
          data-here={here || undefined}
          {...reference()}
        >
          <Ellipsis {...ICON} aria-hidden />
          More
        </button>
      )}
    >
      <div className="bk-menu">
        {pages.map(row)}
        <p className="bk-menu__note">Signed in as {email}</p>
        {yours.map(row)}
        <SignOut />
      </div>
    </Popover>
  )
}
