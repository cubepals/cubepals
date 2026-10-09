'use client'

import {
  autoUpdate,
  FloatingPortal,
  flip,
  offset,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
  useTransitionStyles,
} from '@floating-ui/react'
import {
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useId,
  useRef,
  useState,
} from 'react'
import { TextField, type TextFieldProps } from './fields'

/** Something a field can offer, with a few words beside it where they help ("Playing now"). */
interface Suggestion {
  value: string
  note?: string
}

export interface SuggestFieldProps extends TextFieldProps {
  value: string
  /** What to offer, in the order to offer it, each value once. */
  suggestions: readonly Suggestion[]
  /** One was picked. It only fills the field: whatever the field is for still waits for its button. */
  onPick: (value: string) => void
}

/** The tallest the list grows: seven rows and half the eighth, so a longer one shows it goes on. */
const LIST_MAX_HEIGHT = 320

/**
 * A text field that offers what it knows: all of it while the field is empty, then whatever
 * holds what is typed, capitals aside. Up and Down move through the list, Enter puts the one
 * reached in the field, Escape puts the list away, and a click does what Enter does. Enter with
 * nothing reached still sends the form. With nothing to offer, it is a plain text field.
 *
 * Positioning, dismissal, the combobox and listbox roles and moving through the list come from
 * Floating UI; the look is Blockly's. Focus never leaves the field: the list is read through
 * `aria-activedescendant`, as a screen reader expects of a combobox.
 */
export function SuggestField({ suggestions, onPick, ...field }: SuggestFieldProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  const items = useRef<Array<HTMLElement | null>>([])
  const ids = useId()
  const typed = field.value.trim().toLowerCase()
  const shown = suggestions.filter((suggestion) => suggestion.value.toLowerCase().includes(typed))
  const offering = suggestions.length > 0
  const visible = open && shown.length > 0

  const { refs, floatingStyles, context } = useFloating({
    open: visible,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    // Placed by its top and left, so the list is free to rise into place.
    transform: false,
    middleware: [
      offset(6),
      flip({ padding: 12 }),
      size({
        padding: 12,
        apply({ rects, availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            width: `${rects.reference.width}px`,
            maxHeight: `${Math.min(availableHeight, LIST_MAX_HEIGHT)}px`,
          })
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  })
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    useRole(context, { role: 'combobox', enabled: offering }),
    useDismiss(context, { enabled: offering }),
    useListNavigation(context, {
      listRef: items,
      activeIndex: active,
      onNavigate: setActive,
      virtual: true,
      loop: true,
      enabled: offering,
    }),
  ])
  // --quick in and a shade quicker out, on Blockly's curve: a fade and a short drop from the field,
  // only the fade for someone who has asked for less motion. Typing past every suggestion puts the
  // list away at once: there is nothing left in it to fade.
  const still = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const { isMounted, styles } = useTransitionStyles(context, {
    duration: { open: 150, close: shown.length === 0 ? 0 : 100 },
    initial: ({ side }) =>
      still ? { opacity: 0 } : { opacity: 0, transform: `translateY(${side === 'top' ? 4 : -4}px)` },
    common: { transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)' },
  })

  const pick = (value: string) => {
    onPick(value)
    setOpen(false)
    setActive(null)
  }

  return (
    <>
      <TextField
        {...field}
        ref={refs.setReference}
        {...getReferenceProps({
          onFocus(event: FocusEvent<HTMLInputElement>) {
            field.onFocus?.(event)
            setOpen(true)
          },
          onBlur(event: FocusEvent<HTMLInputElement>) {
            field.onBlur?.(event)
            setOpen(false)
          },
          // Back after Escape put it away.
          onClick(event: MouseEvent<HTMLInputElement>) {
            field.onClick?.(event)
            setOpen(true)
          },
          onChange(event: ChangeEvent<HTMLInputElement>) {
            field.onChange?.(event)
            setOpen(true)
            setActive(null)
          },
          onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
            field.onKeyDown?.(event)
            if (event.key !== 'Enter') return
            const reached = visible && active !== null ? shown[active] : undefined
            if (reached === undefined) {
              // The form goes as it is; the list has had its say.
              setOpen(false)
              return
            }
            event.preventDefault()
            pick(reached.value)
          },
        })}
      />
      {isMounted && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="bk-suggest"
            style={{ ...floatingStyles, ...styles }}
            {...getFloatingProps({
              'aria-label': field.label,
              // Pressing anywhere on the list keeps the field focused: the list is part of it.
              onMouseDown: (event: MouseEvent) => event.preventDefault(),
            })}
          >
            {shown.map((suggestion, index) => (
              <div
                key={suggestion.value}
                ref={(node) => {
                  items.current[index] = node
                }}
                className="bk-suggest__option"
                {...getItemProps({
                  // Passed through here, it wins over the id Floating UI makes up for the row reached.
                  id: `${ids}-${index}`,
                  active: active === index,
                  selected: active === index,
                  onClick: () => pick(suggestion.value),
                })}
              >
                <span className="bk-suggest__value">{suggestion.value}</span>
                {suggestion.note && <span className="bk-suggest__note">{suggestion.note}</span>}
              </div>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
