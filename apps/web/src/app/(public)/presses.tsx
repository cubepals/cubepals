// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Sends what a public page reports (`steps.ts`): a press of a marked button or link, heard once
 * for the whole page, and a guide read to its end. Renders nothing a person sees.
 */
import { useEffect, useRef } from 'react'
import { capture } from '../../lib/insight'
import { PUBLIC_EVENTS, pressOf } from './steps'

/** Hears presses of the page's marked buttons and links. Most go to another page, so by beacon. */
export function Presses() {
  useEffect(() => {
    const pressed = (event: MouseEvent) => {
      const marked =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-cta],[data-plan]') : null
      if (marked === null) return
      const press = pressOf(marked.dataset, window.location.pathname)
      if (press !== null) capture(press.event, press.properties, true)
    }
    document.addEventListener('click', pressed, { capture: true })
    return () => document.removeEventListener('click', pressed, { capture: true })
  }, [])
  return null
}

/** The end of a guide: reported once, when it first comes into view. */
export function GuideEnd({ slug }: { slug: string }) {
  const marker = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const end = marker.current
    if (end === null) return
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      seen.disconnect()
      capture(PUBLIC_EVENTS.guide, { slug })
    })
    seen.observe(end)
    return () => seen.disconnect()
  }, [slug])
  return <span ref={marker} aria-hidden />
}
