'use client'

import type { BackupsView, BackupView, ServerView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Download, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { codeOf, messageOf, useTRPC } from '../../../../../lib/api'
import { useNow } from '../../../../../lib/hooks'
import { said, useOutcome } from '../../../../../lib/outcome'
import { backupTitle, bytes, dayOf, loaderLabel, whenTaken } from '../../../../../lib/present'
import { putFile } from '../../../../../lib/upload'
import {
  Badge,
  Button,
  EmptyState,
  FileButton,
  FormRow,
  FormSection,
  ICON,
  LoadFailed,
  Modal,
  Note,
  ProgressBar,
  Skeleton,
  TextField,
  Toggle,
} from '../../../../../ui'
import { PlusOffer } from '../../../plus-offer'
import { ChangeState, ConfirmChange, useChanged } from '../settings/shared'
import { requestId, useServer } from '../use-server'
import { useWorldDownload } from './use-download'

/** What the page says backups are, and, where the deployment makes downloads, what one holds. */
function aboutBackups(kept: number, archives: boolean): string {
  const backups = `A backup a day while people play, and any you take yourself. Cubepals keeps your ${kept} newest, plus a few from before each change.`
  if (!archives) return backups
  return `${backups} A download holds your worlds and settings, without the game or its mods, which a server gets again when it starts.`
}

export default function BackupsPage() {
  const server = useServer()
  const trpc = useTRPC()
  const backups = useQuery(trpc.backups.list.queryOptions({ serverId: server.id }))
  const platform = useQuery(trpc.platform.capabilities.queryOptions())
  if (server.isPending || backups.isPending || platform.isPending) return <Skeleton width={240} height={36} />
  if (server.isError) return <LoadFailed error={messageOf(server.error)} onRetry={() => server.refetch()} />
  if (backups.isError)
    return <LoadFailed error={messageOf(backups.error)} onRetry={() => backups.refetch()} />
  if (platform.isError)
    return <LoadFailed error={messageOf(platform.error)} onRetry={() => platform.refetch()} />
  return <Backups view={server.data} list={backups.data} archives={platform.data.archives} />
}

function Backups({
  view,
  list,
  archives,
}: {
  view: ServerView
  list: BackupsView
  /** This deployment keeps archives at all; without them, nothing about downloads is shown. */
  archives: boolean
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const now = useNow(60_000)
  const [restoring, setRestoring] = useState<BackupView | null>(null)
  const [deleting, setDeleting] = useState<BackupView | null>(null)
  const [bringing, setBringing] = useState<File | null>(null)
  const refresh = () =>
    queries.invalidateQueries({ queryKey: trpc.backups.list.queryKey({ serverId: view.id }) })
  // "Backed up" once the backup this press asked for is there and ready; it starts no operation
  // of its own to follow, so the list says when.
  const outcome = useOutcome(view)
  const [askedAt, setAskedAt] = useState<number | null>(null)
  const create = useMutation(
    trpc.backups.create.mutationOptions({
      onSuccess: () => {
        setAskedAt(Date.now() - 1_000)
        return refresh()
      },
    }),
  )
  useEffect(() => {
    if (askedAt === null || list.inProgress) return
    const taken = list.backups.find((b) => b.tier === 'snapshot' && Date.parse(b.createdAt) >= askedAt)
    if (taken === undefined || taken.status === 'pending') return
    setAskedAt(null)
    if (taken.status === 'ready') outcome.settled()
    else outcome.refused()
  }, [askedAt, list, outcome])
  // The snapshot a download was asked of says when that download is ready, as the backup does.
  const packed = useOutcome(undefined)
  const [packing, setPacking] = useState<{ from: string; since: number } | null>(null)
  const [packedFrom, setPackedFrom] = useState<string | null>(null)
  const archive = useMutation(
    trpc.backups.archive.mutationOptions({
      onSuccess: (_, input) => {
        setPacking({ from: input.backupId, since: Date.now() - 1_000 })
        setPackedFrom(input.backupId)
        return refresh()
      },
      onError: () => packed.refused(),
    }),
  )
  const made =
    packing === null
      ? undefined
      : list.backups.find((b) => b.tier === 'archive' && Date.parse(b.createdAt) >= packing.since)
  useEffect(() => {
    if (packing === null || made === undefined || made.status === 'pending') return
    setPacking(null)
    if (made.status === 'ready') packed.settled()
    else packed.refused()
  }, [packing, made, packed])
  const downloads = useWorldDownload(view.id)
  const remove = useMutation(
    trpc.backups.delete.mutationOptions({
      onSuccess: () => {
        setDeleting(null)
        return refresh()
      },
    }),
  )
  const busy = view.status !== 'running' && view.status !== 'stopped'
  const snapshotting = list.inProgress || create.isPending
  const canArchive = list.archives.create.available
  const actionError = archive.error

  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Backups
      </h1>
      <ChangeState view={view} />
      <FormSection
        title="Your backups"
        description={aboutBackups(list.kept, archives)}
        actions={
          <>
            {create.isError && (
              <span className="type-body-sm" style={{ color: 'var(--danger)', marginRight: 'auto' }}>
                {messageOf(create.error)}
              </span>
            )}
            {/* Where the plan doesn't restore downloads it stays, dimmed; the note below says why. */}
            {archives && (
              <FileButton
                accept=".tar.gz,.tgz,application/gzip"
                icon={<Upload {...ICON} aria-hidden />}
                disabled={busy || !list.archives.restore.available}
                onFile={setBringing}
              >
                Upload a download
              </FileButton>
            )}
            <Button
              variant="primary"
              icon={<Archive {...ICON} aria-hidden />}
              busy={snapshotting ? 'Backing up the world' : undefined}
              {...said(outcome, { done: 'Backed up', failed: 'Didn’t back up' })}
              disabled={busy}
              onClick={() => create.mutate({ serverId: view.id, requestId: requestId() })}
            >
              Back up now
            </Button>
          </>
        }
      >
        {archives && !list.archives.create.available && (
          <Note tone="info">{list.archives.create.message} Backups here still restore as usual.</Note>
        )}
        {archives && !list.archives.restore.available && list.archives.create.available && (
          <Note tone="info">{list.archives.restore.message}</Note>
        )}
        {/* A second download in a day, on a plan that makes one: said calmly, with the plan
            that makes more. */}
        {actionError && codeOf(actionError) === 'rate_limited' ? (
          <>
            <Note tone="info">{messageOf(actionError)}</Note>
            <PlusOffer
              why="Downloads whenever you like, and a weekly one kept for you, come with Plus."
              reason="backups"
            />
          </>
        ) : (
          actionError && <Note tone="danger">{messageOf(actionError)}</Note>
        )}
        {downloads.note}
        {list.backups.length === 0 ? (
          <EmptyState
            title="No backups yet"
            description="The first one is taken after people play, or now if you back up yourself."
          />
        ) : (
          list.backups.map((backup) => (
            <FormRow
              key={backup.id}
              label={
                <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
                  {whenTaken(backup.createdAt, now)}
                  <Badge tone={backup.tier === 'archive' ? 'info' : 'outline'}>{backupTitle(backup)}</Badge>
                  {backup.status === 'failed' && <Badge tone="danger">Couldn’t be made</Badge>}
                  {backup.tier === 'archive' && backup.status === 'ready' && !archives && (
                    <Badge tone="outline">Not available on this deployment</Badge>
                  )}
                </span>
              }
              description={[
                backup.world.name,
                `Minecraft ${backup.configuration.gameVersion} ${loaderLabel(backup.configuration.loader)}`,
                backup.configuration.mods > 0 ? `${backup.configuration.mods} mods` : null,
                // A snapshot's size is Fly's count of changed blocks: a volume's first one, after
                // a restore too, counts the whole disk. Only a download's size is the world's.
                backup.tier === 'archive' ? bytes(backup.sizeBytes) : null,
                backup.tier === 'archive' && backup.status === 'ready' && backup.expiresAt
                  ? `Kept until ${dayOf(backup.expiresAt)}`
                  : null,
                backup.status === 'failed' && backup.error ? backup.error : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              control={
                backup.status === 'pending' ? (
                  <span className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
                    Packing it up…
                  </span>
                ) : backup.status === 'failed' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove.mutate({ serverId: view.id, backupId: backup.id })}
                  >
                    Dismiss
                  </Button>
                ) : (
                  <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(backup)}>
                      Delete
                    </Button>
                    {backup.tier === 'snapshot' && archives && (
                      <Button
                        variant="ghost"
                        size="sm"
                        {...(packing?.from === backup.id ? { busy: 'Packing it up' } : {})}
                        {...(packedFrom === backup.id
                          ? said(packed, { done: 'Ready', failed: 'Didn’t pack' })
                          : {})}
                        disabled={!canArchive || archive.isPending || packing !== null}
                        onClick={() =>
                          archive.mutate({ serverId: view.id, requestId: requestId(), backupId: backup.id })
                        }
                      >
                        Make a download
                      </Button>
                    )}
                    {backup.tier === 'archive' && archives && (
                      <Button
                        variant="outline"
                        size="sm"
                        icon={<Download {...ICON} aria-hidden />}
                        {...downloads.button(backup.id)}
                      >
                        Download
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || (backup.tier === 'archive' && !list.archives.restore.available)}
                      onClick={() => setRestoring(backup)}
                    >
                      Restore
                    </Button>
                  </div>
                )
              }
            />
          ))
        )}
      </FormSection>
      {restoring && <Restore view={view} backup={restoring} now={now} onClose={() => setRestoring(null)} />}
      {bringing && (
        <BringBack
          view={view}
          file={bringing}
          onClose={() => setBringing(null)}
          onKept={async (backupId) => {
            setBringing(null)
            const fresh = await queries.query(trpc.backups.list.queryOptions({ serverId: view.id }))
            setRestoring(fresh.backups.find((b) => b.id === backupId) ?? null)
          }}
        />
      )}
      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this backup?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate({ serverId: view.id, backupId: deleting.id })}
            >
              Delete backup
            </Button>
          </>
        }
      >
        <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
          <p>
            {deleting ? `${whenTaken(deleting.createdAt, now)}, ${deleting.world.name}. ` : ''}It can’t be
            brought back.
          </p>
          {remove.isError && <Note tone="danger">{messageOf(remove.error)}</Note>}
        </div>
      </Modal>
    </>
  )
}

