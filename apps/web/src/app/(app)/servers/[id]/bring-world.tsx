// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Bringing a world a player has to their server, and playing it (docs/world-import.md): the file
 * sent straight to the store, read on a worker, a question asked where only the player knows the
 * answer, then the world shown by its name with what Cubepals did, and one press that plays it.
 * Playing it restores the backup the world waits in (`backups.restore`), which keeps the world the
 * server had; "Not now" leaves it waiting in Backups. The words are `bring-world-lines.ts`'s.
 */
import {
  type BroughtWorld,
  DEFAULT_PEOPLE_CHOICE,
  type PeopleChoice,
  type ServerView,
  type WorldImportView,
  type WorldPeople,
} from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'
import { compareVersions, isRelease } from '@blockly/contracts/release-order'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { messageOf, useTRPC } from '../../../../lib/api'
import { levelOf } from '../../../../lib/level-version'
import { bytes, iconSrc } from '../../../../lib/present'
import { readingLeft } from '../../../../lib/reading-pace'
import { useSentImport } from '../../../../lib/sent-import'
import { Button, Modal, Note, ProgressBar, TextField } from '../../../../ui'
import { UploadProgress } from '../../upload-progress'
import { WorldPeopleChoice } from '../../world-people'
import { BroughtNotes, WorldQuestions } from '../../world-questions'
import {
  comingName,
  KEPT_LINE,
  movesLine,
  playLabel,
  type Stage,
  serverLine,
  titleOf,
} from './bring-world-lines'
import { changeable, useChanged } from './settings/shared'
import { requestId } from './use-server'

/** How often a world being read is asked about: reading a large one takes a minute or two. */
const READING_POLL_MS = 1500

type Ready = Extract<WorldImportView, { status: 'ready' }>

export function BringWorld({ view, file, onClose }: { view: ServerView; file: File; onClose: () => void }) {
  const [name, setName] = useState('')
  const level = useLevel(file)
  const { progress, importId, state, send, stop, ...sent } = useBringing(view, name)
  const play = usePlay(view, onClose)
  const sending = progress !== null || importId !== null
  const reading = importId !== null && (state === null || state.status === 'reading')
  const ready = state?.status === 'ready' ? state : null
  const coming = comingName(name, level.name)
  // While the file goes up, closing stops it; once it is up, the world is read whatever the page does.
  const close = () => {
    stop()
    onClose()
  }
  return (
    <Modal
      open
      onClose={reading || play.pending ? () => {} : close}
      title={titleOf(stageOf(sending, state), ready?.world?.name ?? coming)}
      actions={
        <Actions
          state={state}
          view={view}
          sending={sending}
          uploading={progress !== null}
          playing={play.pending}
          onSend={() => void send(file)}
          onClose={close}
          onPlay={play.play}
        />
      }
    >
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        {!sending && <Picked file={file} view={view} level={level} name={name} onName={setName} />}
        {progress !== null && <UploadProgress name={file.name} sent={progress.sent} total={progress.total} />}
        {reading && <ReadingWorld name={coming} sizeBytes={file.size} />}
        {state?.status === 'asking' && <Questions view={view} state={state} />}
        {ready && <ReadyToPlay view={view} ready={ready} />}
        {failuresOf(state, [sent.failure, sent.watching, play.failure]).map((failure) => (
          <Note key={failure} tone="danger">
            {failure}
          </Note>
        ))}
      </div>
    </Modal>
  )
}

/**
 * The file sent straight to the store and finished as an import of this server, named as its
 * player said, then watched while it is read.
 */
function useBringing(view: ServerView, name: string) {
  const trpc = useTRPC()
  const begin = useMutation(trpc.backups.beginUpload.mutationOptions())
  const finish = useMutation(trpc.backups.finishUpload.mutationOptions())
  const sent = useSentImport({
    begin: (chosen) => begin.mutateAsync({ serverId: view.id, ...chosen }),
    finish: (ticket) =>
      finish.mutateAsync({ serverId: view.id, ticket, ...(name.trim() ? { name: name.trim() } : {}) }),
  })
  const watched = useQuery({
    ...trpc.backups.upload.queryOptions({ serverId: view.id, importId: sent.importId ?? '' }),
    enabled: sent.importId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'reading' ? READING_POLL_MS : false),
  })
  return { ...sent, state: watched.data ?? null, watching: watched.isError ? messageOf(watched.error) : null }
}

