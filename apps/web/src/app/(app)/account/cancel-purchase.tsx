// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Cancelling a purchase within 14 days of buying it, on the account page: each purchase of the
 * last 14 days that still can be, and each that was. Two steps, as the law asks: "Cancel purchase"
 * opens the same confirmation the site shows before anything destructive, which says what happens
 * and what comes back before "Confirm cancellation". Emailing support stays another way. What can
 * be cancelled and what it gives back is the control plane's (`billing.cancellable`); it pays
 * nothing out.
 */
import type { WithdrawalView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { FULL_REFUND_UNDER_HOURS } from '../../../legal/figures'
import { OPERATOR } from '../../../legal/operator'
import { messageOf, useTRPC } from '../../../lib/api'
import { ActionButton, Button, FormRow, FormSection, ICON, Modal, Note } from '../../../ui'

/** Money, as people write it: "$4.20". */
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/** "11 Nov 2026". */
const dayOf = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** "11 Nov 2026, 14:05". */
const momentOf = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

const capital = (s: string) => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`

/** What cancelling it stops, said before it is confirmed. */
function whatEnds(purchase: WithdrawalView): string {
  if (purchase.kind === 'gift')
    return 'Its code stops working straight away. If it was redeemed, the time it gave that account ends now.'
  if (purchase.kind === 'chip_in') return 'The hours of it nobody has played can’t be played any more.'
  if (purchase.rule === 'unstarted') return 'It won’t start, and nothing more is charged for it.'
  return 'It ends straight away, and nothing more is charged for it. Your account moves to the free trial, and your worlds are kept.'
}

/** Why the rule gives back what it does. */
function why(purchase: WithdrawalView): string {
  switch (purchase.rule) {
    case 'full':
      return `, since you played less than ${FULL_REFUND_UNDER_HOURS} hours and it’s the first time you’ve had a full refund`
    case 'played':
      // Nothing played takes nothing off, and saying "less the 0 hours" would read as a slip.
      return purchase.refundCents === purchase.paidCents
        ? ''
        : `, less the ${purchase.hoursPlayed ?? 0} hours you played`
    case 'unplayed':
      return ', for the hours nobody has played'
    default:
      return ''
  }
}

/** What comes back, as the Refunds page's rule gives it now. */
const comesBack = (purchase: WithdrawalView) =>
  purchase.refundCents === purchase.paidCents
    ? `You get everything back: ${money(purchase.paidCents)}${why(purchase)}.`
    : `You get back ${money(purchase.refundCents)} of the ${money(purchase.paidCents)} you paid${why(purchase)}.`

/** Nothing at all when nothing of the last 14 days can be cancelled, or was. */
export function CancelPurchase({ email }: { email: string }) {
  const trpc = useTRPC()
  const listed = useQuery(trpc.billing.cancellable.queryOptions())
  const [asking, setAsking] = useState<WithdrawalView | null>(null)
  if (!listed.data || listed.data.length === 0) return null
  return (
    <FormSection
      title="Cancel within 14 days"
      description={
        <>
          You can cancel something you bought within 14 days of buying it, here or by emailing{' '}
          <a href={`mailto:${OPERATOR.emails.support}`}>{OPERATOR.emails.support}</a>. What you get back is
          set out on our <Link href="/legal/refunds">Refunds</Link> page.
        </>
      }
    >
      {listed.data.map((purchase) => (
        <FormRow
          key={purchase.order}
          label={capital(purchase.title)}
          description={
            purchase.requestedAt === null
              ? `Bought on ${dayOf(purchase.boughtAt)}. You can cancel it until ${dayOf(purchase.until)}. ${comesBack(purchase)}`
              : `Cancelled on ${momentOf(purchase.requestedAt)}. Your refund of ${money(purchase.refundCents)} follows within 14 days, to the payment method you used. We emailed you a confirmation.`
          }
          control={
            purchase.requestedAt === null ? (
              <Button variant="outline" onClick={() => setAsking(purchase)}>
                Cancel purchase
              </Button>
            ) : (
              <span className="type-body">Cancelled</span>
            )
          }
        />
      ))}
      <ConfirmCancel purchase={asking} email={email} onClose={() => setAsking(null)} />
    </FormSection>
  )
}

/** The second step: what happens, what comes back, where the confirmation goes, then confirming. */
function ConfirmCancel({
  purchase,
  email,
  onClose,
}: {
  purchase: WithdrawalView | null
  email: string
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const cancel = useMutation(
    trpc.billing.cancel.mutationOptions({
      onSuccess: () => {
        void queries.invalidateQueries({ queryKey: trpc.billing.cancellable.queryKey() })
        void queries.invalidateQueries({ queryKey: trpc.account.pathKey() })
        onClose()
      },
    }),
  )
  return (
    <Modal
      open={purchase !== null}
      onClose={() => {
        cancel.reset()
        onClose()
      }}
      title={purchase === null ? '' : `Cancel ${purchase.title}?`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <ActionButton
            phases={{
              cancel: {
                icon: <Check {...ICON} aria-hidden />,
                label: 'Confirm cancellation',
                working: 'Cancelling it',
                failed: 'Didn’t cancel',
                variant: 'danger',
                run: () => cancel.mutateAsync({ order: purchase?.order ?? '' }),
              },
            }}
            now="cancel"
          />
        </>
      }
    >
      {purchase !== null && (
        <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
          <p>{whatEnds(purchase)}</p>
          <p>
            {comesBack(purchase)} The refund follows within 14 days, to the payment method you used, with no
            fee.
          </p>
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            We’ll email the confirmation, with the date and time we received it, to {email}.
          </p>
          {cancel.isError && <Note tone="danger">{messageOf(cancel.error)}</Note>}
        </div>
      )}
    </Modal>
  )
}
