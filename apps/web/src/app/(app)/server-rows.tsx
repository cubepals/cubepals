// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The account's servers in the sidebar, under Servers as what is in it, one row each: the picture
 * its owner gave it, its name, and a chevron. Pressing a row unfolds that server's pages under it,
 * indented, and folds any other; pressing it again folds it. A server is open on its own pages;
 * anywhere else the rows stay folded until pressed, and fold again when someone goes to another
 * page.
 *
 * Past ./server-nav.ts's MOST_ROWS, the last row says how many more there are and opens the
 * Servers page. What is listed and open is ./server-nav.ts's; the frame (./frame.tsx) draws the
 * pages.
 */
import { ChevronRight, Ellipsis } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { type ReactNode, useState } from 'react'
import { iconSrc } from '../../lib/pictures'
import { ICON } from '../../ui'
import { SMALL } from './account-menu'
import type { NavEntry } from './more-menu'
import { type ListedServer, NOTHING_PRESSED, pressRow, rowsShown, unfolded } from './server-nav'

export function ServerRows({
  servers,
  here,
  pathname,
  pagesOf,
  item,
}: {
  servers: readonly ListedServer[]
  /** The server whose page this is, if any. */
  here: string | undefined
  pathname: string
  pagesOf: (serverId: string) => NavEntry[]
  /** How the frame draws one of its links. */
  item: (entry: NavEntry) => ReactNode
}) {
  const [pressed, setPressed] = useState(NOTHING_PRESSED)
  // A row pressed open stays open on this page only: the next page starts from where it is.
  const [at, setAt] = useState(pathname)
  if (pathname !== at) {
    setAt(pathname)
    setPressed(NOTHING_PRESSED)
  }
  const open = unfolded(here, pressed)
  const { rows, more } = rowsShown(servers, open)
  return (
    <div className="bk-appnav__tree">
      {rows.map((server) => {
        const isOpen = server.id === open
        const pages = `server-pages-${server.id}`
        return (
          <div key={server.id} className="bk-appnav__server">
            <button
              type="button"
              className="bk-appnav__item bk-appnav__row"
              aria-expanded={isOpen}
              aria-controls={pages}
              title={server.name}
              onClick={() => setPressed(pressRow(here, pressed, server.id))}
            >
              {/* Square and sharp, as Minecraft's server list shows it. */}
              <Image
                className="bk-appnav__picture"
                src={iconSrc(server.icon, server.ownIcon)}
                alt=""
                unoptimized
                width={20}
                height={20}
              />
              <span className="bk-appnav__name">{server.name}</span>
              <ChevronRight className="bk-appnav__chevron" {...SMALL} aria-hidden />
            </button>
            {isOpen && (
              <div id={pages} className="bk-appnav__pages">
                {pagesOf(server.id).map(item)}
              </div>
            )}
          </div>
        )
      })}
      {more > 0 && (
        <Link href="/servers" className="bk-appnav__item bk-appnav__rest">
          <Ellipsis {...ICON} aria-hidden />
          {more} more servers
        </Link>
      )}
    </div>
  )
}
