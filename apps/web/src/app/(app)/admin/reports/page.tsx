// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { ReportView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../lib/api'
import { useNow } from '../../../../lib/hooks'
import { whenTaken } from '../../../../lib/present'
import {
  Badge,
  Button,
  EmptyState,
  FormRow,
  FormSection,
  Modal,
  Note,
  Skeleton,
  TextField,
} from '../../../../ui'
import { AdminTabs } from '../tabs'

/** Listings people reported: an admin removes one with a note its owner reads, or dismisses the report. */
export default function ReportsPage() {
  const trpc = useTRPC()
  const now = useNow(60_000)
  const queries = useQueryClient()
  const reports = useQuery(trpc.admin.reports.queryOptions())
  const [removing, setRemoving] = useState<ReportView | null>(null)
  const refresh = () => queries.invalidateQueries({ queryKey: trpc.admin.reports.queryKey() })
  const dismiss = useMutation(trpc.admin.dismissReport.mutationOptions({ onSuccess: refresh }))
  if (reports.isError && isNotFound(reports.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      <FormSection title="Open reports" description="Newest first. Settled reports leave this list.">
        {reports.isError && <Note tone="danger">{messageOf(reports.error)}</Note>}
        {dismiss.isError && <Note tone="danger">{messageOf(dismiss.error)}</Note>}
        {reports.isPending ? (
          <Skeleton width="100%" height={80} />
        ) : reports.data?.length === 0 ? (
          <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
            No open reports.
          </p>
        ) : (
          reports.data?.map((report) => (
            <FormRow
              key={report.id}
              label={
                <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
                  <Link href={`/browse/${report.serverId}`}>{report.serverName}</Link>
                  {report.moderation === 'removed' && <Badge tone="danger">Removed</Badge>}
                </span>
              }
              description={`“${report.reason}” · ${report.reporter} · ${whenTaken(report.createdAt, now)}`}
              control={
                <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate({ reportId: report.id })}
                  >
                    Dismiss
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setRemoving(report)}>
                    Remove listing
                  </Button>
                </div>
              }
            />
          ))
        )}
      </FormSection>
      <Removed />
      {removing && <Remove report={removing} onClose={() => setRemoving(null)} />}
    </>
  )
}

/** Listings taken out of the directory; restoring one puts it back if it is still eligible. */
function Removed() {
  const trpc = useTRPC()
  const now = useNow(60_000)
  const queries = useQueryClient()
  const removed = useQuery(trpc.admin.removedListings.queryOptions())
  const restore = useMutation(
    trpc.admin.moderate.mutationOptions({
      onSuccess: () => queries.invalidateQueries({ queryKey: trpc.admin.pathKey() }),
    }),
  )
  if (!removed.data || removed.data.length === 0) return null
  return (
    <FormSection title="Removed listings" description="Their owners see your note until you restore them.">
      {restore.isError && <Note tone="danger">{messageOf(restore.error)}</Note>}
      {removed.data.map((listing) => (
        <FormRow
          key={listing.serverId}
          label={listing.name}
          description={`${listing.note ?? 'No note'} · ${whenTaken(listing.removedAt, now)}`}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={restore.isPending}
              onClick={() => restore.mutate({ serverId: listing.serverId, action: 'restore', note: '' })}
            >
              Restore
            </Button>
          }
        />
      ))}
    </FormSection>
  )
}

function Remove({ report, onClose }: { report: ReportView; onClose: () => void }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const [note, setNote] = useState('')
  const moderate = useMutation(
    trpc.admin.moderate.mutationOptions({
      onSuccess: () => {
        onClose()
        return queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
      },
    }),
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={`Remove “${report.serverName}”?`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={note.trim().length === 0 || moderate.isPending}
            onClick={() => moderate.mutate({ serverId: report.serverId, action: 'remove', note })}
          >
            Remove
          </Button>
        </>
      }
    >
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        <p>
          It leaves the directory; the server keeps running. Its owner sees your note, and every open report
          on it is settled.
        </p>
        <TextField
          label="Note for the owner"
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        {moderate.isError && <Note tone="danger">{messageOf(moderate.error)}</Note>}
      </div>
    </Modal>
  )
}
