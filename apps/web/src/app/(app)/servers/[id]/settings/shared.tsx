// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { ServerView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { codeOf, messageOf, useTRPC } from '../../../../../lib/api'
import { useNow, useSince } from '../../../../../lib/hooks'
import {
  busyWord,
  etaLine,
  presentProgress,
  presentStatus,
  sizeLabel,
  timeAgo,
} from '../../../../../lib/present'
import { ActionButton, Button, ICON, Modal, Note, ProvisioningPanel, Toggle } from '../../../../../ui'
import { BootLine } from '../boot-line'
import { requestId } from '../use-server'

/**
 * Whether the server takes a configuration change now. A running server restarts into it, a
 * stopped one keeps it for its next start; anything in between is busy, and `busy` is what with,
 * in the words a button wears meanwhile: "Applying your changes", "Waking it up". A failed server
 * isn't busy, and says why where its failure is shown.
 */
export function changeable(view: ServerView): { ok: boolean; busy: string | undefined } {
  if (view.activeOperation !== null) return { ok: false, busy: busyWord(view.activeOperation) }
  if (view.status === 'running' || view.status === 'stopped') return { ok: true, busy: undefined }
  return { ok: false, busy: BUSY_STATUS[view.status] }
}

/** What a server is doing in a status that is on its way somewhere, when no operation says. */
const BUSY_STATUS: Partial<Record<ServerView['status'], string>> = {
  provisioning: 'Building your world',
  starting: 'Waking it up',
  stopping: 'Putting it to sleep',
  updating: 'Applying your changes',
  restoring: 'Bringing the world back',
  relocating: 'Moving it',
}

/** What saving a boot change does to this server right now, in one sentence. */
export function whatHappens(view: ServerView): string {
  return view.status === 'running'
    ? 'The server saves the world and restarts with the change. Anyone online is back in about half a minute. If the change doesn’t start, the server goes back to how it was.'
    : 'The change applies the next time the server starts.'
}

/** After a change: the server view comes back with it, and the history and choices move on. */
export function useChanged(serverId: string) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  return (view: ServerView) => {
    queries.setQueryData(trpc.servers.get.queryKey({ serverId }), view)
    void queries.invalidateQueries({ queryKey: trpc.servers.revisions.queryKey({ serverId }) })
    void queries.invalidateQueries({ queryKey: trpc.servers.settingsOptions.queryKey({ serverId }) })
  }
}

/** What a change does beyond the settings themselves: a plan moving the server to its own size. */
export function planLines(view: ServerView): string[] {
  if (view.movesToSize === null) return []
  return [`Size ${sizeLabel(view.memoryTier)} → ${view.movesToSize.label}, the size your plan offers`]
}

/**
 * The last look before a change goes to the server: what changes, and what that does. When the
 * change pins jars taken down where they were published, the refusal says which, and the owner
 * can choose to run them anyway (`onAcknowledge` sends the change again, saying so).
 */
export function ConfirmChange({
  open,
  onClose,
  title,
  lines,
  children,
  cancelLabel = 'Cancel',
  confirmLabel,
  tone = 'primary',
  working,
  error,
  onConfirm,
  onAcknowledge,
  disabled,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  lines?: string[]
  children?: ReactNode
  /** What keeping things as they are is called, where "Cancel" says less than it could. */
  cancelLabel?: string
  confirmLabel: string
  /** `danger` for a change that gives up a protection. */
  tone?: 'primary' | 'danger'
  /** What the button says while the change is going through: "Saving your changes". */
  working: string
  error: unknown
  /** The change itself, given a request id that stays the same however often it is clicked. */
  onConfirm: (requestId: string) => Promise<unknown>
  onAcknowledge?: (requestId: string) => Promise<unknown>
  /** Nothing to confirm yet, or something in the way. */
  disabled?: boolean
}) {
  const takenDown = codeOf(error) === 'revoked_artifacts' && onAcknowledge !== undefined
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          {/* One button, whichever it is offering: it holds its working words long enough to
              read, takes one press however many times it is clicked, and says what failed. */}
          <ActionButton
            phases={{
              confirm: {
                icon: <Check {...ICON} aria-hidden />,
                label: confirmLabel,
                working,
                failed: 'Didn’t go through',
                variant: tone,
                run: onConfirm,
              },
              anyway: {
                icon: <AlertTriangle {...ICON} aria-hidden />,
                label: 'Run it anyway',
                working,
                failed: 'Didn’t go through',
                variant: 'danger',
                run: onAcknowledge ?? onConfirm,
              },
            }}
            now={takenDown ? 'anyway' : 'confirm'}
            disabled={disabled}
          />
        </>
      }
    >
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        {lines && lines.length > 0 && (
          <ul
            className="bk-stack type-body"
            style={{ gap: 'var(--space-4)', paddingLeft: 'var(--space-20)' }}
          >
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {children}
        {error ? <Note tone="danger">{messageOf(error)}</Note> : null}
      </div>
    </Modal>
  )
}

