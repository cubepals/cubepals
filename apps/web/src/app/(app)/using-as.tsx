// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useMutation } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../lib/api'
import styles from './using-as.module.css'

/**
 * The bar every page shows while an admin uses a test account ("Use as this account" on its admin
 * page): whose account this is, and the way back to the admin's own. Switching back loads the
 * account's admin page afresh, so nothing the test account read stays on screen.
 */
export function UsingAs({ userId, email }: { userId: string; email: string }) {
  const trpc = useTRPC()
  const back = useMutation(
    trpc.account.switchBack.mutationOptions({
      onSuccess: () => window.location.assign(`/admin/accounts/${userId}`),
    }),
  )
  return (
    <div className={styles.bar} role="status">
      <span>
        Using <strong>{email}</strong> (test account)
      </span>
      <span aria-hidden>·</span>
      <button
        type="button"
        className={styles.back}
        disabled={back.isPending || back.isSuccess}
        onClick={() => back.mutate()}
      >
        Switch back
      </button>
      {back.isError && <span>{messageOf(back.error)}</span>}
    </div>
  )
}
