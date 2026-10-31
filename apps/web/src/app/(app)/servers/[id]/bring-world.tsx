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
import { SECOND_MS } from '@blockly/contracts/durations'
import { compareVersions, isRelease } from '@blockly/contracts/release-order'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { messageOf, useTRPC } from '../../../../lib/api'
import { playedOn } from '../../../../lib/level-version'
import { bytes } from '../../../../lib/present'
import { readingLeft } from '../../../../lib/reading-pace'
import { useSentImport } from '../../../../lib/sent-import'
import { Button, Modal, Note, ProgressBar, TextField } from '../../../../ui'
import { UploadProgress } from '../../upload-progress'
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
  const { progress, importId, failure, send, stop } = useSentImport({
    begin: (chosen) => begin.mutateAsync({ serverId: view.id, ...chosen }),
    finish: (ticket) =>
      finish.mutateAsync({ serverId: view.id, ticket, ...(name.trim() ? { name: name.trim() } : {}) }),
  })
  const watched = useQuery({
    ...trpc.backups.upload.queryOptions({ serverId: view.id, importId: importId ?? '' }),
    enabled: importId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'reading' ? READING_POLL_MS : false),
  })
  const state = watched.data ?? null

  const uploading = progress !== null
  const reading = importId !== null && (state === null || state.status === 'reading')
  // While the file goes up, closing stops it; once it is up, the world is read whatever the page does.
  const close = () => {
    stop()
    onClose()
  }
  return (
    <Modal
      open
      onClose={reading ? () => {} : close}
      title="Bring a world"
      actions={
        <Actions
          state={state}
          sending={uploading || importId !== null}
          uploading={uploading}
          onSend={() => void send(file)}
          onClose={close}
          onKept={onKept}
        />
      }
    >
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        {!uploading && importId === null && (
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
            <NewerWorld file={file} view={view} />
          </>
        )}
        {progress !== null && <UploadProgress name={file.name} sent={progress.sent} total={progress.total} />}
        {reading && <ReadingWorld sizeBytes={file.size} />}
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
  uploading,
  onSend,
  onClose,
  onKept,
}: {
  state: WorldImportView | null
  sending: boolean
  /** The file is going up, and Cancel stops it. */
  uploading: boolean
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
  if (uploading)
    return (
      <Button variant="ghost" onClick={onClose}>
        Cancel
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

/**
 * What the file says of the Minecraft it was last played on, read before it is sent: a world from
 * a newer one is kept all the same, and restoring it moves the server up, which the player hears
 * now rather than after the upload.
 */
function NewerWorld({ file, view }: { file: File; view: ServerView }) {
  const [played, setPlayed] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void playedOn(file).then((version) => current && setPlayed(version))
    return () => {
      current = false
    }
  }, [file])
  // A snapshot's name orders against no release, so only a release is called newer.
  if (played === null || !isRelease(played) || compareVersions(played, view.gameVersion) <= 0) return null
  const plain = view.modCount === 0 && view.modpack === null
  return (
    <Note tone="info">
      It was last played on Minecraft {played}, newer than this server’s {view.gameVersion}. Cubepals keeps
      it, and{' '}
      {plain
        ? `restoring it moves the server up to ${played}.`
        : `the server moves to ${played} in Settings first, so its mods move with it.`}
    </Note>
  )
}

/** The world being read on a worker, with a countdown from its size (`reading-pace.ts`). */
function ReadingWorld({ sizeBytes }: { sizeBytes: number }) {
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SECOND_MS)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <span className="type-body-sm">
        Reading the world, {bytes(sizeBytes)}: finding it, checking it and keeping it as a backup.
      </span>
      <ProgressBar value={null} label="Reading the world" />
      <span className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        {readingLeft(sizeBytes, startedAt, now)}
      </span>
    </div>
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
