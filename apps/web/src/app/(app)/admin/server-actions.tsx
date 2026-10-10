// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What an admin does to someone else's server, from the pages where they find it: stop it for
 * maintenance, start it, restore one of its backups, or send it to the trash and take it back.
 * Each goes the way its owner's own would, and each asks why, which the audit log keeps.
 */
import type { BackupView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { messageOf, useTRPC } from '../../../lib/api'
import { useNow } from '../../../lib/hooks'
import { newId } from '../../../lib/ids'
import { whenTaken } from '../../../lib/present'
import { Button, Modal, Note, Select, Skeleton, TextField, Toggle } from '../../../ui'

/** A server as the admin pages list it. */
interface AdminServer {
  id: string
  name: string
  status: string
  deleted: boolean
}

type Action = 'stop' | 'start' | 'restore' | 'trash' | 'untrash'

const LABELS: Record<Action, string> = {
  stop: 'Stop for maintenance',
  start: 'Start',
  restore: 'Restore a backup',
  trash: 'Send to the trash',
  untrash: 'Take out of the trash',
}

/** What the server's state lets an admin do, as its owner could: a purged one is gone. */
function actionsFor(server: AdminServer): Action[] {
  if (server.deleted || server.status === 'deleted') return ['untrash']
  if (server.status === 'purged') return []
  const actions: Action[] = []
  if (server.status === 'running') actions.push('stop')
  if (server.status === 'stopped' || server.status === 'stored') actions.push('start')
  if (server.status === 'running' || server.status === 'stopped' || server.status === 'failed')
    actions.push('restore')
  actions.push('trash')
  return actions
}

/** The buttons for one server, and the dialog each opens. */
export function ServerActions({ server }: { server: AdminServer }) {
  const [open, setOpen] = useState<Action | null>(null)
  const close = () => setOpen(null)
  return (
    <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
      {actionsFor(server).map((action) => (
        <Button key={action} variant="outline" size="sm" onClick={() => setOpen(action)}>
          {LABELS[action]}
        </Button>
      ))}
      {open === 'stop' && <MaintenanceStop server={server} onClose={close} />}
      {open === 'start' && <Start server={server} onClose={close} />}
      {open === 'restore' && <Restore server={server} onClose={close} />}
      {open === 'trash' && <Trash server={server} onClose={close} />}
      {open === 'untrash' && <Untrash server={server} onClose={close} />}
    </div>
  )
}

/** Once a change is made: the dialog closes, and the admin pages show where the server is now. */
function useDone(onClose: () => void) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  return () => {
    onClose()
    return queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
  }
}

/** A dialog for one action: what it does, anything else it needs, and why, which is always asked. */
function WithReason({
  title,
  label,
  danger = false,
  ready = true,
  pending,
  error,
  onConfirm,
  onClose,
  children,
}: {
  title: string
  label: string
  danger?: boolean
  ready?: boolean
  pending: boolean
  error: unknown
  onConfirm: (reason: string) => void
  onClose: () => void
  children: ReactNode
}) {
  const [reason, setReason] = useState('')
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!ready || reason.trim().length === 0 || pending}
            onClick={() => onConfirm(reason)}
          >
            {label}
          </Button>
        </>
      }
    >
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        {children}
        <TextField
          label="Why"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
        {error ? <Note tone="danger">{messageOf(error)}</Note> : null}
      </div>
    </Modal>
  )
}

/** One server stopped for the platform's upkeep: its owner sees Blockly did it, and can start it again. */
function MaintenanceStop({ server, onClose }: { server: AdminServer; onClose: () => void }) {
  const trpc = useTRPC()
  const [requestId] = useState(() => newId())
  const stop = useMutation(trpc.admin.stopForMaintenance.mutationOptions({ onSuccess: useDone(onClose) }))
  return (
    <WithReason
      title={`Stop ${server.name} for maintenance?`}
      label="Stop it"
      danger
      pending={stop.isPending}
      error={stop.error}
      onConfirm={(reason) => stop.mutate({ serverId: server.id, requestId, reason })}
      onClose={onClose}
    >
      <p>
        It saves and stops. Its owner sees Cubepals stopped it for maintenance, and can start it again
        whenever they like.
      </p>
    </WithReason>
  )
}

