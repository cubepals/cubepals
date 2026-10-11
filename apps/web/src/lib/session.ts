// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from 'next/headers'
import { clientAddressHeaders } from './client-address'
import { apiUpstream } from './upstream'

export interface Session {
  user: { id: string; name: string; email: string; emailVerified: boolean }
  /** `impersonatedBy` is the admin using this test account ("Use as this account"), when one is. */
  session: { impersonatedBy?: string | null }
}

/** The signed-in person, asked of the control plane with the browser's own cookie and address. */
export async function currentSession(): Promise<Session | null> {
  const incoming = await headers()
  const cookie = incoming.get('cookie')
  if (!cookie) return null
  const response = await fetch(`${apiUpstream()}/api/auth/get-session`, {
    headers: { cookie, ...clientAddressHeaders(incoming) },
    cache: 'no-store',
  })
  if (!response.ok) return null
  return (await response.json()) as Session | null
}
