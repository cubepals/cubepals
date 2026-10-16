// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A link that may leave Cubepals. One to another site opens in a new tab, tells a screen reader so,
 * and gives that site no hold on this page (`noopener`) and no word of where the player came from
 * (`noreferrer`). Any other href (a page here, an anchor, an email, an app's own link) is a plain
 * link. Every `<a>` whose href isn't written out as one of ours goes through this, and
 * `out-link.test.ts` fails on one that doesn't. Not for links between pages here, which are
 * Next's `Link`.
 */
import type { AnchorHTMLAttributes } from 'react'
import { OPERATOR } from '../legal/operator'

/** What a screen reader hears after a link to another site. */
export const NEW_TAB = 'opens in a new tab'

/** Whether an href goes to another site: http(s), to a host that isn't Cubepals' own or under it. */
export function isExternal(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false
  const host = URL.canParse(href) ? new URL(href).hostname : undefined
  return host === undefined || (host !== OPERATOR.domain && !host.endsWith(`.${OPERATOR.domain}`))
}

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & { href: string }

export function OutLink({ href, children, ...rest }: Props) {
  if (!isExternal(href))
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    )
  // A link that names itself already says so in its name; any other says so after its words.
  const label = rest['aria-label']
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      {...rest}
      aria-label={label === undefined ? undefined : `${label} (${NEW_TAB})`}
    >
      {children}
      {label === undefined && <span className="bk-visually-hidden"> ({NEW_TAB})</span>}
    </a>
  )
}
