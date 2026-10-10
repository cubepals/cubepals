// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { TrashedServerView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2, Undo2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { messageOf, useTRPC } from '../../../../lib/api'
import { useNow } from '../../../../lib/hooks'
import { ActionButton, Button, EmptyState, FormRow, FormSection, ICON, Note, Skeleton } from '../../../../ui'

/** Deleted servers, each restorable until its purge date. */
export default function TrashPage() {
  const trpc = useTRPC()
  const now = useNow(60_000)
  const trash = useQuery(trpc.servers.trash.queryOptions())
  const purged = useQuery(trpc.servers.purgedArchives.queryOptions())
  const capabilities = useQuery(trpc.platform.capabilities.queryOptions())

  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Trash
      </h1>
      {trash.isPending ? (
        <Skeleton width="100%" height={120} />
      ) : trash.isError ? (
        <Note tone="danger">{messageOf(trash.error)}</Note>
      ) : trash.data.length === 0 ? (
        <EmptyState
          art={<Trash2 size={48} strokeWidth={1.5} color="var(--forest-ink)" aria-hidden />}
          title="Nothing in the trash"
          description="A server you delete waits here for a while, so you can change your mind."
          action={
            <Button variant="outline" href="/servers">
              Your servers
            </Button>
          }
        />
      ) : (
        <FormSection
          title={`${trash.data.length} deleted ${trash.data.length === 1 ? 'server' : 'servers'}`}
          description={
            capabilities.data?.archives
              ? 'Restoring brings a server back stopped, with its world and backups. After its purge date it is gone, and only its downloadable backups stay, for as long as they are kept.'
              : 'Restoring brings a server back stopped, with its world and backups. After its purge date it is gone, backups and all.'
          }
        >
          {trash.data.map((server) => (
            <Trashed key={server.id} server={server} now={now} />
          ))}
        </FormSection>
      )}
      {purged.data && purged.data.length > 0 && (
        <FormSection
          title="Gone, with downloads kept"
          description="These servers were deleted for good. Their downloadable backups stay until the date shown."
        >
          {purged.data.map((server) => (
            <FormRow
              key={server.id}
              label={server.name}
              description={`${server.archives} ${server.archives === 1 ? 'download' : 'downloads'}${
                server.keptUntil ? `, kept until ${new Date(server.keptUntil).toLocaleDateString()}` : ''
              }`}
              control={
                <Button variant="outline" size="sm" href={`/servers/${server.id}/backups`}>
                  Download
                </Button>
              }
            />
          ))}
        </FormSection>
      )}
    </>
  )
}

function Trashed({ server, now }: { server: TrashedServerView; now: number }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const router = useRouter()
  const restore = useMutation(
    trpc.servers.undelete.mutationOptions({
      onSuccess: async () => {
        await queries.invalidateQueries({ queryKey: trpc.servers.pathKey() })
        router.push(`/servers/${server.id}`)
      },
    }),
  )
  const backups = server.backups.snapshots + server.backups.archives
  return (
    <>
      <FormRow
        label={server.name}
        description={[
          `Deleted ${dayOf(server.deletedAt)}`,
          `gone for good ${untilPurge(server.purgeAfter, now)}`,
          backups === 0 ? 'no backups' : `${backups} ${backups === 1 ? 'backup' : 'backups'}`,
        ].join(' · ')}
        control={
          <ActionButton
            size="sm"
            phases={{
              restore: {
                icon: <Undo2 {...ICON} aria-hidden />,
                label: 'Restore',
                working: 'Bringing it back',
                failed: 'Didn’t restore',
                variant: 'outline',
                run: () => restore.mutateAsync({ serverId: server.id }),
              },
            }}
            now="restore"
          />
        }
      />
      {restore.isError && <Note tone="danger">{messageOf(restore.error)}</Note>}
    </>
  )
}

const dayOf = (at: string) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** In calendar days: "in 30 days", then "tomorrow at 17:02" and "today at 17:02". */
function untilPurge(at: string, now: number): string {
  const when = new Date(at)
  if (when.getTime() <= now) return 'any moment now'
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((startOfDay(when.getTime()) - startOfDay(now)) / 86_400_000)
  if (days === 0) return `today at ${time}`
  if (days === 1) return `tomorrow at ${time}`
  return `in ${days} days`
}

const startOfDay = (ms: number) => {
  const day = new Date(ms)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}
