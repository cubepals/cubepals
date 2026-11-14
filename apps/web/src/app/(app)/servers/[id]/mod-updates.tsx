// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { ServerView } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useTRPC } from '../../../../lib/api'
import { Note } from '../../../../ui'
import { changeable } from './settings/shared'
import { updateHref, updatesLine, type Versions } from './update-lines'

/**
 * The updates Cubepals found for the server's mods, asked apart from the list so neither page waits
 * on them. None while they are looked for, or when they can't be: a control plane that doesn't
 * answer this yet included.
 */
export function useModUpdates(serverId: string): Versions {
  const trpc = useTRPC()
  const updates = useQuery(trpc.mods.updates.queryOptions({ serverId }))
  return updates.data?.versions ?? {}
}

/**
 * On the server's page, the updates Cubepals found for its mods or its pack, with the way to them:
 * the Mods page, with the update already planned. Said while it is true, and gone once applied.
 * Nothing at all while the server can't take a change, or while the mods can't be read.
 */
export function ModUpdates({ server }: { server: ServerView }) {
  const trpc = useTRPC()
  const mods = useQuery(trpc.mods.list.queryOptions({ serverId: server.id }))
  const versions = useModUpdates(server.id)
  const line = mods.data === undefined ? null : updatesLine(mods.data, versions)
  if (line === null || !changeable(server).ok) return null
  return (
    <Note tone="info">
      <span className="bk-row bk-wrap" style={{ gap: 'var(--space-12)', alignItems: 'center' }}>
        <span>{line}</span>
        <Link href={updateHref(server.id)}>Update</Link>
      </span>
    </Note>
  )
}