/** What went wrong, each said once: the refusal, then the upload, watching it and playing it. */
function failuresOf(state: WorldImportView | null, failures: ReadonlyArray<string | null>): string[] {
  const said = [state?.status === 'refused' ? state.message : null, ...failures]
  return [...new Set(said.filter((line): line is string => line !== null))]
}

/** Where the dialog is, for its title. */
function stageOf(sending: boolean, state: WorldImportView | null): Stage {
  if (state?.status === 'ready') return 'ready'
  if (state?.status === 'refused') return 'refused'
  return sending ? 'coming' : 'picked'
}

/** What the file's own `level.dat` says, read in the browser before anything is sent. */
function useLevel(file: File): { gameVersion: string | null; name: string | null } {
  const [level, setLevel] = useState<{ gameVersion: string | null; name: string | null }>({
    gameVersion: null,
    name: null,
  })
  useEffect(() => {
    let current = true
    void levelOf(file).then((read) => current && setLevel(read))
    return () => {
      current = false
    }
  }, [file])
  return level
}

/**
 * Playing the world: the backup it waits in restored as the server's world, moving the server up
 * where the world is from a newer release, as its player read before pressing. One request id per
 * dialog, so a second press is the same request. The dialog closes on it, and the page's own
 * progress takes over.
 */
function usePlay(view: ServerView, onPlayed: () => void) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const changed = useChanged(view.id)
  const [request] = useState(requestId)
  const restore = useMutation(
    trpc.backups.restore.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        void queries.invalidateQueries({ queryKey: trpc.worlds.list.queryKey({ serverId: view.id }) })
        void queries.invalidateQueries({ queryKey: trpc.backups.list.queryKey({ serverId: view.id }) })
        onPlayed()
      },
    }),
  )
  const play = (ready: Ready) => {
    if (ready.world === null) return
    restore.mutate({
      serverId: view.id,
      requestId: request,
      backupId: ready.backupId,
      withConfiguration: false,
      ...(ready.world.newer?.movesServer ? { moveUp: true } : {}),
    })
  }
  return { play, pending: restore.isPending, failure: restore.isError ? messageOf(restore.error) : null }
}

function Actions({
  state,
  view,
  sending,
  uploading,
  playing,
  onSend,
  onClose,
  onPlay,
}: {
  state: WorldImportView | null
  view: ServerView
  sending: boolean
  /** The file is going up, and Cancel stops it. */
  uploading: boolean
  playing: boolean
  onSend: () => void
  onClose: () => void
  onPlay: (ready: Ready) => void
}) {
  if (state?.status === 'ready' && state.world !== null)
    return (
      <PlayActions
        view={view}
        world={state.world}
        playing={playing}
        onClose={onClose}
        onPlay={() => onPlay(state)}
      />
    )
  if (state?.status === 'ready' || state?.status === 'refused' || state?.status === 'asking')
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
  // Up and being read: nothing to press until it is ready, and the countdown says how long.
  if (sending) return null
  return (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" onClick={onSend}>
        Upload
      </Button>
    </>
  )
}

/** "Not now", quietly, and the one press that plays the world, held while the server is busy. */
function PlayActions({
  view,
  world,
  playing,
  onClose,
  onPlay,
}: {
  view: ServerView
  world: BroughtWorld
  playing: boolean
  onClose: () => void
  onPlay: () => void
}) {
  const allowed = changeable(view)
  // A server with mods moves in its settings first, so there is nothing to press here yet.
  const blocked = world.newer !== null && !world.newer.movesServer
  return (
    <>
      <Button variant="ghost" disabled={playing} onClick={onClose}>
        Not now
      </Button>
      <Button
        variant="primary"
        disabled={blocked || !allowed.ok}
        busy={playing ? `Switching to ${world.name}` : undefined}
        onClick={onPlay}
      >
        {playLabel(world)}
      </Button>
    </>
  )
}

