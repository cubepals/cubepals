// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { usePathname } from 'next/navigation'
import { BetaBanner } from '../../ui/beta'

/** The pages a person comes in by. The steps after them (check your email, a new password) are left plain. */
const ENTRIES = new Set(['/sign-in', '/sign-up'])

/** The beta banner on the ways in, above the header the auth pages share. */
export function EntryBanner() {
  return ENTRIES.has(usePathname()) ? <BetaBanner /> : null
}
