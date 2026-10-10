// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { useTRPC } from '../../../../lib/api'
import { newId } from '../../../../lib/ids'
import { realtime } from '../../../../lib/realtime'

/**
 * The server this page is about. Realtime hints refresh it; while work is running and realtime
 * is not connected, a slow poll keeps the progress honest anyway.
 */
export function useServer() {
  const { id } = useParams<{ id: string }>()
  const trpc = useTRPC()
  const connection = realtime.useConnection()
  const query = useQuery({
    ...trpc.servers.get.queryOptions({ serverId: id }),
    refetchInterval: (q) =>
      q.state.data?.activeOperation && connection.status !== 'connected' ? 3_000 : false,
  })
  return { id, ...query }
}

export const requestId = () => newId()
