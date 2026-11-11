// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import Link from 'next/link'
import { Checkbox } from './fields'

/**
 * The first of the two boxes before anything is paid for, a plan's checkout or a chip-in: the
 * Terms and the Refunds page, each opening beside the page. The second, that it starts now, says
 * what starts, so each page words its own.
 */
export function TermsBox({
  checked,
  onChange,
  invalid,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  invalid: boolean
}) {
  return (
    <Checkbox checked={checked} onChange={onChange} invalid={invalid}>
      I agree to the{' '}
      <Link href="/legal/terms" target="_blank">
        Terms of Service
      </Link>{' '}
      and the{' '}
      <Link href="/legal/refunds" target="_blank">
        Refunds and cancellation
      </Link>{' '}
      policy.
    </Checkbox>
  )
}
