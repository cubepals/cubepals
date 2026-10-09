'use client'

/**
 * The pointer on the landing page: the game's crosshair in place of the arrow, which closes round
 * whatever can be pressed and says what a click on the chunk would do.
 */
import { useEffect, useRef } from 'react'
import { stage } from './stage'

/** What the pointer can press: the cursor closes round it the way the game outlines a block. */
const PRESSABLE = 'a, button, [role="button"], [role="switch"], [role="tab"], [role="radio"], summary, label'
/** Where the device's own cursor is the right one: it shows where the typing goes. */
const TYPED = 'input, textarea, select, [contenteditable="true"]'

const CORNERS = ['top left', 'top right', 'bottom right', 'bottom left'] as const

/**
 * The page's own cursor, for a mouse: the game's crosshair, in the page's own pixels. Over
 * something that can be pressed it becomes the outline of that thing; over a block of the chunk
 * that can be dug it is the crosshair of someone holding a pickaxe, and says so until the first
 * block is dug; over a block that is kept it closes up. A finger
 * never sees it, and a field you type in keeps the device's own.
 */
export function Cursor() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const cursor = ref.current
    const root = cursor?.closest<HTMLElement>('[data-landing]')
    const mouse = window.matchMedia('(hover: hover) and (pointer: fine)')
    if (!cursor || !root || !mouse.matches) return
    const cross = cursor.querySelector<HTMLElement>('[data-part="cross"]')
    const box = cursor.querySelector<HTMLElement>('[data-part="box"]')
    const hint = cursor.querySelector<HTMLElement>('[data-part="hint"]')
    if (!cross || !box || !hint) return
    let at: { x: number; y: number } | null = null

    const place = () => {
      if (!at) {
        cursor.dataset.state = 'away'
        return
      }
      cross.style.translate = `${at.x}px ${at.y}px`
      hint.style.translate = `${at.x + 16}px ${at.y + 16}px`
      const over = document.elementFromPoint(at.x, at.y)
      const typed = over?.closest(TYPED)
      const found = typed ? null : over?.closest<HTMLElement>(PRESSABLE)
      // What can't be pressed just now isn't closed round as if it could.
      const pressable = found?.matches(':disabled, [aria-disabled="true"]') ? null : found
      if (pressable) {
        const rect = pressable.getBoundingClientRect()
        // From open ground the outline is simply there, round the thing: it steps across only
        // from one pressable straight to the next. Stepped in from wherever it last closed (the
        // screen's corner, the first time) it is seen at three places it has no business at.
        box.style.transition = cursor.dataset.state === 'press' ? '' : 'none'
        box.style.translate = `${Math.round(rect.left) - 6}px ${Math.round(rect.top) - 6}px`
        box.style.width = `${Math.round(rect.width) + 12}px`
        box.style.height = `${Math.round(rect.height) + 12}px`
      }
      const now = stage.get()
      cursor.dataset.state = typed
        ? 'away'
        : pressable
          ? 'press'
          : now.aim === 'dig'
            ? 'dig'
            : now.aim === 'kept'
              ? 'kept'
              : 'aim'
      cursor.toggleAttribute('data-hint', now.aim === 'dig' && now.dug === 0)
    }
    let waiting = 0
    const soon = () => {
      if (waiting) return
      waiting = requestAnimationFrame(() => {
        waiting = 0
        place()
      })
    }
    const moved = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      // The device's own cursor is given up only once the page's is on screen.
      root.dataset.cursor = 'on'
      at = { x: event.clientX, y: event.clientY }
      // The cross is where the pointer is at once. What it is over is work to find, so that is
      // done once a frame, after the chunk has aimed.
      cross.style.translate = `${at.x}px ${at.y}px`
      hint.style.translate = `${at.x + 16}px ${at.y + 16}px`
      soon()
    }
    const left = () => {
      at = null
      place()
    }
    const down = () => cursor.toggleAttribute('data-down', true)
    const up = () => cursor.toggleAttribute('data-down', false)

    window.addEventListener('pointermove', moved, { passive: true })
    window.addEventListener('pointerdown', down, { passive: true })
    window.addEventListener('pointerup', up, { passive: true })
    // The page moves under a pointer that is holding still, and what it is over changes. Finding
    // what is under the pointer is work, so it is done once a frame at most.
    window.addEventListener('scroll', soon, { passive: true })
    document.documentElement.addEventListener('pointerleave', left)
    // The stage changes for many reasons that are nothing to do with the pointer; only what the
    // pointer is on, and whether anything has been dug yet, are the cursor's business.
    let known = { aim: stage.get().aim, dug: stage.get().dug }
    const unsubscribe = stage.subscribe(() => {
      const now = stage.get()
      if (now.aim === known.aim && now.dug === known.dug) return
      known = { aim: now.aim, dug: now.dug }
      soon()
    })
    return () => {
      window.removeEventListener('pointermove', moved)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('scroll', soon)
      cancelAnimationFrame(waiting)
      document.documentElement.removeEventListener('pointerleave', left)
      unsubscribe()
      delete root.dataset.cursor
    }
  }, [])

  return (
    <div ref={ref} className="bl-cursor" data-state="away" aria-hidden>
      <span className="bl-cursor__box" data-part="box">
        {CORNERS.map((corner) => (
          <svg key={corner} viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden>
            <path d="M1 1h5v1H2v4H1z" />
          </svg>
        ))}
      </span>
      <svg
        className="bl-cursor__cross"
        data-part="cross"
        viewBox="0 0 13 13"
        shapeRendering="crispEdges"
        aria-hidden
      >
        {/* The game's crosshair, and the same with its middle open, to see the block through. */}
        <path data-for="aim" d="M6 2h1v4h4v1H7v4H6V7H2V6h4z" />
        <path data-for="dig" d="M6 0h1v4H6zM6 9h1v4H6zM0 6h4v1H0zM9 6h4v1H9z" />
        {/* Over a block that is kept: a small closed square, nothing to aim through. */}
        <path data-for="kept" d="M4 4h5v5H4zM5 5v3h3V5z" fillRule="evenodd" />
      </svg>
      <span className="bl-cursor__hint bl-game" data-part="hint">
        Click to dig
      </span>
    </div>
  )
}
