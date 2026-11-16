// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The design system's disclosure (`.bk-reveal`, components.css) as a component: a control that
 * opens a region in place, the region growing from nothing as its content fades in, and inert
 * while closed, so nothing in it takes focus or reaches a screen reader. Open, it is marked
 * `data-open`, for a layout that makes room for it, until it has folded away again. The plan cards' "See
 * everything in Core" is one (plan-details.tsx). The sign-in page draws the same markup itself,
 * since it moves focus into the region as it opens (app/(auth)/auth-entry.tsx).
 */
import { type MouseEvent, type ReactNode, type TransitionEvent, useId, useState } from 'react'

export function Reveal({
  summary,
  className = '',
  toggleClassName = '',
  children,
}: {
  /** The control's words, and anything after them that turns as it opens. */
  summary: ReactNode
  className?: string
  toggleClassName?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Room is kept while it folds away, so a layout that made room for it gives it back only once
  // it has closed: dropped at once, the region still at full height would stretch its neighbours.
  const [room, setRoom] = useState(false)
  const region = useId()
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    if (!open) {
      setRoom(true)
      setOpen(true)
      return
    }
    setOpen(false)
    const folds = event.currentTarget.nextElementSibling
    const view = folds?.ownerDocument.defaultView
    const takes = folds && view ? Number.parseFloat(view.getComputedStyle(folds).transitionDuration) : 0
    if (!(takes > 0)) setRoom(false)
  }
  const folded = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.propertyName === 'grid-template-rows' && !open)
      setRoom(false)
  }
  return (
    <div className={className} data-open={room || undefined}>
      <button
        type="button"
        className={toggleClassName}
        aria-expanded={open}
        aria-controls={region}
        onClick={toggle}
      >
        {summary}
      </button>
      <div id={region} className="bk-reveal" data-open={open} inert={!open} onTransitionEnd={folded}>
        <div className="bk-reveal__inner">{children}</div>
      </div>
    </div>
  )
}