/**
 * Jars taken down where they were published, and the owner's choice to run them anyway: Blockly
 * can't tell an author tidying up from a removal for malware (§15.3), so it asks.
 */
export function RevokedChoice({
  mods,
  checked,
  onChange,
}: {
  mods: string[]
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Note tone="danger">
      <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
        <span>
          {mods.join(', ')} {mods.length === 1 ? 'was' : 'were'} taken down on Modrinth. That can be the
          author tidying up, or a removal for malware.
        </span>
        <Toggle checked={checked} onChange={onChange} label="I trust them. Run them anyway." />
      </div>
    </Note>
  )
}

/** How long the word that a change landed stays where its progress was. */
const LANDED_MS = 4_000
/** What each change that shows its progress says once it has gone through. */
const LANDED: Record<string, string> = {
  apply: 'Your changes are in. Your friends see them now.',
  restore: 'Your backup is back.',
  relocate: 'Your server has moved. The address stays the same.',
}

/**
 * The words that a change this page watched going through has landed, for a moment after it did:
 * the progress panel ends in a word, rather than vanishing as if nothing had happened. Only a
 * change seen in progress here, and only one that finished well; a failure has its own note.
 */
function useLanded(view: ServerView): string | null {
  const watched = useRef<{ id: string; kind: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [landed, setLanded] = useState<string | null>(null)
  const id = view.activeOperation?.id
  const kind = view.activeOperation?.kind
  const changeFailed = view.lastChange?.status === 'failed'
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (id !== undefined && kind !== undefined && kind in LANDED) {
      watched.current = { id, kind }
      return
    }
    const was = watched.current
    if (was === null || id === was.id) return
    watched.current = null
    if (view.status === 'failed' || (was.kind === 'apply' && changeFailed)) return
    clearTimeout(timer.current)
    setLanded(LANDED[was.kind] ?? null)
    timer.current = setTimeout(() => setLanded(null), LANDED_MS)
  }, [id, kind, view.status, changeFailed])
  return landed
}

/** Where the last change is: applying now, waiting for a start, or undone because it didn't start. */
export function ChangeState({ view }: { view: ServerView }) {
  const trpc = useTRPC()
  const now = useNow(1_000)
  const landed = useLanded(view)
  const operation = view.activeOperation
  const shown = operation !== null && ['apply', 'restore', 'relocate'].includes(operation.kind)
  // What the change brings, so its download step can say what it downloads.
  const revisions = useQuery({
    ...trpc.servers.revisions.queryOptions({ serverId: view.id }),
    enabled: operation?.kind === 'apply',
  })
  const changes = revisions.data?.find((revision) => revision.desired)?.changes ?? []
  const progress = operation && shown ? presentProgress(operation, view, changes) : null
  // Within a step the bar creeps on, and only the server moves it to the next, as on a first build.
  const since = useSince(operation?.step ?? null)
  if (operation && progress) {
    const within = 1 - Math.exp(-(now - since) / 10_000)
    return (
      <ProvisioningPanel
        title={progress.title}
        eta={etaLine(operation.startedAt, progress.expectedSeconds, now)}
        progress={Math.min(95, ((progress.index + 0.9 * within) / progress.steps.length) * 100)}
        steps={progress.steps}
        heading="h2"
        live={<BootLine server={view} step={operation.step} kind={operation.kind} />}
      />
    )
  }
  if (view.status === 'failed')
    return (
      <Note tone="danger">
        {presentStatus(view).detail}. {view.failure?.message}
        {view.failure?.during === 'updating' && ' You can go back to a configuration that worked, below.'}
      </Note>
    )
  if (view.status === 'stored' || view.status === 'storing') return <Resting view={view} />
  return (
    <>
      {landed !== null && <Note tone="success">{landed}</Note>}
      {view.pendingRestart && <Note tone="info">Your changes apply the next time the server starts.</Note>}
      {view.lastChange?.status === 'failed' && (
        <Note tone="danger">
          Last change, {timeAgo(view.lastChange.at, now)}: {view.lastChange.error}
        </Note>
      )}
    </>
  )
}

/**
 * A world resting while nobody plays has nothing to change until it is back: one line, and the
 * button that brings it back. Its name, its address and who may join still change as ever.
 */
function Resting({ view }: { view: ServerView }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const wake = useMutation(trpc.servers.start.mutationOptions({ onSuccess: (next) => changed(next) }))
  return (
    <Note tone="info">
      <span>Wake it to change this. Its world comes back in a couple of minutes.</span>
      <div style={{ marginBlockStart: 'var(--space-12)' }}>
        <Button
          variant="secondary"
          size="sm"
          disabled={wake.isPending || view.status === 'storing'}
          onClick={() => wake.mutate({ serverId: view.id, requestId: requestId() })}
        >
          {wake.isPending ? 'Waking it up…' : 'Wake it up'}
        </Button>
      </div>
      {wake.isError && <Note tone="danger">{messageOf(wake.error)}</Note>}
    </Note>
  )
}
