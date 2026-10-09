'use client'

/**
 * The proof of a beat, one layer down: the way in at the foot of the picture, and the panel that
 * opens the beat's section over it.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import styles from './film.module.css'

/**
 * The proof, one layer down. A beat says one sentence; whoever wants to see it shown presses
 * this, and the section that demonstrates it opens over the picture, on the side the picture can
 * spare. The picture steps aside for it and goes on following the demonstration. It is mounted
 * only while it is open, so a demonstration nobody asked for never runs.
 */
export function Proof({
  says,
  label,
  open,
  onOpen,
  children,
}: {
  /** What the way in says: a few words. */
  says: string
  /** What the panel is, for a screen reader. */
  label: string
  open: boolean
  onOpen: (open: boolean) => void
  children: ReactNode
}) {
  const id = useId()
  const panel = useRef<HTMLElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  // Whether it has been open since it was last given the focus back.
  const [was, setWas] = useState(false)

  useEffect(() => {
    if (open) {
      setWas(true)
      panel.current?.focus({ preventScroll: true })
      const closes = (event: KeyboardEvent) => {
        if (event.key === 'Escape') onOpen(false)
      }
      window.addEventListener('keydown', closes)
      return () => window.removeEventListener('keydown', closes)
    }
    if (was) {
      setWas(false)
      button.current?.focus({ preventScroll: true })
    }
  }, [open, was, onOpen])

  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.how}
        data-over
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpen(!open)}
      >
        {open ? 'Back to the picture' : says}
      </button>
      {open && (
        <section
          ref={panel}
          id={id}
          className={styles.proof}
          aria-label={label}
          tabIndex={-1}
          // It scrolls by itself, and the page's own scrolling leaves it to (Scroll.tsx).
          data-lenis-prevent
        >
          {children}
        </section>
      )}
    </>
  )
}
