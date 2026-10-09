'use client'

import type { PublicServerView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../lib/api'
import type { Rule } from '../../lib/rules'
import { useChecked } from '../../lib/use-checked'
import { Button, Popover, TextField } from '../../ui'

/** The longest a report may be, as `listings.report` holds it. */
const REPORT_MAX = 500

/** Why a server is reported: a few words at least, since it is the first thing an admin reads. */
export const reportReason: Rule = (value) => {
  const wanted = value.trim()
  if (wanted.length === 0) return null
  if (wanted.length < 3) return 'Say a little more, so Cubepals knows what to look at.'
  return wanted.length <= REPORT_MAX ? null : `A report is up to ${REPORT_MAX} characters.`
}

/**
 * The server a report from this page would be about, or null where the page offers none. It is
 * offered on a server's public page to someone signed in whose server it isn't: an invitation is
 * a link its owner sent to friends, and an owner's own page has nothing to report to them.
 */
export const reportable = (view: PublicServerView, signedIn: boolean): string | null =>
  signedIn && view.reactions !== null && !view.yours ? view.reactions.serverId : null

/**
 * Telling Blockly something is wrong with a server: one small word at the foot of its page, and a
 * line saying what, in a popover beside it. It goes to the admins, and says so once it has.
 */
export function ReportServer({ serverId }: { serverId: string }) {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  // Held here rather than in the popover, so a reason half written survives a press elsewhere.
  const [reason, setReason] = useState('')
  const report = useMutation(trpc.listings.report.mutationOptions())
  const checked = useChecked(reportReason, reason)
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (report.isPending || !checked.check()) return
    report.mutate({ serverId, reason: reason.trim() })
  }
  // A page that went private meanwhile, or one Blockly doesn't take reports on yet.
  const refused = report.isError
    ? isNotFound(report.error)
      ? 'Cubepals can’t take a report on this server right now.'
      : messageOf(report.error)
    : null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Report this server"
      anchor={(reference) => (
        <button type="button" className="bk-btn bk-btn--ghost bk-btn--sm" {...reference()}>
          {report.isSuccess ? 'Reported' : 'Report'}
        </button>
      )}
    >
      {report.isSuccess ? (
        <p className="type-body-sm" style={{ width: 'min(288px, calc(100vw - 50px))' }}>
          Thanks. Cubepals’ team will look at it.
        </p>
      ) : (
        <form
          className="bk-stack"
          style={{ gap: 'var(--space-12)', width: 'min(288px, calc(100vw - 50px))' }}
          onSubmit={submit}
        >
          <TextField
            label="What’s wrong with this server?"
            value={reason}
            maxLength={REPORT_MAX}
            autoComplete="off"
            dir="auto"
            error={checked.error ?? refused}
            onChange={(event) => {
              setReason(event.target.value)
              if (report.isError) report.reset()
            }}
            {...checked.field}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={report.isPending || reason.trim().length < 3}
          >
            {report.isPending ? 'Sending…' : 'Send report'}
          </Button>
        </form>
      )}
    </Popover>
  )
}
