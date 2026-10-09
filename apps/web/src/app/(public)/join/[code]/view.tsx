'use client'

import { useQuery } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../lib/api'
import { EmptyState, LoadFailed, Skeleton } from '../../../../ui'
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
      <RunsOnBlockly view={invite.data} invite={code} />
    </>
  )
}
