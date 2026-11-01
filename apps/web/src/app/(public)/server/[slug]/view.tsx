// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { messageOf, useTRPC } from '../../../../lib/api'
import { EmptyState, LoadFailed, Skeleton } from '../../../../ui'
import { ChipIn } from '../../chip-in'
import { Resting } from '../../resting'
import { RunsOnBlockly, ServerPage } from '../../server-page'

/**
 * A server's own page: what an owner sends instead of an address. A server resting for its owner's
 * free trial says so first, and where its page is private, says only that: it is where the game
 * sends whoever it turns away.
 */
export function PublicServerView() {
  const { slug } = useParams<{ slug: string }>()
  const trpc = useTRPC()
  const page = useQuery(trpc.sharing.page.queryOptions({ slug }))
  if (page.isPending) return <Skeleton width={320} height={36} />
  if (page.isError) return <LoadFailed error={messageOf(page.error)} onRetry={page.refetch} />
  if (page.data === null)
    return (
      <EmptyState
        title="This server is private"
        description="Its owner hasn’t made a page for it. Ask them for an invite link."
      />
    )
  if ('kind' in page.data) return <Resting view={page.data.resting} />
  return (
    <>
      {page.data.resting && <Resting view={page.data.resting} />}
      <ServerPage view={page.data} />
      <ChipIn view={page.data} to={{ slug }} />
      <RunsOnBlockly view={page.data} />
    </>
  )
}
