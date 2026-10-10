// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { Check, Copy } from 'lucide-react'
import Link from 'next/link'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from './Button'

/** A native dialog: focus trapping, Esc and the top layer for free. Opens and closes by `open`. */
export function Modal({
  open,
  onClose,
  title,
  actions,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** Right-aligned; Cancel first, the committing action last. */
  actions: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click is for the backdrop; Esc is its keyboard equivalent, and the dialog handles it natively.
    <dialog
      ref={ref}
      className="bk-dialog"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) onClose()
      }}
    >
      <div className="bk-modal">
        <h2 className="bk-modal__title">{title}</h2>
        <div className="bk-modal__body">{children}</div>
        <div className="bk-modal__actions">{actions}</div>
      </div>
    </dialog>
  )
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  variant = 'pill',
  label,
}: {
  items: Array<{ value: T; label: string; count?: number }>
  value: T
  onChange: (value: T) => void
  variant?: 'pill' | 'underline'
  label: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={['bk-tabs', variant === 'underline' && 'bk-tabs--underline'].filter(Boolean).join(' ')}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className="bk-tab"
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count !== undefined && <span className="bk-tab__count bk-num">{item.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Underline tabs that navigate: a screen's primary sections. */
export function NavTabs({
  items,
  current,
  label = 'Server sections',
}: {
  items: Array<{ href: string; label: string }>
  current: string
  label?: string
}) {
  return (
    <nav className="bk-tabs bk-tabs--underline" aria-label={label}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="bk-tab"
          aria-current={item.href === current ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}

/** The address, and a button that copies it. The icon cross-fades to a check once it has. */
export function CopyField({
  value,
  label = 'Copy address',
  concealed = false,
}: {
  value: string
  label?: string
  /** Only the button: for what is pasted rather than read, like a long download link. */
  concealed?: boolean
}) {
  const [done, setDone] = useState<'copied' | 'selected' | null>(null)
  const shown = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (done === null) return
    // Long enough to read what to press, when it was selected rather than copied.
    const timer = setTimeout(() => setDone(null), done === 'copied' ? 1600 : 4000)
    return () => clearTimeout(timer)
  }, [done])
  return (
    <div className={concealed ? 'bk-copyfield bk-copyfield--concealed' : 'bk-copyfield'}>
      <span ref={shown} className={concealed ? 'bk-visually-hidden' : 'bk-copyfield__value'}>
        {value}
      </span>
      <button
        type="button"
        className="bk-btn bk-btn--outline bk-btn--sm bk-btn--lead"
        onClick={async () => {
          // The clipboard API exists only in a secure context. A page opened at a network address
          // (the dev stack on another device) has no way left to write the clipboard, so the
          // address is selected for the keyboard's own copy.
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value)
            setDone('copied')
          } else if (shown.current !== null) {
            window.getSelection()?.selectAllChildren(shown.current)
            setDone('selected')
          }
        }}
      >
        <span className="bk-btn__icon bk-swap" aria-hidden>
          <Copy size={16} strokeWidth={1.75} data-shown={done === null} />
          <Check size={16} strokeWidth={2} data-shown={done !== null} />
        </span>
        {done === 'copied' ? 'Copied' : done === 'selected' ? 'Selected: press ⌘C or Ctrl+C' : label}
      </button>
    </div>
  )
}

/**
 * A button that opens the file picker. The input stays in the page, out of sight, so the file it
 * holds can be read; the button is what keyboards and screen readers reach.
 */
export function FileButton({
  accept,
  disabled,
  icon,
  children,
  onFile,
}: {
  accept: string
  disabled?: boolean
  icon?: ReactNode
  children: ReactNode
  onFile: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="bk-visually-hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          // The same file chosen again is a new choice.
          event.target.value = ''
          if (file) onFile(file)
        }}
      />
      <Button variant="outline" icon={icon} disabled={disabled} onClick={() => input.current?.click()}>
        {children}
      </Button>
    </>
  )
}

/** How far along a long task is, from 0 to 100. */
export function ProgressBar({
  value,
  label,
  onPaper,
}: {
  value: number
  label: string
  /** On a light card rather than the dark provisioning panel, where the track has to be light. */
  onPaper?: boolean
}) {
  return (
    <div
      className={onPaper ? 'bk-prov__bar bk-prov__bar--paper' : 'bk-prov__bar'}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <div className="bk-prov__fill" style={{ '--progress': value } as React.CSSProperties} />
    </div>
  )
}
