// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The landing page's own scrolling (Lenis): beat to beat on a wide screen, a beat that is still
 * playing holding the page while the wheel moves its story along, and the small arrow at the
 * foot of the screen that gives under a push.
 */
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { useEffect, useRef } from 'react'
import 'lenis/dist/lenis.css'
import { playing } from './film/clock'
import { useReducedMotion } from './hooks'
import { stopOf } from './stops'

/** One place the page rests: a section, from where its words begin to where they end. */
interface Stop {
  /** The scroll position that shows the section's beginning. */
  start: number
  /** The scroll position that shows its end; the same as `start` when it fits one screen. */
  end: number
  name: string
  /** What the cue at this section's foot says, in place of "Next: …". */
  cue: string | undefined
  id: string
}

/** Keys that scroll a page, and how far: a part of a screen, or to one end of the page. */
const KEYS: Record<string, number | 'home' | 'end'> = {
  ArrowDown: 0.14,
  ArrowUp: -0.14,
  PageDown: 0.85,
  PageUp: -0.85,
  ' ': 0.85,
  Home: 'home',
  End: 'end',
}

/**
 * Where a key belongs to what has the focus, and not to the page. A section that was given the
 * focus by a link to it (tabindex -1) is not one of these: the keys still scroll from there.
 */
const OWN_KEYS = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  ...[
    'slider',
    'spinbutton',
    'tab',
    'radio',
    'switch',
    'button',
    'textbox',
    'listbox',
    'option',
    'menuitem',
  ].map((role) => `[role="${role}"]`),
].join(', ')

const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

/**
 * The page's own scrolling. Inside a section the page glides where the wheel sends it. Between
 * sections there is nothing to stop at, so it doesn't: a push past a section's end rides to the
 * beginning of the next, down through whatever is between, and the camera flies with it.
 *
 * The end of a section has a margin. Reaching it only stops there; it takes a new push, a
 * deliberate one, to go on, and a small arrow at the foot of the screen gives under it. Someone
 * reading the last lines of a section is never carried off by the tail of a scroll.
 *
 * All of this is for a wide screen and a wheel or keys. A finger scrolls as the phone scrolls, and
 * someone who asked their device for less motion gets the page's plain scrolling.
 */
