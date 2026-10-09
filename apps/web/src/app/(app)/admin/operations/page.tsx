'use client'

import type { BlockedOperationView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../lib/api'
import { useNow } from '../../../../lib/hooks'
import { whenTaken } from '../../../../lib/present'
import { Button, EmptyState, FormRow, FormSection, Modal, Note, Skeleton } from '../../../../ui'
import { AdminTabs } from '../tabs'

/** Work that stopped where only an admin can move it (§9). */
export default function OperationsPage() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const now = useNow(30_000)
  const stuck = useQuery({ ...trpc.admin.stuck.queryOptions(), refetchInterval: 15_000 })
  const refresh = () => queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
  const retry = useMutation(trpc.admin.retryOperation.mutationOptions({ onSuccess: refresh }))
  const [discarding, setDiscarding] = useState<BlockedOperationView | null>(null)
  const discard = useMutation(
    trpc.admin.discardOperation.mutationOptions({
      onSuccess: refresh,
      onSettled: () => setDiscarding(null),
    }),
  )

  if (stuck.isError && isNotFound(stuck.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  const failure = retry.error ?? discard.error ?? stuck.error
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      {failure && <Note tone="danger">{messageOf(failure)}</Note>}

      <FormSection
        title="Blocked operations"
        description="An operation whose job failed for good, usually an attempt that hung past its deadline, holds up everything queued behind it on its server. Retry runs it once more. Discard records it as failed, as a final failure would, and lets the queue move."
      >
        {stuck.isPending ? (
          <Skeleton width="100%" height={80} />
        ) : stuck.data?.blocked.length === 0 ? (
          <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
            Nothing is blocked.
          </p>
        ) : (
          stuck.data?.blocked.map((op) => (
            <FormRow
              key={op.operationId}
              label={`${op.kind} on ${op.serverName}`}
              description={[
                `Recorded as ${op.status}`,
                op.failedAt ? `failed ${whenTaken(op.failedAt, now).toLowerCase()}` : null,
                op.error,
                op.waiting > 0 ? `${op.waiting} waiting behind it` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              control={
                <span className="bk-row" style={{ gap: 'var(--space-8)' }}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate({ operationId: op.operationId })}
                  >
                    Retry
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDiscarding(op)}>
                    Discard
                  </Button>
                </span>
              }
            />
          ))
        )}
      </FormSection>

      <FormSection
        title="Overdue purges"
        description="Deleted servers an hour or more past their purge date. Cubepals tries again every ten minutes; these show why it keeps failing."
      >
        {stuck.isPending ? (
          <Skeleton width="100%" height={60} />
        ) : stuck.data?.overduePurges.length === 0 ? (
          <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
            Every purge is on time.
          </p>
        ) : (
          stuck.data?.overduePurges.map((purge) => (
            <FormRow
              key={purge.serverId}
              label={purge.serverName}
              description={[
                `Due ${whenTaken(purge.purgeAfter, now).toLowerCase()}`,
                `${purge.failedAttempts} failed ${purge.failedAttempts === 1 ? 'attempt' : 'attempts'}`,
                purge.lastError ? `last: ${purge.lastError}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              control={null}
            />
          ))
        )}
      </FormSection>

      <Modal
        open={discarding !== null}
        onClose={() => setDiscarding(null)}
        title={`Discard the ${discarding?.kind ?? ''} on ${discarding?.serverName ?? ''}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDiscarding(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={discard.isPending}
              onClick={() => discarding && discard.mutate({ operationId: discarding.operationId })}
            >
              Discard
            </Button>
          </>
        }
      >
        <p className="type-body">
          It is recorded as failed. If the server was part-way through it, the server shows as failed, and its
          owner can try again from its page.
        </p>
      </Modal>
    </>
  )
}
