// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { RevisionView, ServerView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { useNow } from '../../../../../lib/hooks'
import { said, useOutcome } from '../../../../../lib/outcome'
import { busyWord, loaderLabel, presentChange, revisionTitle, timeAgo } from '../../../../../lib/present'
import { Badge, Button, FormRow, FormSection, Note, Skeleton } from '../../../../../ui'
import { ConfirmChange, planLines, useChanged, whatHappens } from './shared'

const SHOWN = 8

/**
 * Every configuration this server has had, newest first. Going back to one makes a new change
 * with its settings, so the history only ever grows.
 */
export function History({ view }: { view: ServerView }) {
  const trpc = useTRPC()
  const now = useNow(60_000)
  const revisions = useQuery(trpc.servers.revisions.queryOptions({ serverId: view.id }))
  const [all, setAll] = useState(false)
  const [target, setTarget] = useState<RevisionView | null>(null)
  const changed = useChanged(view.id)
  // The row that was pressed says when the server is back on it.
  const [wentBack, setWentBack] = useState<string | null>(null)
  const outcome = useOutcome(view)
  const rollback = useMutation(
    trpc.servers.rollback.mutationOptions({
      onSuccess: (next) => {
        setWentBack(target?.id ?? null)
        setTarget(null)
        changed(next)
        outcome.settled(next)
      },
    }),
  )
  // A failed server can go back too: that is how it gets out of a change that broke it.
  const busy = view.activeOperation !== null || !['running', 'stopped', 'failed'].includes(view.status)

  if (revisions.isPending)
    return (
      <FormSection title="History">
        <Skeleton width="60%" />
      </FormSection>
    )
  if (revisions.isError)
    return (
      <FormSection title="History">
        <Note tone="danger">{messageOf(revisions.error)}</Note>
      </FormSection>
    )
  const list = all ? revisions.data : revisions.data.slice(0, SHOWN)
  return (
    <FormSection
      title="History"
      description="Every change to how this server starts. Go back to one if a change didn’t work out."
      {...(revisions.data.length > SHOWN && !all
        ? {
            actions: (
              <Button variant="ghost" onClick={() => setAll(true)}>
                Show all {revisions.data.length}
              </Button>
            ),
          }
        : {})}
    >
      {list.map((revision) => (
        <FormRow
          key={revision.id}
          label={
            <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
              {revisionTitle(revision)}
              <State revision={revision} view={view} />
            </span>
          }
          description={
            <>
              {summary(revision)}
              <br />
              <span className="type-caption" style={{ color: 'var(--ink-muted)' }}>
                {timeAgo(revision.createdAt, now)}
                {revision.byOwner ? '' : ' · by Cubepals'}
              </span>
            </>
          }
          control={
            revision.desired ? null : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                {...(revision.id === wentBack
                  ? {
                      busy: busyWord(view.activeOperation),
                      ...said(outcome, { done: 'Went back', failed: 'Didn’t go back' }),
                    }
                  : {})}
                onClick={() => setTarget(revision)}
              >
                Go back to this
              </Button>
            )
          }
        />
      ))}
      <ConfirmChange
        open={target !== null}
        onClose={() => {
          setTarget(null)
          rollback.reset()
        }}
        title="Go back to this configuration?"
        lines={[...(target?.fromCurrent.map(presentChange) ?? []), ...planLines(view)]}
        confirmLabel={view.status === 'running' ? 'Go back and restart' : 'Go back'}
        working="Going back"
        error={rollback.error}
        onConfirm={(requestId) =>
          rollback.mutateAsync({
            serverId: view.id,
            requestId,
            version: view.version,
            revisionId: target?.id ?? '',
          })
        }
        onAcknowledge={(requestId) =>
          rollback.mutateAsync({
            serverId: view.id,
            requestId,
            version: view.version,
            revisionId: target?.id ?? '',
            acknowledgeRevoked: true,
          })
        }
      >
        {target?.fromCurrent.length === 0 && <p>It’s the same configuration the server has now.</p>}
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {view.status === 'failed' ? 'The server starts again with this configuration.' : whatHappens(view)}
        </p>
      </ConfirmChange>
    </FormSection>
  )
}

function State({ revision, view }: { revision: RevisionView; view: ServerView }) {
  if (revision.desired && revision.applied)
    return <Badge tone="grass">{view.status === 'running' ? 'Running now' : 'Current'}</Badge>
  if (revision.desired)
    return <Badge tone="info">{view.status === 'updating' ? 'Applying' : 'Next start'}</Badge>
  if (revision.applied)
    return (
      <Badge tone="outline">
        {view.status === 'running' || view.status === 'updating' ? 'Running now' : 'Last run'}
      </Badge>
    )
  return null
}

function summary(revision: RevisionView): string {
  if (revision.reason === 'created' || revision.changes.length === 0)
    return `Minecraft ${revision.gameVersion}, ${loaderLabel(revision.loader)}`
  return revision.changes.map(presentChange).join(' · ')
}
