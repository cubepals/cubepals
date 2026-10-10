// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  type Placement,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  useTransitionStyles,
} from '@floating-ui/react'
import type { HTMLProps, ReactNode, RefObject } from 'react'

/** What the element a popover opens from spreads on itself, with its own props passed through. */
export type PopoverAnchor = (props?: HTMLProps<Element>) => Record<string, unknown>

/**
 * A few lines that open from what was pressed and stay beside it, never a modal: nothing dims,
 * and the page stays readable and in reach around it. Escape, a press elsewhere or tabbing past
 * it puts it away, and focus goes back to what opened it. Positioning, dismissal, focus and the
 * dialog role come from Floating UI; the look is Blockly's.
 *
 * `alert` is for an anchor with a job of its own, like a star: pressing it does that job, and the
 * popover opens only when there is something to say about it. Then it is read out rather than
 * entered, and focus stays on the anchor.
 */
export function Popover({
  open,
  onOpenChange,
  label,
  anchor,
  alert = false,
  initialFocus,
  placement = 'bottom-end',
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What a screen reader calls it. */
  label: string
  /** The element it opens from, given what anchors it there. */
  anchor: (reference: PopoverAnchor) => ReactNode
  alert?: boolean
  /** What takes focus as it opens; the first thing in it that can, when left out. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Where it hangs from what opened it: below its end unless said otherwise. */
  placement?: Placement
  children: ReactNode
}) {
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    // Hung from the end of what opened it, which sits at the end of its row, unless asked otherwise.
    placement,
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  })
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context, { enabled: !alert }),
    useDismiss(context),
    useRole(context, { role: 'dialog', enabled: !alert }),
  ])
  // --quick in and a shade quicker out, on Blockly's curve: a fade and a short drop from what
  // opened it, grown from the corner nearest it; only the fade for someone who has asked for less
  // motion.
  const still = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const { isMounted, styles } = useTransitionStyles(context, {
    duration: { open: 150, close: 100 },
    initial: ({ side }) =>
      still
        ? { opacity: 0 }
        : { opacity: 0, transform: `translateY(${side === 'top' ? 4 : -4}px) scale(0.97)` },
    common: ({ placement }) => ({
      transformOrigin: ORIGINS[placement],
      transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
    }),
  })

  return (
    <>
      {anchor((props) => ({
        ref: refs.setReference,
        // What holds the anchor can stay as it is while the popover is open (a card keeps its lift).
        'data-open': open || undefined,
        ...getReferenceProps(props),
      }))}
      {isMounted && (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            modal={false}
            initialFocus={alert ? -1 : initialFocus}
            // Focus never goes into an alert, so there is nothing to give back.
            returnFocus={!alert}
            // A note deleted from under the keyboard leaves focus in the popover, not on the page.
            restoreFocus
          >
            <div
              ref={refs.setFloating}
              className="bk-popover"
              style={floatingStyles}
              {...getFloatingProps(alert ? {} : { 'aria-label': label })}
            >
              <div className="bk-popover__panel" style={styles} role={alert ? 'alert' : undefined}>
                {children}
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}

/** The corner of the popover nearest what opened it, for each place it can hang. */
const ORIGINS: Record<Placement, string> = {
  top: 'bottom',
  'top-start': 'bottom left',
  'top-end': 'bottom right',
  bottom: 'top',
  'bottom-start': 'top left',
  'bottom-end': 'top right',
  left: 'right',
  'left-start': 'top right',
  'left-end': 'bottom right',
  right: 'left',
  'right-start': 'top left',
  'right-end': 'bottom left',
}
