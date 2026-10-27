// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * "Your own world" on the create page (docs/world-import.md): a world a player has, handed over
 * (`world-drop.tsx`) before there is a server, sent straight to the store and read on a worker,
 * with what only they know asked here (`world-questions.tsx`). What it turned out to be comes back
 * to `onReady`, and the server is made to fit it; a file no server could play says why.
 */
import type { NewWorldImportView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { useHandedOnce, useSentImport } from '../../../../../lib/sent-import'
import { Note, ProgressBar } from '../../../../../ui'
import { WorldDrop } from '../../../world-drop'
import { BroughtNotes, WorldQuestions } from '../../../world-questions'

/** A world Blockly has read, as the create page picks it. */
export type ReadWorld = Extract<NewWorldImportView, { status: 'ready' }>

/** How often a world being read is asked about: reading a large one takes a minute or two. */
const READING_POLL_MS = 1500

/**
 * A world brought for a new server, as it is read: watched until it is ready or refused, and the
 * owner's answers to what it asks sent back, which come back as the world read again.
 */
export function useNewWorld(importId: string | null) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const answer = useMutation(
    trpc.newWorlds.answerUpload.mutationOptions({
      onSuccess: (next) =>
        queries.setQueryData(trpc.newWorlds.upload.queryKey({ importId: next.importId }), next),
    }),
  )
  const watched = useQuery({
    ...trpc.newWorlds.upload.queryOptions({ importId: importId ?? '' }),
    enabled: importId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'reading' ? READING_POLL_MS : false),
  })
  return { watched, answer }
}

export function OwnWorld({
  disabled,
  onReady,
  onStart,
}: {
  disabled?: boolean
  onReady: (world: ReadWorld) => void
  /** A new file was chosen: whatever the last one was is no longer the choice. */
  onStart?: () => void
}) {
  const trpc = useTRPC()
  const begin = useMutation(trpc.newWorlds.beginUpload.mutationOptions())
  const finish = useMutation(trpc.newWorlds.finishUpload.mutationOptions())
  const {
    progress: sending,
    importId,
    failure,
    send,
  } = useSentImport(
    { begin: (file) => begin.mutateAsync(file), finish: (ticket) => finish.mutateAsync({ ticket }) },
    onStart,
  )
  const { watched, answer } = useNewWorld(importId)
  const read = watched.data
  useHandedOnce(read, onReady)

  const busy = sending !== null || read?.status === 'reading'
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      <WorldDrop disabled={disabled || busy} onFile={(file) => void send(file)} />
      {sending !== null && (
        <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
          <span className="type-body-sm">{sending.name}: sending it…</span>
          <ProgressBar value={sending.done} label={`Sending ${sending.name}`} />
        </div>
      )}
      {read?.status === 'reading' && (
        <p className="type-body-sm" role="status">
          Reading {read.fileName}: finding the world, its Minecraft and its seed…
        </p>
      )}
      {read?.status === 'asking' && (
        <WorldQuestions
          asks={read}
          answering={answer.isPending}
          failure={answer.isError ? messageOf(answer.error) : null}
          onAnswer={(given) => answer.mutate({ importId: read.importId, ...given })}
        />
      )}
      {read?.status === 'ready' && <BroughtNotes notes={read.notes} />}
      {read?.status === 'refused' && <Note tone="info">{read.message}</Note>}
      {(failure !== null || watched.isError) && (
        <Note tone="danger">{failure ?? messageOf(watched.error)}</Note>
      )}
    </div>
  )
}
