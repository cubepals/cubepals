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
import type { ServerView, WorldImportView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../../lib/api'
import { bytes } from '../../../../lib/present'
import { putFile } from '../../../../lib/upload'
import { Button, Modal, Note, ProgressBar, Select, TextField } from '../../../../ui'

/** What a world upload takes: a zip of its folder, or a tarball as a server download comes. */
export const WORLD_FILES = '.zip,.tar.gz,.tgz,.tar,application/zip,application/gzip,application/x-tar'

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

/** What the world needs its player to say: which one, and who played it. */
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
  const [folder, setFolder] = useState(state.worlds?.[0]?.folder ?? '')
  const [player, setPlayer] = useState('')
  const say = (given: { folder?: string; player?: string | null }) =>
    answer.mutate({ serverId: view.id, importId: state.importId, ...given })
  if (state.worlds !== null)
    return (
      <form
        className="bk-stack"
        style={{ gap: 'var(--space-12)' }}
        onSubmit={(event) => {
          event.preventDefault()
          say({ folder })
        }}
      >
        <p>This file holds more than one world. Which one should this server have?</p>
        <Select
          label="World"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          options={state.worlds.map((world) => ({
            value: world.folder,
            label: [
              world.name,
              world.gameVersion && `Minecraft ${world.gameVersion}`,
              world.folder.slice(0, -1),
            ]
              .filter(Boolean)
              .join(' · '),
          }))}
        />
        <div>
          <Button type="submit" variant="primary" busy={answer.isPending ? 'Bringing it' : undefined}>
            Bring this one
          </Button>
        </div>
        {answer.isError && <Note tone="danger">{messageOf(answer.error)}</Note>}
      </form>
    )
  return (
    <form
      className="bk-stack"
      style={{ gap: 'var(--space-12)' }}
      onSubmit={(event) => {
        event.preventDefault()
        if (player.trim()) say({ player: player.trim() })
      }}
    >
      <p>
        This is a single-player world. Who played it? What they carried and where they stood go to that
        Minecraft account on this server.
      </p>
      <TextField
        label="Minecraft name"
        maxLength={32}
        autoComplete="off"
        value={player}
        onChange={(event) => setPlayer(event.target.value)}
        {...(state.problem ? { error: state.problem } : {})}
      />
      <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
        <Button
          type="submit"
          variant="primary"
          disabled={!player.trim()}
          busy={answer.isPending ? 'Bringing it' : undefined}
        >
          Continue
        </Button>
        <Button variant="ghost" disabled={answer.isPending} onClick={() => say({ player: null })}>
          Nobody, just the world
        </Button>
      </div>
      {answer.isError && <Note tone="danger">{messageOf(answer.error)}</Note>}
    </form>
  )
}

/** The world is kept: what Cubepals did to bring it, in the player's words. */
function Kept({ notes }: { notes: string[] }) {
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <p>
        It’s kept as a backup of this server. Restore it to play it; the world it has now is backed up first.
      </p>
      {notes.length > 0 && (
        <ul className="type-body-sm" style={{ color: 'var(--ink-muted)', paddingLeft: 'var(--space-16)' }}>
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
