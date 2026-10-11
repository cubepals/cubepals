// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { firstPaint } from '../../lib/first-paint'
import { currentSession } from '../../lib/session'
import { AppFrame } from './frame'

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Asked side by side: the first paint's data costs no more wait than the session check does.
  const [session, data] = await Promise.all([currentSession(), firstPaint()])
  if (session === null) redirect('/sign-in')
  return (
    <AppFrame user={session.user} data={data} usingAs={Boolean(session.session.impersonatedBy)}>
      {children}
    </AppFrame>
  )
}
