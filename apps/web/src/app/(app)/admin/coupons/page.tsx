// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The admin's coupons: the codes for Plus, newest first, with how many times each was used, and
 * deleting one after a confirmation. Making one is the form in new-coupon.tsx.
 */
import type { CouponView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../lib/api'
import { Button, EmptyState, FormRow, FormSection, Modal, Note, Skeleton } from '../../../../ui'
import { AdminTabs } from '../tabs'
import { NewCoupon } from './new-coupon'

/** "$5" or "$4.99". */
const dollars = (cents: number) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

/** "20% off the first payment · used 3 of 50 times · last day 31 Oct 2026". */
function terms(coupon: CouponView): string {
  const off =
    coupon.off.kind === 'percent' ? `${coupon.off.percent}% off` : `${dollars(coupon.off.cents)} off`
  const lasts =
    coupon.duration.kind === 'once'
      ? 'the first payment'
      : coupon.duration.kind === 'forever'
        ? 'every payment'
        : `${coupon.duration.months} ${coupon.duration.months === 1 ? 'month' : 'months'} of payments`
  const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`
  const used =
    coupon.maxRedemptions === null
      ? `used ${times(coupon.redemptions)}`
      : `used ${coupon.redemptions} of ${times(coupon.maxRedemptions)}`
  const ends = coupon.endsAt
    ? `last day ${new Date(coupon.endsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : null
  return [`${off} ${lasts}`, used, ends].filter(Boolean).join(' · ')
}

/** Coupon codes for Plus: made here, held by the payment provider, typed by customers at checkout. */
export default function CouponsPage() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const list = useQuery(trpc.admin.coupons.list.queryOptions())
  const refresh = () => queries.invalidateQueries({ queryKey: trpc.admin.coupons.list.queryKey() })
  const [deleting, setDeleting] = useState<CouponView | null>(null)
  const remove = useMutation(
    trpc.admin.coupons.delete.mutationOptions({ onSuccess: refresh, onSettled: () => setDeleting(null) }),
  )

  if (list.isError && isNotFound(list.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      <NewCoupon onMade={refresh} />
      <FormSection title="Coupons" description="Newest first, with how many times each was used.">
        {list.isError && <Note tone="danger">{messageOf(list.error)}</Note>}
        {remove.isError && <Note tone="danger">{messageOf(remove.error)}</Note>}
        {list.isPending ? (
          <Skeleton width="100%" height={80} />
        ) : list.data?.length === 0 ? (
          <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
            No coupons yet.
          </p>
        ) : (
          list.data?.map((coupon) => (
            <FormRow
              key={coupon.id}
              label={<span className="bk-mono">{coupon.code}</span>}
              description={terms(coupon)}
              control={
                <Button variant="ghost" size="sm" onClick={() => setDeleting(coupon)}>
                  Delete
                </Button>
              }
            />
          ))
        )}
      </FormSection>

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.code ?? ''}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate({ couponId: deleting.id })}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="type-body">Nobody can use the code after this.</p>
      </Modal>
    </>
  )
}
