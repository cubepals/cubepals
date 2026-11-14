// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The header's "Create a server": there once the page has been scrolled. On the landing page it
 * waits until the first screen, with its own button, has gone, and steps aside again where the
 * last screen's button is on screen; anywhere else, after the first scroll. On the landing it also
 * tells the header which ground it stands on, so it can be paper on the ink, and when the page has
 * left its top, for the hairline under it.
 */
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ctaMark } from './steps'

export function HeaderCreate({ href, className }: { href: string; className?: string }) {
  const at = useRef<HTMLAnchorElement>(null)
  const [shown, setShown] = useState(false)

  // On the landing, the ground under the header: the section across its band, and whether the
  // page has left its top.
  useEffect(() => {
    const header = at.current?.closest('header')
    const root = header?.closest('[data-landing]')
    if (!header?.hasAttribute('data-over-picture') || !root) return
    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) header.dataset.ground = (entry.target as HTMLElement).dataset.tone ?? ''
      },
      { rootMargin: '0px 0px -95% 0px' },
    )
    for (const section of root.querySelectorAll('[data-tone]')) seen.observe(section)
    const scrolled = () => header.toggleAttribute('data-scrolled', window.scrollY > 8)
    scrolled()
    window.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      seen.disconnect()
      window.removeEventListener('scroll', scrolled)
    }
  }, [])

  useEffect(() => {
    const root = at.current?.closest('[data-landing]')
    const hero = root?.querySelector('[data-opening]')
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
