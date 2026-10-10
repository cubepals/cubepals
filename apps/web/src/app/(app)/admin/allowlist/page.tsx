// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../lib/api'
import { said, useOutcome } from '../../../../lib/outcome'
import { Button, EmptyState, FormRow, FormSection, Note, Skeleton, TextField } from '../../../../ui'
import { AdminTabs } from '../tabs'

/**
 * Mods Blockly vouches for (§15.3): a listed server's mods must all be here, and still published
 * where they came from, for it to show in the directory.
 */
export default function AllowlistPage() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const list = useQuery(trpc.admin.allowlist.queryOptions())
  const [project, setProject] = useState('')
  const [note, setNote] = useState('')
  const refresh = () => queries.invalidateQueries({ queryKey: trpc.admin.allowlist.queryKey() })
  const vouched = useOutcome(undefined)
  const trust = useMutation(
    trpc.admin.trust.mutationOptions({
      onSuccess: () => {
        setProject('')
        setNote('')
        vouched.settled()
        return refresh()
      },
      onError: () => vouched.refused(),
    }),
  )
  const untrust = useMutation(trpc.admin.untrust.mutationOptions({ onSuccess: refresh }))
  if (list.isError && isNotFound(list.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (project.trim())
      trust.mutate({ projectId: project.trim(), ...(note.trim() ? { note: note.trim() } : {}) })
  }
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      <form onSubmit={submit}>
        <FormSection
          title="Vouch for a mod"
          description="Its Modrinth slug or id. Listings that run it are checked again right away."
          actions={
            <Button
              type="submit"
              variant="primary"
              {...said(vouched, { done: 'Added', failed: 'Didn’t add' })}
              disabled={!project.trim() || trust.isPending}
            >
              Add
            </Button>
          }
        >
          <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
            <TextField
              label="Project"
              placeholder="lithium"
              value={project}
              onChange={(event) => setProject(event.target.value)}
            />
            <TextField
              label="Why"
              optional
              value={note}
              maxLength={300}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {trust.isError && <Note tone="danger">{messageOf(trust.error)}</Note>}
        </FormSection>
      </form>
      <FormSection
        title="Trusted mods"
        description="Removing one takes listings that run it out of the directory."
      >
        {list.isError && <Note tone="danger">{messageOf(list.error)}</Note>}
        {untrust.isError && <Note tone="danger">{messageOf(untrust.error)}</Note>}
        {list.isPending ? (
          <Skeleton width="100%" height={80} />
        ) : list.data?.length === 0 ? (
          <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
            None yet: only vanilla servers can list.
          </p>
        ) : (
          list.data?.map((entry) => (
            <FormRow
              key={`${entry.catalog}:${entry.projectId}`}
              label={entry.displayName}
              description={`${entry.catalog} · ${entry.projectId}${entry.note ? ` · ${entry.note}` : ''} · by ${entry.addedBy}`}
              control={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={untrust.isPending}
                  onClick={() => untrust.mutate({ catalog: entry.catalog, projectId: entry.projectId })}
                >
                  Remove
                </Button>
              }
            />
          ))
        )}
      </FormSection>
    </>
  )
}
