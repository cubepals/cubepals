// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The header's "Create a server": there once the page has been scrolled. On the landing page it
 * waits until the first screen, with its own button, has gone, and steps aside again where the
 * last screen's button is on screen; anywhere else, after the first scroll.
 */
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ctaMark } from './steps'

export function HeaderCreate({ href, className }: { href: string; className?: string }) {
  const at = useRef<HTMLAnchorElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const root = at.current?.closest('[data-landing], [data-phone]')
    const hero = root?.querySelector('[data-sky]')
    if (!hero) {
      const scrolled = () => setShown(window.scrollY > 24)
      scrolled()
      window.addEventListener('scroll', scrolled, { passive: true })
      return () => window.removeEventListener('scroll', scrolled)
    }
    const showing = new Set<Element>()
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) showing.add(entry.target)
        else showing.delete(entry.target)
      setShown(showing.size === 0)
    })
    for (const own of [hero, root?.querySelector('[data-closing]')]) if (own) seen.observe(own)
    return () => seen.disconnect()
  }, [])

  return (
    <Link
      ref={at}
      href={href}
      className={className}
      data-shown={shown || undefined}
      tabIndex={shown ? 0 : -1}
      aria-hidden={!shown || undefined}
      {...ctaMark('follow_create')}
    >
      Create a server
    </Link>
  )
}
