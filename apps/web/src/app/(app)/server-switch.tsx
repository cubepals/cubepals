// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The open server's name over its pages in the sidebar, as a switch once the account has more
 * than one server. Pressed, it lists every server, the open one marked, then All servers. The
 * sidebar stays the height of one server's pages however many there are; a long list scrolls in
 * its menu. It opens and reads as the account at the sidebar's foot does (./account-menu.tsx).
 *
 * Choosing a server goes where ./server-nav.ts says: the same page of it, or its Overview. An
 * account with one server has nothing to switch to, so the frame draws its name as a plain heading.
 */
import { ChevronsUpDown, LayoutGrid } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useRef, useState } from 'react'
import { Popover } from '../../ui'
import { SMALL } from './account-menu'
import { usePrefetch } from './prefetch'
import { type ListedServer, switchTo } from './server-nav'

export function ServerSwitch({
  servers,
  open,
  name,
  pathname,
}: {
  servers: readonly ListedServer[]
  /** The server whose pages the sidebar shows. */
  open: string
  name: string
  pathname: string
}) {
  const [shown, setShown] = useState(false)
  const prefetch = usePrefetch()
  // The open server's row takes focus as the menu opens, so the keyboard starts where the list is.
  const openRow = useRef<HTMLAnchorElement | null>(null)
  // One function for every render, so a list read again while someone scrolls it doesn't jump back.
  const keepOpenRow = useCallback((row: HTMLAnchorElement | null) => {
    openRow.current = row
    showOpen(row)
  }, [])
  const row = (href: string, label: string, here: boolean, key: string) => (
    <Link
      key={key}
      href={href}
      className="bk-menu__item"
      aria-current={here ? 'page' : undefined}
      // However far down the list the open server is, the menu opens with it in view.
      ref={here ? keepOpenRow : undefined}
      onClick={() => setShown(false)}
      {...prefetch.intent(href)}
    >
      <span className="bk-menu__label">{label}</span>
    </Link>
  )
  return (
    <Popover
      open={shown}
      onOpenChange={setShown}
      label="Your servers"
      placement="bottom-start"
      initialFocus={openRow}
      anchor={(reference) => (
        <button
          type="button"
          className="bk-appnav__heading bk-appnav__switch"
          aria-label={`${name}, switch server`}
          {...reference()}
        >
          <span>{name}</span>
          <ChevronsUpDown {...SMALL} aria-hidden />
        </button>
      )}
    >
      <div className="bk-menu">
        <div className="bk-menu__list">
          {servers.map((server) =>
            row(switchTo(server.id, pathname), server.name, server.id === open, server.id),
          )}
        </div>
        <Link
          href="/servers"
          className="bk-menu__item"
          onClick={() => setShown(false)}
          {...prefetch.intent('/servers')}
        >
          <LayoutGrid {...SMALL} aria-hidden />
          All servers
        </Link>
      </div>
    </Popover>
  )
}

/**
 * Scrolls the menu's list, and only it, so the open server's row sits in its middle as the menu
 * opens. Not scrollIntoView, which would scroll the page too, before the menu has its place.
 */
function showOpen(row: HTMLAnchorElement | null) {
  const list = row?.parentElement
  if (!row || !list) return
  list.scrollTop = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2
}
