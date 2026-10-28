// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * An invitation as the browser draws it: the server's page, a way onto its list of players, and,
 * once it is shown, word that it was opened, which only a browser running the page sends.
 *
 * Not for the title and picture a pasted link shows: `page.tsx` reads those on the server.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { messageOf, useTRPC } from '../../../../lib/api'
import { EmptyState, LoadFailed, Skeleton } from '../../../../ui'
import { ChipIn } from '../../chip-in'
import { JoinThroughInvite, RunsOnBlockly, ServerPage } from '../../server-page'

/**
 * An invitation: the server's page, and a way onto its list of players. `code` is the one in the
 * link as it was opened, with what a chat app added taken off; null where it still isn't one.
 */
export function InviteView({ code }: { code: string | null }) {
  if (code === null)
    return (
      <EmptyState
        title="This link isn’t quite right"
        description="It may be cut off or mistyped. Ask whoever sent it for the link again."
      />
    )
  return <Invitation code={code} />
}

function Invitation({ code }: { code: string }) {
  const trpc = useTRPC()
  const invite = useQuery(trpc.sharing.invite.queryOptions({ code }))
  useOpened(code, invite.data != null)
  if (invite.isPending) return <Skeleton width={320} height={36} />
  if (invite.isError) return <LoadFailed error={messageOf(invite.error)} onRetry={() => invite.refetch()} />
  if (invite.data === null)
    return (
      <EmptyState
        title="This invite doesn’t work any more"
        description="Its owner made a new link, or the server is gone. Ask them for a fresh one."
      />
    )
  return (
    <>
      <ServerPage view={invite.data} />
      <JoinThroughInvite code={code} view={invite.data} />
      <ChipIn view={invite.data} to={{ code }} />
      <RunsOnBlockly view={invite.data} invite={code} />
    </>
  )
}

/**
 * Tells Cubepals the invitation was opened, once it is shown: from the browser, after the page has
 * run, so a link preview, which only fetches the page and its picture, never says so. Sent and
 * forgotten; control keeps it once for the server.
 */
function useOpened(code: string, shown: boolean) {
  const trpc = useTRPC()
  const { mutate } = useMutation(trpc.sharing.inviteOpened.mutationOptions())
  useEffect(() => {
    if (shown) mutate({ code })
  }, [code, shown, mutate])
}
