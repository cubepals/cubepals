// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Sends what a page reports through its marks (`steps.ts`): a press of a marked button or link
 * and a marked question opened, heard once for the whole page; a marked section coming into
 * view; a guide read to its end; and the directory's and an invitation's own answers. Renders
 * nothing a person sees.
 */
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { asCode, capture } from '../../lib/insight'
import { detailOf, PUBLIC_EVENTS, pressOf, seenOf } from './steps'

/**
 * Hears presses of the page's marked buttons and links, and sees its marked sections. Most
 * presses go to another page, so by beacon.
 */
export function Presses() {
  useEffect(() => {
    const pressed = (event: MouseEvent) => {
      const marked =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-cta],[data-plan],[data-detail]')
          : null
      if (marked === null) return
      const press =
        marked.dataset.detail === undefined
          ? pressOf(marked.dataset, window.location.pathname)
          : opened(marked)
      if (press !== null) capture(press.event, press.properties, true)
    }
    document.addEventListener('click', pressed, { capture: true })
    return () => document.removeEventListener('click', pressed, { capture: true })
  }, [])
  useSeen()
  return null
}

/**
 * A press on a marked question: reported where it opens it, as the press lands and before it
 * has. A `<details>` is open or not; a button that opens a panel says so by `aria-expanded`.
 */
function opened(marked: HTMLElement) {
  const shut =
    marked instanceof HTMLDetailsElement ? !marked.open : marked.getAttribute('aria-expanded') !== 'true'
  return shut ? detailOf(marked.dataset.detail, window.location.pathname) : null
}

/** How much of a section is on screen before it counts as seen: half of it, or half the screen. */
const SEEN = 0.5

/**
 * Sees the page's marked sections: each reported the first time it is on screen, once a view of
 * that page. Sections drawn later (a list that loads) are watched as they appear.
 */
function useSeen() {
  const path = usePathname()
  useEffect(() => {
    const said = new Set<string>()
    const watching = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const section = (entry.target as HTMLElement).dataset.seen
          const enough =
            entry.intersectionRatio >= SEEN || entry.intersectionRect.height >= window.innerHeight * SEEN
          if (section === undefined || !entry.isIntersecting || !enough || said.has(section)) continue
          said.add(section)
          const seen = seenOf(section, path)
          if (seen !== null) capture(seen.event, seen.properties)
        }
      },
      { threshold: [0, 0.25, SEEN, 0.75, 1] },
    )
    const watchAll = () => {
      for (const marked of document.querySelectorAll('[data-seen]')) watching.observe(marked)
    }
    watchAll()
    // What the page draws later is looked for once a frame at most, however much it changes.
    let frame = 0
    const added = new MutationObserver(() => {
      if (frame === 0)
        frame = requestAnimationFrame(() => {
          frame = 0
          watchAll()
        })
    })
    added.observe(document.body, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      added.disconnect()
      watching.disconnect()
    }
  }, [path])
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

/** What the directory was asked: whether words were typed (never which), and its filters. */
interface Asked {
  searched: boolean
  tag: string | null
  kind: string
  online: boolean
}

/**
 * Reports each answer the directory gives to a new search or filter, once its answer is in:
 * how many came back and what was asked, never the words. The first, unasked list is not one.
 */
export function useBrowseSteps(
  asked: Asked,
  answer: { data?: { listings: readonly unknown[] } | undefined; isPlaceholderData: boolean },
) {
  const last = useRef(JSON.stringify({ searched: false, tag: null, kind: 'any', online: false }))
  const key = JSON.stringify(asked)
  const results = answer.isPlaceholderData ? undefined : answer.data?.listings.length
  useEffect(() => {
    if (results === undefined || last.current === key) return
    last.current = key
    const { searched, tag, kind, online } = JSON.parse(key) as Asked
    capture(PUBLIC_EVENTS.browsed, {
      results,
      searched,
      tag: tag === null ? 'none' : asCode(tag.replaceAll('-', '_')),
      kind,
      online,
    })
  }, [key, results])
}

/** An invitation's answer to "Let me in": on the list (or already on it), or refused with its code. */
export function inviteAnswered(answer: { added: boolean } | { refused: string | null | undefined }): void {
  if ('added' in answer) capture(PUBLIC_EVENTS.joined, { added: answer.added })
  else capture(PUBLIC_EVENTS.joinFailed, { code: asCode(answer.refused) })
}
