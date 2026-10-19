// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound, redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { isAdmin } from '../../../lib/first-paint'
import { currentSession } from '../../../lib/session'

/**
 * The admin pages. Who isn't an admin gets the same not-found page as any address that isn't a
 * page, decided here before anything below is drawn, so none of the admin pages' code is sent to
 * them (the API answers them not-found on every admin read the same way). A test account an admin
 * is using never opens them either: switch back first.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await currentSession()
  if (session === null) redirect('/sign-in')
  if (session.session.impersonatedBy) redirect('/servers')
  if (!(await isAdmin())) notFound()
  return children
}
