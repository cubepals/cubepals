// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * What the type does in time with the scroll (GSAP): the headline's lines drifting apart as the
 * dig begins, and each heading further down printed a line at a time as it is reached.
 */
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import { useEffect, useRef } from 'react'

/** How far each line of the headline slides as the hero is scrolled away, in screen widths. */
const DRIFT = [-0.07, 0.06, -0.11, 0.05]

/**
 * The words' part in the journey. The camera does the travelling; the type keeps time with it.
 * The headline's lines slide apart as the dig begins, each its own way, tied to the scroll, and
 * every heading further down is printed a line at a time as it is reached, in a few steps, the
 * way the chunk's shadows move. Each heading is put back as it was written once it has arrived.
 * None of it runs for someone who asked their device for less motion: the words are just there.
 */
export function Type() {
  const marker = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const root = marker.current?.closest<HTMLElement>('[data-landing]')
    if (!root) return
    gsap.registerPlugin(ScrollTrigger, SplitText)
    const media = gsap.matchMedia()

    media.add('(prefers-reduced-motion: no-preference)', () => {
      const splits = [...root.querySelectorAll<HTMLElement>('.bl-dig h2')].map((heading) =>
        SplitText.create(heading, {
          type: 'lines',
          mask: 'lines',
          linesClass: 'bl-line',
          autoSplit: true,
          onSplit: (self) =>
            gsap.from(self.lines, {
              yPercent: 112,
              duration: 0.6,
              stagger: 0.1,
              ease: 'steps(6)',
              scrollTrigger: { trigger: heading, start: 'top 88%', once: true },
              onComplete: () => self.revert(),
            }),
        }),
      )
      return () => {
        for (const split of splits) split.revert()
      }
    })

    media.add('(prefers-reduced-motion: no-preference) and (min-width: 1024px)', () => {
      const hero = root.querySelector<HTMLElement>('[data-sky]')
      const headline = hero?.querySelector<HTMLElement>('h1')
      if (!hero || !headline) return
      const split = SplitText.create(headline, {
        type: 'lines',
        linesClass: 'bl-line',
        autoSplit: true,
        onSplit: (self) =>
          gsap.to(self.lines, {
            x: (index) => (DRIFT[index % DRIFT.length] ?? 0) * window.innerWidth,
            ease: 'none',
            scrollTrigger: {
              trigger: hero,
              start: 'top top',
              end: 'bottom top',
              scrub: true,
              invalidateOnRefresh: true,
            },
          }),
      })
      return () => split.revert()
    })

    // Everything on the page mounts in one pass with this, and some of it changes the page's
    // height as it does: with no drawing, Chunk.tsx folds the scenes away and leaves the other
    // worlds out, after the triggers above were placed. They are placed again once it is all in,
    // or the headings below would wait for a scroll position the shorter page never reaches.
    const placed = requestAnimationFrame(() => ScrollTrigger.refresh())

    return () => {
      cancelAnimationFrame(placed)
      media.revert()
    }
  }, [])

  return <span ref={marker} hidden />
}
