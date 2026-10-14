// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ctaMark } from '../app/(public)/steps'

/**
 * The one button, kept in reach. The dig is long, and whoever decides halfway down that they want
 * a server shouldn't have to climb back up for the button: once the hero has scrolled away this
 * stays in the corner, and steps aside again where the page's own button is on screen. On the
 * phone's page it does the same as a bar along the foot of the screen.
 */
export function Follow({ create }: { create: string }) {
  const marker = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    // The nearest of the page's two forms: the phone's page, or the film it is a part of.
    const root = marker.current?.closest('[data-phone], [data-landing]')
    const hero = root?.querySelector('[data-sky]')
    const closing = root?.querySelector('[data-closing]')
    if (!hero) return
    const inView = new Set<Element>()
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) inView.add(entry.target)
        else inView.delete(entry.target)
      }
      setShown(inView.size === 0)
    })
    seen.observe(hero)
    if (closing) seen.observe(closing)
    return () => seen.disconnect()
  }, [])

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
