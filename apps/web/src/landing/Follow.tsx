// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The one button, kept in reach on the phone's page: a bar along the foot of the screen from the
 * first scroll on, which steps aside wherever the page's own button is on screen (the last one,
 * and each plan card's). On a wide screen the header carries it (app/(public)/header.tsx).
 */
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ctaMark } from '../app/(public)/steps'

export function Follow({ create }: { create: string }) {
  const marker = useRef<HTMLSpanElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const [covered, setCovered] = useState(false)

  useEffect(() => {
    const root = marker.current?.closest('[data-phone]')
    if (!root) return
    const scroll = () => setScrolled(window.scrollY > 8)
    scroll()
    window.addEventListener('scroll', scroll, { passive: true })
    const own = root.querySelectorAll('[data-closing], [data-plan], [data-cta="plans_create"]')
    const inView = new Set<Element>()
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) inView.add(entry.target)
        else inView.delete(entry.target)
      setCovered(inView.size > 0)
    })
    for (const element of own) seen.observe(element)
    return () => {
      window.removeEventListener('scroll', scroll)
      seen.disconnect()
    }
  }, [])

  const shown = scrolled && !covered
  return (
    <>
      <span ref={marker} hidden />
      <Link
        href={create}
        className="bl-follow"
        data-shown={shown || undefined}
        tabIndex={shown ? 0 : -1}
        {...ctaMark('follow_create')}
      >
        Create a server
      </Link>
    </>
  )
}
