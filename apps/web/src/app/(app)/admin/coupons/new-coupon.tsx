// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Making a coupon: the form, and what it sends. The payment provider holds the code; customers
 * type it when they pay for Plus.
 */
import type { CreateCouponInput } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { messageOf, useTRPC } from '../../../../lib/api'
import { said, useOutcome } from '../../../../lib/outcome'
import { Button, FormSection, Note, Select, TextField } from '../../../../ui'

const OFF = [
  { value: 'percent', label: 'A percentage' },
  { value: 'amount', label: 'An amount in dollars' },
]

const LASTS = [
  { value: 'once', label: 'The first payment' },
  { value: 'months', label: 'A number of months' },
  { value: 'forever', label: 'Every payment' },
]

/** The form as typed. */
interface Draft {
  code: string
  off: 'percent' | 'amount'
  value: string
  lasts: 'once' | 'months' | 'forever'
  months: string
  uses: string
  ends: string
}

const BLANK: Draft = { code: '', off: 'percent', value: '', lasts: 'once', months: '3', uses: '', ends: '' }

const CODE = /^[A-Za-z0-9]{3,32}$/

/** A whole number from 1 to `max`, or null. */
const whole = (value: string, max: number): number | null => {
  const n = Number(value.trim())
  return /^\d+$/.test(value.trim()) && n >= 1 && n <= max ? n : null
}

/** Dollars and cents, as typed ("5", "4.99"), in cents; null when it isn't an amount. */
const cents = (value: string): number | null => {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null
  const n = Math.round(Number(value.trim()) * 100)
  return n >= 1 && n <= 1_000_000 ? n : null
}

const amountOf = (draft: Draft) => (draft.off === 'percent' ? whole(draft.value, 100) : cents(draft.value))

/** What is wrong with each field as typed. One left empty isn't wrong yet. */
function problems(draft: Draft) {
  const typed = (value: string, ok: boolean, problem: string) => (value.trim() && !ok ? problem : null)
  return {
    code: typed(draft.code, CODE.test(draft.code.trim()), 'Use 3 to 32 letters and digits.'),
    value: typed(
      draft.value,
      amountOf(draft) !== null,
      draft.off === 'percent' ? 'A whole number from 1 to 100.' : 'An amount like 5 or 4.99.',
    ),
    months: whole(draft.months, 36) === null ? 'A whole number from 1 to 36.' : null,
    uses: typed(draft.uses, whole(draft.uses, 1_000_000) !== null, 'A whole number, or leave it empty.'),
  }
}

/** The coupon the form describes, or null while something is missing or wrong. */
function couponOf(draft: Draft): CreateCouponInput | null {
  const amount = amountOf(draft)
  const months = whole(draft.months, 36)
  if (!CODE.test(draft.code.trim()) || amount === null || problems(draft).uses) return null
  if (draft.lasts === 'months' && months === null) return null
  return {
    code: draft.code.trim(),
    off: draft.off === 'percent' ? { kind: 'percent', percent: amount } : { kind: 'amount', cents: amount },
    duration: draft.lasts === 'months' ? { kind: 'months', months: months ?? 1 } : { kind: draft.lasts },
    maxRedemptions: draft.uses.trim() ? whole(draft.uses, 1_000_000) : null,
    // It works through the whole of the day picked, where the admin is.
    endsAt: draft.ends ? new Date(`${draft.ends}T23:59:59`).toISOString() : null,
  }
}

/** The form for a new coupon. The button waits until what it would make is whole. */
export function NewCoupon({ onMade }: { onMade: () => Promise<unknown> }) {
  const trpc = useTRPC()
  const [draft, setDraft] = useState(BLANK)
  const made = useOutcome(undefined)
  const create = useMutation(
    trpc.admin.coupons.create.mutationOptions({
      onSuccess: () => {
        setDraft(BLANK)
        made.settled()
        return onMade()
      },
      onError: () => made.refused(),
    }),
  )
  const coupon = couponOf(draft)
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (coupon !== null) create.mutate(coupon)
  }
  return (
    <form onSubmit={submit}>
      <FormSection
        title="New coupon"
        description="Customers type the code when they pay for Plus."
        actions={
          <Button
            type="submit"
            variant="primary"
            {...said(made, { done: 'Made', failed: 'Didn’t make it' })}
            disabled={coupon === null || create.isPending}
          >
            Make coupon
          </Button>
        }
      >
        <CouponFields draft={draft} onChange={setDraft} />
        {create.isError && <Note tone="danger">{messageOf(create.error)}</Note>}
      </FormSection>
    </form>
  )
}

function CouponFields({ draft, onChange }: { draft: Draft; onChange: (next: Draft) => void }) {
  const wrong = problems(draft)
  const set = (key: keyof Draft) => (event: { target: { value: string } }) =>
    onChange({ ...draft, [key]: event.target.value })
  const percent = draft.off === 'percent'
  return (
    <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
      <TextField
        label="Code"
        mono
        placeholder="FRIENDS20"
        value={draft.code}
        maxLength={32}
        autoComplete="off"
        error={wrong.code}
        onChange={set('code')}
      />
      <Select label="Takes off" value={draft.off} options={OFF} onChange={set('off')} />
      <TextField
        label={percent ? 'Percent off' : 'Dollars off'}
        inputMode={percent ? 'numeric' : 'decimal'}
        placeholder={percent ? '20' : '5'}
        value={draft.value}
        error={wrong.value}
        onChange={set('value')}
      />
      <Select label="Applies to" value={draft.lasts} options={LASTS} onChange={set('lasts')} />
      {draft.lasts === 'months' && (
        <TextField
          label="Months"
          inputMode="numeric"
          value={draft.months}
          error={wrong.months}
          onChange={set('months')}
        />
      )}
      <TextField
        label="Uses in all"
        optional
        inputMode="numeric"
        value={draft.uses}
        error={wrong.uses}
        help="Empty for no limit."
        onChange={set('uses')}
      />
      <TextField
        label="Last day"
        optional
        type="date"
        value={draft.ends}
        help="Empty for no end."
        onChange={set('ends')}
      />
    </div>
  )
}
