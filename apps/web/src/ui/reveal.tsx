// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The design system's disclosure (`.bk-reveal`, components.css) as a component: a control that
 * opens a region in place, the region growing from nothing as its content fades in, and inert
 * while closed, so nothing in it takes focus or reaches a screen reader. The plan cards' "See
 * everything in Core" is one (plan-details.tsx). The sign-in page draws the same markup itself,
 * since it moves focus into the region as it opens (app/(auth)/auth-entry.tsx).
 */
import { type ReactNode, useId, useState } from 'react'

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
  const region = useId()
  return (
    <div className={className}>
      <button
        type="button"
        className={toggleClassName}
        aria-expanded={open}
        aria-controls={region}
        onClick={() => setOpen(!open)}
      >
        {summary}
      </button>
      <div id={region} className="bk-reveal" data-open={open} inert={!open}>
        <div className="bk-reveal__inner">{children}</div>
      </div>
    </div>
  )
}