/**
 * A world downloaded before, sent back: straight to the store, then read for the world it holds
 * and kept as a backup. Restoring it is the next step, offered at once.
 */
function BringBack({
  view,
  file,
  onClose,
  onKept,
}: {
  view: ServerView
  file: File
  onClose: () => void
  onKept: (backupId: string) => void
}) {
  const trpc = useTRPC()
  const begin = useMutation(trpc.backups.beginUpload.mutationOptions())
  const finish = useMutation(trpc.backups.finishUpload.mutationOptions())
  const [name, setName] = useState('')
  const [progress, setProgress] = useState<{ stage: string; done: number } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const send = async () => {
    setFailure(null)
    try {
      setProgress({ stage: 'Uploading…', done: 0 })
      const start = await begin.mutateAsync({ serverId: view.id, fileName: file.name, sizeBytes: file.size })
      await putFile(start.url, start.headers, file, (sent) =>
        setProgress({ stage: 'Uploading…', done: (sent / file.size) * 100 }),
      )
      setProgress({ stage: 'Reading the world…', done: 100 })
      const kept = await finish.mutateAsync({
        serverId: view.id,
        ticket: start.ticket,
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      onKept(kept.backupId)
    } catch (error) {
      setFailure(messageOf(error))
      setProgress(null)
    }
  }
  return (
    <Modal
      open
      onClose={progress ? () => {} : onClose}
      title="Bring back a world"
      actions={
        <>
          <Button variant="ghost" disabled={progress !== null} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={progress !== null} onClick={() => void send()}>
            Upload
          </Button>
        </>
      }
    >
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        <p>
          {file.name} · {bytes(file.size)}. It becomes a backup of this server, and you choose whether to
          restore it next.
        </p>
        <TextField
          label="Name"
          optional
          maxLength={40}
          placeholder="Uploaded world"
          value={name}
          onChange={(event) => setName(event.target.value)}
          help="Used if this server never had the world before."
        />
        {progress && (
          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <span className="type-body-sm">{progress.stage}</span>
            <ProgressBar value={progress.done} label={`Uploading ${file.name}`} />
          </div>
        )}
        {failure && <Note tone="danger">{failure}</Note>}
      </div>
    </Modal>
  )
}

function Restore({
  view,
  backup,
  now,
  onClose,
}: {
  view: ServerView
  backup: BackupView
  now: number
  onClose: () => void
}) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  // A world from a newer version only opens with the configuration it ran on.
  const [withConfiguration, setWithConfiguration] = useState(backup.needsConfiguration)
  const restore = useMutation(
    trpc.backups.restore.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        onClose()
      },
    }),
  )
  const send = (requestId: string, acknowledgeRevoked: boolean) =>
    restore.mutateAsync({
      serverId: view.id,
      requestId,
      backupId: backup.id,
      withConfiguration,
      acknowledgeRevoked,
    })
  return (
    <ConfirmChange
      open
      onClose={onClose}
      title={`Restore the backup from ${whenTaken(backup.createdAt, now).toLowerCase()}?`}
      confirmLabel={view.status === 'running' ? 'Restore and restart' : 'Restore'}
      working="Bringing the world back"
      error={restore.error}
      onConfirm={(requestId) => send(requestId, false)}
      onAcknowledge={(requestId) => send(requestId, true)}
    >
      <p>
        {backup.trigger === 'uploaded'
          ? `${backup.world.name} comes back as the download holds it.`
          : `${backup.world.name} goes back to how it was then.`}{' '}
        Who can join stays as it is now: bans, operators and the whitelist are put back after the restore.
      </p>
      {backup.trigger !== 'uploaded' && (
        <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
          <Toggle
            checked={withConfiguration}
            disabled={backup.needsConfiguration}
            onChange={setWithConfiguration}
            label={`Also go back to the settings and mods from then (Minecraft ${backup.configuration.gameVersion}, ${loaderLabel(backup.configuration.loader)}${backup.configuration.mods > 0 ? `, ${backup.configuration.mods} mods` : ''})`}
          />
          {backup.needsConfiguration && (
            <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
              This world ran on a newer Minecraft than the server has now, so it comes back with its settings.
            </p>
          )}
        </div>
      )}
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        The world as it is now is kept as a backup first.
        {view.status === 'running'
          ? ' The server restarts, and anyone online can join again once it’s back.'
          : ''}
      </p>
    </ConfirmChange>
  )
}
