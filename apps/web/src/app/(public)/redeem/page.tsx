// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from 'next'
import { pageMetadata } from '../../../lib/site'
import { RedeemGift } from './redeem-gift'

export const metadata: Metadata = pageMetadata({
  title: 'Redeem a gift',
  description:
    'Got a Cubepals gift code? Redeem it here and Plus starts on the account you’re signed in to. It doesn’t renew, so there’s nothing to cancel.',
  path: '/redeem',
})

/** Where a gift code is used: the link in the gift's email lands here with the code filled in. */
export default function RedeemPage() {
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-24)', maxWidth: 'var(--width-form)' }}>
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Redeem a gift
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          Someone has given you Plus. It goes on the account you’re signed in to.
        </p>
      </header>
      <RedeemGift />
    </div>
  )
}
