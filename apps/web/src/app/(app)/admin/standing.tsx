// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { AccountView } from '@blockly/contracts'
import { Badge } from '../../../ui'

/** Nothing for an account in good standing; otherwise what it is. */
export function StandingBadge({ account }: { account: Pick<AccountView, 'status'> }) {
  if (account.status === 'active') return null
  return <Badge tone="danger">{account.status === 'suspended' ? 'Suspended' : 'Closed'}</Badge>
}
