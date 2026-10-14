// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The way into the beta letter and out of it. Opened from the banner or the tag, the letter's
 * yellow grows from what was pressed until it fills the screen: the banner slides down over the
 * page, the tag's box opens out. A browser with view transitions does it around the navigation
 * itself; one without gets a yellow layer that grows the same way, then the navigation. Leaving,
 * the yellow fades off whatever comes next. Someone who asked for less motion gets none of it,
 * only the page. The timings and curve are `letter-motion.css`'s; the letter's own entrance is
 * its page's (app/(public)/beta).
 */
import type { MouseEvent } from 'react'

/** What a press came from, and so where the yellow grows from. */
type From = 'banner' | 'tag'

/** How long the fill takes, as letter-motion.css has it: the letter's parts wait this long for it. */
export const FILL_MS = 500
/** The fill's length and curve, for the layer that stands in for a view transition. */
const FILL = { duration: FILL_MS, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
/** The fade off the letter. */
const FADE = { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
/** Longest a fill waits for the letter before letting the page go on without it. */
const PATIENCE = 2000

/** Resolved by the letter as it mounts (`letterArrived`), so a fill knows the page has come. */
let arrived: (() => void) | null = null

const stillness = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** The clip that shows only the box the yellow grows from, as `inset()` from the screen's edges. */
function clipFrom(target: Element, from: From): string {
  const tall = window.innerHeight
  const wide = window.innerWidth
  if (from === 'banner') {
    // The banner's own strip, across the whole width: it grows down from its foot.
    const foot = target.closest('section')?.getBoundingClientRect().bottom ?? 0
    return `inset(0 0 ${Math.max(0, tall - Math.max(0, foot))}px 0)`
  }
  const box = target.getBoundingClientRect()
  return `inset(${box.top}px ${wide - box.right}px ${tall - box.bottom}px ${box.left}px)`
}

/**
 * A press on a link to the letter: plays the fill into it and navigates with `go`. A press the
 * browser should keep (a new tab, a modifier), one on the letter itself, or one from someone who
 * asked for less motion is left to the link.
 */
export function openLetter(event: MouseEvent<HTMLAnchorElement>, from: From, go: () => void): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return
  if (window.location.pathname === '/beta' || stillness()) return
  event.preventDefault()
  const root = document.documentElement
  const clip = clipFrom(event.currentTarget, from)
  const come = new Promise<void>((resolve) => {
    arrived = resolve
    setTimeout(resolve, PATIENCE)
  })
  if (typeof document.startViewTransition === 'function') {
    root.style.setProperty('--letter-from', clip)
    root.setAttribute('data-letter-fill', '')
    const transition = document.startViewTransition(() => {
      go()
      return come
    })
    void transition.finished.finally(() => {
      root.removeAttribute('data-letter-fill')
      root.style.removeProperty('--letter-from')
    })
    return
  }
  // No view transitions: a layer of the letter's yellow grows over the page, then the page goes.
  const layer = document.createElement('div')
  layer.setAttribute('data-letter-layer', '')
  document.body.append(layer)
  const grow = layer.animate([{ clipPath: clip }, { clipPath: 'inset(0)' }], { ...FILL, fill: 'forwards' })
  void grow.finished.then(() => {
    go()
    void come.then(() => layer.remove())
  })
}

/** The letter is on screen: a fill waiting for it can finish. */
export function letterArrived(): void {
  arrived?.()
  arrived = null
}

/**
 * The letter has gone, by a link or by going back: its yellow fades off the page that replaced
 * it, rather than vanishing in one frame.
 */
export function fadeFromLetter(): void {
  if (stillness()) return
  const layer = document.createElement('div')
  layer.setAttribute('data-letter-layer', '')
  document.body.append(layer)
  void layer.animate([{ opacity: 1 }, { opacity: 0 }], FADE).finished.finally(() => layer.remove())
}