/** The file picked, before it is sent: what Cubepals does with it, and the name it can be given. */
function Picked({
  file,
  view,
  level,
  name,
  onName,
}: {
  file: File
  view: ServerView
  level: { gameVersion: string | null; name: string | null }
  name: string
  onName: (name: string) => void
}) {
  return (
    <>
      <p>
        {file.name} · {bytes(file.size)}. Cubepals finds the world in it, whether it’s a single-player save, a
        server’s folder or a download, and gets it ready for this server. Then you play it.
      </p>
      <TextField
        label="Name"
        optional
        maxLength={40}
        placeholder={level.name ?? 'The name it has in Minecraft'}
        value={name}
        onChange={(event) => onName(event.target.value)}
        help="What this server calls the world, if it never had it before."
      />
      <NewerWorld played={level.gameVersion} view={view} />
    </>
  )
}

/**
 * What the file says of the Minecraft it was last played on, read before it is sent: a world from
 * a newer one comes in all the same, and playing it moves the server up, which the player hears
 * now rather than after the upload.
 */
function NewerWorld({ played, view }: { played: string | null; view: ServerView }) {
  // A snapshot's name orders against no release, so only a release is called newer.
  if (played === null || !isRelease(played) || compareVersions(played, view.gameVersion) <= 0) return null
  const plain = view.modCount === 0 && view.modpack === null
  return (
    <Note tone="info">
      It was last played on Minecraft {played}, newer than this server’s {view.gameVersion}.{' '}
      {plain
        ? `Playing it moves the server up to ${played}.`
        : `Before you play it, the server moves to ${played} in Settings, so its mods move with it.`}
    </Note>
  )
}

/** The world being read on a worker, by its name, with a countdown from its size (`reading-pace.ts`). */
function ReadingWorld({ name, sizeBytes }: { name: string | null; sizeBytes: number }) {
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SECOND_MS)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <span className="type-body-sm">
        Reading {name ?? 'the world'}, {bytes(sizeBytes)}: finding it, checking it and getting it ready for
        this server.
      </span>
      <ProgressBar value={null} label={`Reading ${name ?? 'the world'}`} />
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

/**
 * The world, read and ready: its name, the Minecraft it was played on and what Cubepals did, who
 * of its old server's players come along, and what playing it does to this server.
 */
function ReadyToPlay({ view, ready }: { view: ServerView; ready: Ready }) {
  const { world } = ready
  if (world === null)
    return <Note tone="info">This world is no longer in Backups. Upload it again to play it.</Note>
  const moves = movesLine(world, view.gameVersion)
  return (
    <>
      <WorldCard world={world} />
      {ready.notes.length > 0 && (
        <div className="bk-stack" style={{ gap: 'var(--space-4)' }}>
          <span className="type-label">What Cubepals did</span>
          <BroughtNotes notes={ready.notes} />
        </div>
      )}
      {ready.people !== null && <LetIn view={view} importId={ready.importId} people={ready.people} />}
      {moves !== null && <Note tone="info">{moves}</Note>}
      {world.newer !== null && !world.newer.movesServer && (
        <Note tone="info">
          It was last played on Minecraft {world.newer.gameVersion}, newer than this server’s{' '}
          {view.gameVersion}. Change the server to {world.newer.gameVersion} in{' '}
          <Link href={`/servers/${view.id}/settings`}>Settings</Link> first, so its mods move with it, then
          play {world.name} from Backups.
        </Note>
      )}
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        {serverLine(world.name, view.status)} {KEPT_LINE}
      </p>
    </>
  )
}

/** The world as its player knows it: its name, and the Minecraft it was last played on. */
function WorldCard({ world }: { world: BroughtWorld }) {
  return (
    <div className="bk-row" style={{ gap: 'var(--space-12)', alignItems: 'center' }}>
      <Image src={iconSrc('grass')} alt="" width={40} height={40} />
      <span className="bk-stack" style={{ gap: 'var(--space-4)' }}>
        <span className="type-heading-sm" style={{ color: 'var(--ink)' }}>
          {world.name}
        </span>
        <span className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          Last played on Minecraft {world.gameVersion}
        </span>
      </span>
    </div>
  )
}

/**
 * Who of the players of the server the world came from its owner lets into this one: chosen here,
 * and let in at once, as players added by name are, whether or not they play the world now.
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
