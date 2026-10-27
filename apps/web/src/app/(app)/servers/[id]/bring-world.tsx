// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Bringing a world a player has to their server (docs/world-import.md): the file sent straight to
 * the store, read on a worker, a question asked where only the player knows the answer, and the
 * world kept as a backup with what Cubepals did to bring it. Restoring it is the next step, which
 * the page that opened this offers. Not where a world is restored, or a backup taken.
 */
import {
  DEFAULT_PEOPLE_CHOICE,
  type PeopleChoice,
  type ServerView,
  type WorldImportView,
  type WorldPeople,
} from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../../lib/api'
import { bytes } from '../../../../lib/present'
import { putFile } from '../../../../lib/upload'
import { Button, Modal, Note, ProgressBar, TextField } from '../../../../ui'
import { WorldPeopleChoice } from '../../world-people'
import { BroughtNotes, WorldQuestions } from '../../world-questions'

/** How often a world being read is asked about: reading a large one takes a minute or two. */
const READING_POLL_MS = 1500

export function BringWorld({
  view,
  file,
  onClose,
  onKept,
}: {
  view: ServerView
  file: File
  onClose: () => void
  /** The world is kept as this backup, and its player wants to restore it now. */
  onKept: (backupId: string) => void
}) {
  const trpc = useTRPC()
  const begin = useMutation(trpc.backups.beginUpload.mutationOptions())
  const finish = useMutation(trpc.backups.finishUpload.mutationOptions())
  const [name, setName] = useState('')
  const [sent, setSent] = useState<number | null>(null)
  const [importId, setImportId] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const watched = useQuery({
    ...trpc.backups.upload.queryOptions({ serverId: view.id, importId: importId ?? '' }),
    enabled: importId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'reading' ? READING_POLL_MS : false),
  })
  const state = watched.data ?? null

  const send = async () => {
    setFailure(null)
    try {
      setSent(0)
      const start = await begin.mutateAsync({ serverId: view.id, fileName: file.name, sizeBytes: file.size })
      await putFile(start.url, start.headers, file, setSent)
      const started = await finish.mutateAsync({
        serverId: view.id,
        ticket: start.ticket,
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      setImportId(started.importId)
    } catch (error) {
      setFailure(messageOf(error))
      setSent(null)
    }
  }

  const busy = sent !== null && (importId === null || state === null || state.status === 'reading')
  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title="Bring a world"
      actions={
        <Actions
          state={state}
          sending={sent !== null}
          onSend={() => void send()}
          onClose={onClose}
          onKept={onKept}
        />
      }
    >
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        {sent === null && (
          <>
            <p>
              {file.name} · {bytes(file.size)}. Cubepals finds the world in it, whether it’s a single-player
              save, a server’s folder or a download, and keeps it as a backup of this server. You choose
              whether to play it next.
            </p>
            <TextField
              label="Name"
              optional
              maxLength={40}
              placeholder="The name it has in Minecraft"
              value={name}
              onChange={(event) => setName(event.target.value)}
              help="What this server calls the world, if it never had it before."
            />
          </>
        )}
        {sent !== null && importId === null && (
          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <span className="type-body-sm">Uploading…</span>
            <ProgressBar value={(sent / Math.max(file.size, 1)) * 100} label={`Uploading ${file.name}`} />
          </div>
        )}
        {importId !== null && (state === null || state.status === 'reading') && (
          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <span className="type-body-sm">Reading the world… A large one takes a minute or two.</span>
            <ProgressBar value={100} label="Reading the world" />
          </div>
        )}
        {state?.status === 'asking' && <Questions view={view} state={state} />}
        {state?.status === 'ready' && <Kept notes={state.notes} />}
        {state?.status === 'ready' && state.people !== null && (
          <LetIn view={view} importId={state.importId} people={state.people} />
        )}
        {state?.status === 'refused' && <Note tone="danger">{state.message}</Note>}
        {watched.isError && <Note tone="danger">{messageOf(watched.error)}</Note>}
        {failure && <Note tone="danger">{failure}</Note>}
      </div>
    </Modal>
  )
}

function Actions({
  state,
  sending,
  onSend,
  onClose,
  onKept,
}: {
  state: WorldImportView | null
  sending: boolean
  onSend: () => void
  onClose: () => void
  onKept: (backupId: string) => void
}) {
  if (state?.status === 'ready')
    return (
      <>
        <Button variant="ghost" onClick={onClose}>
          Not now
        </Button>
        <Button variant="primary" onClick={() => onKept(state.backupId)}>
          Restore it
        </Button>
      </>
    )
  if (state?.status === 'refused' || state?.status === 'asking')
    return (
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
    )
  return (
    <>
      <Button variant="ghost" disabled={sending} onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" disabled={sending} onClick={onSend}>
        Upload
      </Button>
    </>
  )
}

/** What the world needs its player to say, sent to its import; the dialog watches what follows. */
function Questions({
  view,
  state,
}: {
  view: ServerView
  state: Extract<WorldImportView, { status: 'asking' }>
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  // The answer comes back as the import read again, which the dialog watches until it ends.
  const answer = useMutation(
    trpc.backups.answerUpload.mutationOptions({
      onSuccess: (next) =>
        queries.setQueryData(
          trpc.backups.upload.queryKey({ serverId: view.id, importId: next.importId }),
          next,
        ),
    }),
  )
  return (
    <WorldQuestions
      asks={state}
      answering={answer.isPending}
      failure={answer.isError ? messageOf(answer.error) : null}
      onAnswer={(given) => answer.mutate({ serverId: view.id, importId: state.importId, ...given })}
    />
  )
}

/** The world is kept: what Cubepals did to bring it, in the player's words. */
function Kept({ notes }: { notes: string[] }) {
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <p>
        It’s kept as a backup of this server. Restore it to play it; the world it has now is backed up first.
      </p>
      <BroughtNotes notes={notes} />
    </div>
  )
}

/**
 * Who of the players of the server the world came from its owner lets into this one: chosen here,
 * and let in at once, as players added by name are, whether or not they restore the world.
 */
function LetIn({
  view,
  importId,
  people,
}: {
  view: ServerView
  importId: string
  people: NonNullable<WorldPeople>
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const [choice, setChoice] = useState<PeopleChoice>(DEFAULT_PEOPLE_CHOICE)
  const letIn = useMutation(
    trpc.backups.letInFromUpload.mutationOptions({
      onSuccess: () =>
        queries.invalidateQueries({ queryKey: trpc.access.get.queryKey({ serverId: view.id }) }),
    }),
  )
  const nothing = choice.letIn.length === 0 && (!choice.keepBans || people.bans.length === 0)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      <WorldPeopleChoice people={people} choice={choice} disabled={letIn.isSuccess} onChange={setChoice} />
      {letIn.isSuccess ? (
        <Note tone="success">Done. They’re on this server’s players page.</Note>
      ) : (
        <div>
          <Button
            variant="secondary"
            disabled={nothing}
            busy={letIn.isPending ? 'Letting them in' : undefined}
            onClick={() => letIn.mutate({ serverId: view.id, importId, ...choice })}
          >
            Let them in
          </Button>
        </div>
      )}
      {letIn.isError && <Note tone="danger">{messageOf(letIn.error)}</Note>}
    </div>
  )
}