function Start({ server, onClose }: { server: AdminServer; onClose: () => void }) {
  const trpc = useTRPC()
  const [requestId] = useState(() => newId())
  const start = useMutation(trpc.admin.startServer.mutationOptions({ onSuccess: useDone(onClose) }))
  return (
    <WithReason
      title={`Start ${server.name}?`}
      label="Start it"
      pending={start.isPending}
      error={start.error}
      onConfirm={(reason) => start.mutate({ serverId: server.id, requestId, reason })}
      onClose={onClose}
    >
      <p>It starts as if its owner pressed Start, so their plan’s hours and limits still count.</p>
    </WithReason>
  )
}

/** Like its owner's delete: confirmed by its name, and kept in their trash as long as their plan says. */
function Trash({ server, onClose }: { server: AdminServer; onClose: () => void }) {
  const trpc = useTRPC()
  const [typed, setTyped] = useState('')
  const trash = useMutation(trpc.admin.trashServer.mutationOptions({ onSuccess: useDone(onClose) }))
  return (
    <WithReason
      title={`Send ${server.name} to the trash?`}
      label="Send to the trash"
      danger
      ready={typed.trim() === server.name.trim()}
      pending={trash.isPending}
      error={trash.error}
      onConfirm={(reason) => trash.mutate({ serverId: server.id, confirmName: typed, reason })}
      onClose={onClose}
    >
      <p>
        It stops and its address stops working. It waits in its owner’s trash for as long as their plan keeps
        it there, and they can restore it until then.
      </p>
      <TextField
        label={`Type ${server.name} to confirm`}
        value={typed}
        autoComplete="off"
        onChange={(event) => setTyped(event.target.value)}
      />
    </WithReason>
  )
}

function Untrash({ server, onClose }: { server: AdminServer; onClose: () => void }) {
  const trpc = useTRPC()
  const untrash = useMutation(trpc.admin.untrashServer.mutationOptions({ onSuccess: useDone(onClose) }))
  return (
    <WithReason
      title={`Take ${server.name} out of the trash?`}
      label="Take it out"
      pending={untrash.isPending}
      error={untrash.error}
      onConfirm={(reason) => untrash.mutate({ serverId: server.id, reason })}
      onClose={onClose}
    >
      <p>It comes back stopped. If another server took its address meanwhile, it gets a new one.</p>
    </WithReason>
  )
}

/** One of its backups, restored the way its owner restores one from the backups page. */
function Restore({ server, onClose }: { server: AdminServer; onClose: () => void }) {
  const trpc = useTRPC()
  const now = useNow(60_000)
  const [requestId] = useState(() => newId())
  const [picked, setPicked] = useState<string | null>(null)
  const [withConfiguration, setWithConfiguration] = useState(false)
  const list = useQuery(trpc.admin.serverBackups.queryOptions({ serverId: server.id }))
  const restore = useMutation(trpc.admin.restoreBackup.mutationOptions({ onSuccess: useDone(onClose) }))
  const ready = list.data?.backups.filter((b) => b.status === 'ready') ?? []
  const backup = ready.find((b) => b.id === picked) ?? ready[0]
  return (
    <WithReason
      title={`Restore a backup of ${server.name}?`}
      label="Restore"
      ready={backup !== undefined}
      pending={restore.isPending}
      error={restore.error ?? list.error}
      onConfirm={(reason) =>
        backup &&
        restore.mutate({
          serverId: server.id,
          requestId,
          backupId: backup.id,
          withConfiguration: withConfiguration || backup.needsConfiguration,
          reason,
        })
      }
      onClose={onClose}
    >
      {list.isPending ? (
        <Skeleton width="100%" height={48} />
      ) : backup === undefined ? (
        <p>It has no backups to restore.</p>
      ) : (
        <>
          <Select
            label="Backup"
            value={backup.id}
            options={ready.map((b) => ({ value: b.id, label: backupLabel(b, now) }))}
            onChange={(event) => setPicked(event.target.value)}
          />
          {backup.trigger !== 'uploaded' && (
            <Toggle
              checked={withConfiguration || backup.needsConfiguration}
              disabled={backup.needsConfiguration}
              onChange={setWithConfiguration}
              label={`Also go back to the settings and mods from then (Minecraft ${backup.configuration.gameVersion})`}
            />
          )}
          <p>
            The world goes back to how it was then, and the world as it is now is kept as a backup first. Who
            can join stays as it is now. A running server restarts.
          </p>
        </>
      )}
    </WithReason>
  )
}

const backupLabel = (backup: BackupView, now: number): string =>
  `${whenTaken(backup.createdAt, now)} · ${backup.world.name}${backup.tier === 'archive' ? ' · download' : ''}`