export function Scroll() {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const cue = ref.current
    const root = cue?.closest<HTMLElement>('[data-landing]')
    if (!cue || !root) return
    if (reduced) return
    // How much of the push the mark is showing, so it is written only when it changes.
    let shown = ''
    const words = cue.querySelector<HTMLElement>('[data-part="words"]')
    const wide = window.matchMedia('(min-width: 1024px)')

    let stops: Stop[] = []
    let current = 0
    let riding = false
    // What took the keyboard's focus while the page was riding, if anything did.
    let taken: EventTarget | null = null
    const focused = (event: FocusEvent) => {
      if (riding) taken = event.target
    }
    // How far past the section's edge the reader has pushed, signed: down is positive.
    let push = 0
    // True once the scroll that brought the page to an edge is over, so the next one is a new push.
    let spent = false
    let lastWheel = 0
    let lastSize = 0
    let calm: ReturnType<typeof setTimeout> | undefined
    let settling: ReturnType<typeof setTimeout> | undefined
    let lastY = window.scrollY
    // Where the page last came to rest: in which section, how far down the page, and where that
    // section began then.
    let rest: { index: number; y: number; start: number } | null = null

    /** How hard a push has to be to leave a section: most of a third of a screen of wheel. */
    const margin = () => window.innerHeight * 0.28

    const measure = () => {
      const tall = window.innerHeight
      // Only a page that was within its section can be left past its end by it getting shorter.
      const was = stops[current]
      const within = was !== undefined && window.scrollY <= was.end + 3
      const sections = [...root.querySelectorAll<HTMLElement>('.bl-dig > .bl-section')].filter(
        // A section that isn't laid out (the other worlds, without the drawing) is no place to rest.
        (section) => section.getClientRects().length > 0,
      )
      stops = sections.map((section) => ({
        ...stopOf(section, tall),
        name: section.dataset.name ?? '',
        cue: section.dataset.cue,
        id: section.id,
      }))
      // After the last section there is only the foot of the page, and it is scrolled to freely.
      const last = stops[stops.length - 1]
      if (last) last.end = Math.max(last.end, document.documentElement.scrollHeight - tall)
      // Something above the reader changed height (a demonstration further up playing itself, a
      // heading settling): the section being read has moved on the page. Where the browser hasn't
      // already kept the reader's place, the page is moved with the section, at once.
      const now = rest ? stops[rest.index] : undefined
      if (rest && now && wide.matches && !underWay() && now.start !== rest.start) {
        const kept = rest.y + (now.start - rest.start)
        if (Math.abs(window.scrollY - rest.y) <= 2 && Math.abs(window.scrollY - kept) > 1)
          lenis.scrollTo(kept, { immediate: true, force: true })
      }
      locate()
      mark()
      // A section that got shorter while the page rested at its foot (a demonstration folding
      // something away) would leave the page past its end: it is put back on the end at once,
      // with the fold. Glided back, the page spends a second in the gap, where the camera takes
      // it for the start of a ride, and a second fold a moment later finds the page no longer
      // `within` and leaves it there.
      const here = stops[current]
      if (
        within &&
        wide.matches &&
        !underWay() &&
        here &&
        current < stops.length - 1 &&
        window.scrollY > here.end + 3
      )
        lenis.scrollTo(here.end, { immediate: true, force: true })
      say()
    }

    /** Notes where the page is resting, and where its section began at the time. */
    const mark = () => {
      const stop = stops[current]
      rest = stop && !underWay() ? { index: current, y: window.scrollY, start: stop.start } : null
    }

    /** Which section the page is in: the one it is showing, or the last one it left. */
    const locate = () => {
      const y = window.scrollY
      const at = stops.findIndex((stop) => y >= stop.start - 3 && y <= stop.end + 3)
      if (at >= 0) current = at
      else
        current = Math.max(
          0,
          stops.findLastIndex((stop) => stop.start <= y),
        )
    }

    /** The mark: shown at a section's foot, and while a push is being given, giving with it. */
    const say = () => {
      const stop = stops[current]
      const y = window.scrollY
      const steering = wide.matches && stop !== undefined && !underWay()
      // The arrow is the way on, and while a beat is still playing there isn't one yet.
      const atEnd = steering && !playing.busy && Math.abs(y - stop.end) < 4 && current < stops.length - 1
      const back = steering && push < 0 && current > 0
      if (!(atEnd || back)) {
        cue.removeAttribute('data-shown')
        return
      }
      const to = stops[back ? current - 1 : current + 1]
      if (!to || !words) return
      cue.toggleAttribute('data-shown', true)
      const way = back ? 'up' : 'down'
      if (cue.dataset.way !== way) cue.dataset.way = way
      // Only the first screen says anything; everywhere else the arrow is enough.
      const line = back ? '' : (stop.cue ?? '')
      if (words.textContent !== line) words.textContent = line
      const given = clamp(Math.abs(push) / margin(), 0, 1).toFixed(2)
      if (given !== shown) {
        cue.style.setProperty('--push', given)
        shown = given
      }
    }

    const lenis = new Lenis({
      autoRaf: true,
      lerp: 0.085,
      wheelMultiplier: 0.9,
      // Every turn of the wheel passes through here first.
      virtualScroll: (data) => {
        if (!data.event.type.includes('wheel') || data.event.ctrlKey) return true
        // A wheel turned over something that scrolls by itself (the proof, open over the picture)
        // is that thing's own, and Lenis leaves it alone too.
        if (data.event.target instanceof Element && data.event.target.closest('[data-lenis-prevent]'))
          return true
        const keep = steer(data.deltaY, false)
        if (keep === false) {
          if (data.event.cancelable) data.event.preventDefault()
          return false
        }
        data.deltaY = keep
        return true
      },
    })
    // What the type does is tied to the scroll (Type.tsx), so it is told of every step of the glide.
    lenis.on('scroll', ScrollTrigger.update)

    const ride = (to: number, index: number) => {
      // The beat it comes to is found at its start from above, and as it ended from below.
      playing.heading = to >= window.scrollY ? 1 : -1
      riding = true
      taken = null
      push = 0
      spent = true
      clearTimeout(calm)
      cue.removeAttribute('data-shown')
      // It lets go of the push as it goes, so it is at rest when it next shows.
      cue.style.setProperty('--push', '0.00')
      shown = '0.00'
      const far = Math.abs(to - window.scrollY)
      lenis.scrollTo(to, {
        // A ride can be sent somewhere else while it is under way (a link pressed mid-flight).
        force: true,
        lock: true,
        // A ride of a few pixels is over sooner than one to the next section.
        duration: far < 420 ? 0.5 + (far / 420) * 0.65 : clamp(1 + far / 2800, 1.15, 2.8),
        easing: inOut,
        onComplete: () => {
          riding = false
          current = index
          lastY = window.scrollY
          mark()
          say()
          // A control that took the focus while the page was riding was never brought into view:
          // the ride held the page. It is now. Only one that took it during this ride: a control
          // pressed before it keeps the focus, and bringing that one back into view would undo
          // every ride away from its section.
          const held = taken
          taken = null
          if (
            held instanceof HTMLElement &&
            held === document.activeElement &&
            held.closest('.bl-dig') &&
            !held.matches('.bl-section')
          ) {
            const box = held.getBoundingClientRect()
            if (box.top < 0 || box.bottom > window.innerHeight) held.scrollIntoView({ block: 'nearest' })
          }
        },
      })
    }

    /** Lenis drops a ride without a word when it is reset under it (a middle click does that). */
    const underWay = () => {
      if (riding && !lenis.isLocked) {
        riding = false
        locate()
        lastY = window.scrollY
      }
      return riding
    }

    /**
     * What to do with a scroll of `delta`: how much of it the page may move by, or false when it
     * is taken as a push against the section's edge (or nothing at all). `fresh` says it is
     * certainly a new gesture: a key, not the tail of a wheel still spinning down.
     */
    const steer = (delta: number, fresh: boolean): number | false => {
      const stop = stops[current]
      if (!wide.matches || !stop) return delta
      const now = performance.now()
      const size = Math.abs(delta)
      if (underWay()) {
        // The wheel still spinning down from the push that began this ride is kept account of, so
        // its tail isn't taken for a new push when the ride ends.
        if (!fresh) {
          lastWheel = now
          lastSize = lastSize * 0.6 + size * 0.4
        }
        return false
      }
      // A beat that is still playing holds the page: scrolling on hurries its story along, and
      // only once it has finished is a push a push again (film/clock.ts).
      // The other way, a beat that has played at all is played backwards before it is left.
      if (delta > 0 ? playing.busy : playing.at > 0) {
        playing.hurry((fresh ? size * 0.5 : size) * Math.sign(delta))
        lastWheel = now
        lastSize = lastSize * 0.6 + size * 0.4
        spent = true
        push = 0
        return false
      }
      // A wheel that had gone quiet, or one that speeds up again, is a new push.
      if (fresh || now - lastWheel > 160 || (size > lastSize * 1.8 && size > 14)) spent = false
      lastWheel = now
      lastSize = lastSize * 0.6 + size * 0.4
      const from = lenis.targetScroll
      const down = delta > 0
      const edge = down ? stop.end : stop.start
      const beyond = down ? from + delta > edge + 1 : from + delta < edge - 1
      const there = down ? current < stops.length - 1 : current > 0
      if (!beyond || !there) {
        push = 0
        say()
        return delta
      }
      // Arriving at the edge: stop on it, and count this gesture as used up.
      if (down ? from < edge - 2 : from > edge + 2) {
        spent = true
        push = 0
        return edge - from
      }
      if (spent) return false
      push += delta * (fresh ? 1 : 0.8)
      clearTimeout(calm)
      if (Math.abs(push) >= margin()) {
        const to = stops[current + (down ? 1 : -1)] as Stop
        ride(down ? to.start : to.end, current + (down ? 1 : -1))
        return false
      }
      // A push given up on drains away. One made with a key is nobody's tail, and waits longer.
      calm = setTimeout(
        () => {
          push = 0
          say()
        },
        fresh ? 6000 : 900,
      )
      say()
      return false
    }

    /**
     * After any scroll the page didn't steer (a dragged scrollbar, a finger, the browser bringing
     * a focused control into view): if it has come to rest between two sections, it goes on to
     * the one it was heading for.
     */
    const settle = () => {
      if (underWay() || !wide.matches || stops.length === 0) return
      // Nothing is ridden out from under a finger that is still on the screen.
      if (lenis.isTouching) {
        settling = setTimeout(settle, 220)
        return
      }
      const y = window.scrollY
      const down = y >= lastY
      lastY = y
      const inside = stops.findIndex((stop) => y >= stop.start - 3 && y <= stop.end + 3)
      if (inside >= 0) {
        current = inside
        say()
        return
      }
      const below = stops.findIndex((stop) => stop.start > y)
      const above = below < 0 ? stops.length - 1 : below - 1
      // What the browser just put in the middle of the screen (a control it brought into view, a
      // match it found) stays on screen: the page goes to the neighbour that still shows it. On
      // open ground it goes on the way it was heading.
      const tall = window.innerHeight
      const middle = y + tall / 2
      const next = stops[below]
      const last = stops[above]
      if (next && middle >= next.start) ride(next.start, below)
      else if (last && middle <= last.end + tall) ride(last.end, above)
      else if (down && next) ride(next.start, below)
      else if (last) ride(last.end, above)
    }
    const scrolled = () => {
      clearTimeout(settling)
      if (!underWay()) {
        locate()
        mark()
        say()
        settling = setTimeout(settle, 220)
      }
    }

    const keyed = (event: KeyboardEvent) => {
      if (!wide.matches || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      // Shift with anything but the space bar is selecting text, and is the browser's.
      if (event.shiftKey && event.key !== ' ') return
      const by = KEYS[event.key]
      if (by === undefined) return
      const target = event.target
      if (target instanceof Element && target !== document.body && target.closest(OWN_KEYS)) return
      if (target instanceof Element && target.closest('[data-lenis-prevent]')) return
      event.preventDefault()
      if (underWay()) return
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (by === 'home' && first) return ride(first.start, 0)
      if (by === 'end' && last) return ride(last.end, stops.length - 1)
      if (typeof by !== 'number') return
      const delta = (event.key === ' ' && event.shiftKey ? -by : by) * window.innerHeight
      const keep = steer(delta, true)
      // As a wheel's scroll is, so one press adds to the last and the glide's end is known at once.
      if (keep !== false)
        lenis.scrollTo(lenis.targetScroll + keep, { programmatic: false, lerp: lenis.options.lerp })
    }

    /** A link to a place on the page rides to that section, not to wherever the browser would jump. */
    const linked = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
        return
      const link = (event.target as Element | null)?.closest?.('a[href]')
      if (!(link instanceof HTMLAnchorElement)) return
      const url = new URL(link.href)
      if (url.origin !== location.origin || url.pathname !== location.pathname || url.hash.length < 2) return
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)))
      if (!target) return
      event.preventDefault()
      history.pushState(null, '', url.hash)
      const index = stops.findIndex((stop) => stop.id === target.id)
      const done = () => {
        // What the browser's own jump would have done for a keyboard: carry on from there. The
        // heading takes the focus, so a screen reader says where the link led.
        const to = target.querySelector<HTMLElement>('h1, h2') ?? target
        to.setAttribute('tabindex', '-1')
        to.focus({ preventScroll: true })
      }
      if (wide.matches && index >= 0) {
        ride((stops[index] as Stop).start, index)
        setTimeout(done, 400)
        return
      }
      const far = Math.abs(target.getBoundingClientRect().top)
      lenis.scrollTo(target, { duration: Math.min(2.8, 0.9 + far / 7000), easing: inOut, onComplete: done })
    }

    const unheard = playing.listen(() => {
      // The beat has come to its end, or back to its start, under a hand that is still
      // scrolling: the same scroll carries on to the next beat, it doesn't have to be given again.
      spent = false
      say()
    })
    measure()
    // A page opened part-way down a gap (a reload, a link with a place in it) goes to a section.
    settling = setTimeout(settle, 600)
    const sized = new ResizeObserver(measure)
    sized.observe(root)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', scrolled, { passive: true })
    window.addEventListener('keydown', keyed)
    document.addEventListener('click', linked)
    document.addEventListener('focusin', focused)
    return () => {
      clearTimeout(calm)
      clearTimeout(settling)
      sized.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', scrolled)
      window.removeEventListener('keydown', keyed)
      document.removeEventListener('click', linked)
      document.removeEventListener('focusin', focused)
      unheard()
      lenis.destroy()
      // The mark belongs to this scrolling: without it (less motion asked for a moment after the
      // page loaded) it would stay where it was last shown, on every section.
      cue.removeAttribute('data-shown')
    }
  }, [reduced])

  return (
    <div ref={ref} className="bl-next bl-game" aria-hidden>
      <span data-part="words" />
      {/* A stepped V, five pixels across, and a second behind it that grows with the push. */}
      {['mark', 'mark echo'].map((kind) => (
        <svg
          key={kind}
          className={kind === 'mark' ? 'bl-next__mark' : 'bl-next__mark bl-next__echo'}
          viewBox="0 0 5 3"
          shapeRendering="crispEdges"
          aria-hidden
        >
          <path d="M0 0h1v1h1v1h1V1h1V0h1v1H4v1H3v1H2V2H1V1H0z" />
        </svg>
      ))}
    </div>
  )
}
