// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The account's pricing cards use the public pricing page's fonts and deployment capabilities. */
import type { ReactNode } from 'react'
import { digits, pixel } from '../../../landing/fonts'
import { bedrockLive } from '../../../lib/bedrock'
import { PlanPresentationProvider } from './plan-presentation'

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <PlanPresentationProvider bedrock={bedrockLive()}>
      <div className={`${pixel.variable} ${digits.variable}`} style={{ display: 'contents' }}>
        {children}
      </div>
    </PlanPresentationProvider>
  )
}
