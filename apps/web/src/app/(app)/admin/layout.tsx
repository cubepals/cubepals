// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { currentSession } from '../../../lib/session'

/**
 * The admin pages, which a test account an admin is using never opens: the API refuses it every
 * admin read and change anyway, and the page would only stand empty. Switch back first.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await currentSession()
  if (session?.session.impersonatedBy) redirect('/servers')
  return children
}
