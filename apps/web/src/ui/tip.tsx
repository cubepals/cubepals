// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import {
  autoUpdate,
  FloatingPortal,
  flip,
  offset,
  safePolygon,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
  useTransitionStyles,
} from '@floating-ui/react'
import { type ReactNode, useState } from 'react'

/**
 * A few words that explain a line, on a dashed underline: they fade in on hover after a moment,
 * on keyboard focus, or on a tap where there is no hover, and go on Escape or a tap elsewhere.
 * Positioning, the hover delay, focus, dismissal and the tooltip role come from Floating UI;
 * the look is Blockly's. Opened from light text, the words sit on a dark surface (a paid plan's
 * card, the landing page's, dark mode), so the tip turns light and never melts into what it opens
 * over: the text's own color says so wherever the tip is used, with nothing to mark by hand.
 */
export function Tip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [onDark, setOnDark] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      const reference = refs.domReference.current
      if (next && reference) setOnDark(isLight(getComputedStyle(reference).color))
      setOpen(next)
    },
    placement: 'top-start',
    middleware: [offset(8), flip(), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  })
  const { getReferenceProps, getFloatingProps } = useInteractions([
    // A moment before it shows, so passing over the line doesn't flash it.
    // The pointer can cross to the tip and stay on it, for a link inside.
    useHover(context, { delay: { open: 180, close: 80 }, move: false, handleClose: safePolygon() }),
    useFocus(context),
    useClick(context, { ignoreMouse: true }),
    useDismiss(context),
    useRole(context, { role: 'tooltip' }),
  ])
  // --panel in, --quick out, on Blockly's own curve: a fade and a short rise — only the fade
  // for someone who has asked their system for less motion.
  const still = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const { isMounted, styles } = useTransitionStyles(context, {
    duration: { open: 220, close: 150 },
    initial: still ? { opacity: 0 } : { opacity: 0, transform: 'translateY(4px)' },
    common: { transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)' },
  })

  return (
    <>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus is how a keyboard reaches the tip */}
      <span ref={refs.setReference} className="bk-tip" tabIndex={0} {...getReferenceProps()}>
        {children}
      </span>
      {isMounted && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="bk-tip__float"
            style={floatingStyles}
            {...getFloatingProps()}
          >
            <div
              className={onDark ? 'bk-tip__bubble bk-tip__bubble--light' : 'bk-tip__bubble'}
              style={styles}
            >
              {tip}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

/** Whether a CSS color (`rgb(…)` or `rgba(…)`, as getComputedStyle gives it) is light: its relative luminance over half. */
export function isLight(color: string): boolean {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number)
  const linear = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) > 0.5
}
