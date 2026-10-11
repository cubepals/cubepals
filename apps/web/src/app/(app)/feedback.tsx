// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The sidebar's Feedback button and its popover: one box, sent to Cubepals' builder through the
 * control plane, which attaches who sent it. Not a form page and not PostHog's own widget.
 */
import type { Placement } from '@floating-ui/react'
import { useMutation } from '@tanstack/react-query'
import { CircleHelp } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { type KeyboardEvent, type SubmitEvent, useState } from 'react'
import { messageOf, useTRPC } from '../../lib/api'
import { APP_VERSION } from '../../lib/insight'
import { Button, ICON, Popover } from '../../ui'

/** The longest a line of feedback may be, as `insight.feedback` holds it. */
const FEEDBACK_MAX = 4000

/**
 * Telling Cubepals what's on your mind: a quiet icon at the foot of the sidebar (a small button at
 * the foot of the page on a phone) that opens one box and a Send button. Who sent it, the page,
 * the plan and the build go with it without being asked for. Esc or a press elsewhere puts it
 * away; Cmd or Ctrl with Enter sends.
 */
export function Feedback({
  placement,
  className,
  iconOnly = false,
}: {
  placement: Placement
  className: string
  /** Only the icon shows; its name is still read out, and shown on hover. */
  iconOnly?: boolean
}) {
  const trpc = useTRPC()
  const page = usePathname()
  const [open, setOpen] = useState(false)
  // Held here rather than in the popover, so a line half written survives a press elsewhere.
  const [text, setText] = useState('')
  const [thanked, setThanked] = useState(false)
  const send = useMutation(
    trpc.insight.feedback.mutationOptions({
      onSuccess: ({ sent }) => {
        if (!sent) return
        setText('')
        setThanked(true)
      },
    }),
  )
  const submit = () => {
    if (send.isPending || text.trim().length === 0) return
    setThanked(false)
    send.mutate({ text: text.trim(), page, version: APP_VERSION })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }
  const failed = send.isError
    ? messageOf(send.error)
    : send.data?.sent === false
      ? 'That didn’t send. Try again in a moment.'
      : null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Feedback"
      placement={placement}
      anchor={(reference) => (
        <button
          type="button"
          className={className}
          {...(iconOnly ? { 'aria-label': 'Feedback', title: 'Feedback' } : {})}
          {...reference()}
        >
          <CircleHelp {...(iconOnly ? { size: 16, strokeWidth: 1.75 } : ICON)} aria-hidden />
          {!iconOnly && 'Feedback'}
        </button>
      )}
    >
      <form
        className="bk-stack"
        style={{ gap: 'var(--space-12)', width: 'min(296px, calc(100vw - 50px))' }}
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          className="bk-input"
          rows={4}
          maxLength={FEEDBACK_MAX}
          aria-label="Feedback"
          placeholder="What’s on your mind?"
          dir="auto"
          value={text}
          style={{ resize: 'vertical', minHeight: 96 }}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            setText(event.target.value)
            setThanked(false)
            if (send.isError || send.data?.sent === false) send.reset()
          }}
        />
        {thanked && (
          <p className="type-body-sm" role="status">
            Thanks. It went straight to the person building this.
          </p>
        )}
        {failed !== null && (
          <p className="bk-field__error" role="alert">
            {failed}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={send.isPending || text.trim().length === 0}
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </Button>
      </form>
    </Popover>
  )
}
