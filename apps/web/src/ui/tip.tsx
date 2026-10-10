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
 * the look is Blockly's. On a forest surface (`data-surface="forest"`, such as a paid plan's card)
 * the tip is light, so it never melts into the card it opens over.
 */
export function Tip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [onForest, setOnForest] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      if (next) setOnForest(Boolean(refs.domReference.current?.closest('[data-surface="forest"]')))
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
              className={onForest ? 'bk-tip__bubble bk-tip__bubble--light' : 'bk-tip__bubble'}
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
