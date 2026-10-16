// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The one way an owner's own file reaches a server, for jars and datapacks alike: fingerprinted in
 * the browser, sent straight to the store, checked by the control plane, then offered as a change
 * like anything else. The sections that list each kind are in `page.tsx` and `own-datapacks.tsx`.
 */

import type { ModUploadView, ServerView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { bytes } from '../../../../../lib/present'
import { putFile, sha512Of } from '../../../../../lib/upload'
import { Badge, Button, FormRow, ICON, Note, ProgressBar } from '../../../../../ui'

/** A file that passed, and the upload it became. */
interface Uploaded {
  uploadId: string
  fileName: string
}

/** Sending one file, with where it has got to, and the owner's uploads of one kind. */
export function useOwnUploads(
  view: ServerView,
  kind: ModUploadView['kind'],
  onUploaded: (done: Uploaded) => void,
) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  // A jar is read for malware after it arrives; the list is asked again until that's done.
  const uploads = useQuery(
    trpc.mods.uploads.queryOptions(
      { serverId: view.id },
      { refetchInterval: (query) => (query.state.data?.some((u) => u.checking) ? 2000 : false) },
    ),
  )
  const begin = useMutation(trpc.mods.beginUpload.mutationOptions())
  const finish = useMutation(trpc.mods.finishUpload.mutationOptions())
  const refresh = () =>
    queries.invalidateQueries({ queryKey: trpc.mods.uploads.queryKey({ serverId: view.id }) })
  const remove = useMutation(trpc.mods.deleteUpload.mutationOptions({ onSuccess: refresh }))
  const [sending, setSending] = useState<{ name: string; stage: string; done: number } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // The upload just sent, offered once Cubepals has checked it.
  const [waiting, setWaiting] = useState<Uploaded | null>(null)

  const send = async (file: File) => {
    setFailure(null)
    try {
      setSending({ name: file.name, stage: 'Reading the file…', done: 0 })
      const sha512 = await sha512Of(file)
      const start = await begin.mutateAsync({
        serverId: view.id,
        fileName: file.name,
        sizeBytes: file.size,
        sha512,
      })
      let done: Uploaded
      if (start.kind === 'upload') {
        await putFile(start.url, start.headers, file, (sent) =>
          setSending({ name: file.name, stage: 'Uploading…', done: (sent / file.size) * 100 }),
        )
        setSending({ name: file.name, stage: 'Checking it…', done: 100 })
        const finished = await finish.mutateAsync({ serverId: view.id, ticket: start.ticket })
        done = { uploadId: finished.uploadId, fileName: file.name }
      } else done = { uploadId: start.uploadId, fileName: file.name }
      await refresh()
      setWaiting(done)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setSending(null)
    }
  }

  useEffect(() => {
    const sent = waiting === null ? undefined : uploads.data?.find((u) => u.id === waiting.uploadId)
    if (waiting === null || sent === undefined || sent.checking) return
    setWaiting(null)
    if (sent.refusal !== null) setFailure(sent.refusal)
    else onUploaded(waiting)
  }, [waiting, uploads.data, onUploaded])

  return {
    send,
    sending,
    remove,
    /** The owner's uploads of this kind, newest first. */
    uploads: uploads.data?.filter((upload) => upload.kind === kind),
    /** How far a file has got, and why sending, listing or deleting didn't work, where one didn't. */
    status: (
      <>
        {sending && (
          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <span className="type-body-sm">
              {sending.name}: {sending.stage}
            </span>
            <ProgressBar value={sending.done} label={`Uploading ${sending.name}`} />
          </div>
        )}
        {waiting && <span className="type-body-sm">{waiting.fileName}: Checking…</span>}
        {failure && <Note tone="danger">{failure}</Note>}
        {remove.isError && <Note tone="danger">{messageOf(remove.error)}</Note>}
        {uploads.isError && <Note tone="danger">{messageOf(uploads.error)}</Note>}
      </>
    ),
  }
}

/** One upload: what it is, whether it fits this server, and adding or deleting it. */
export function UploadRow({
  upload,
  added,
  allowed,
  misfit,
  onAdd,
  onDelete,
  deleting,
}: {
  upload: ModUploadView
  added: boolean
  allowed: boolean
  /** What the badge says when it doesn't fit this server as it is. */
  misfit: string
  onAdd: () => void
  onDelete: () => void
  deleting: boolean
}) {
  return (
    <FormRow
      label={
        <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          {upload.name}
          <span className="type-mono-sm" style={{ color: 'var(--ink-muted)' }}>
            {upload.version}
          </span>
          {!upload.fits && <Badge tone="outline">{misfit}</Badge>}
          {upload.checking && <Badge tone="neutral">Checking…</Badge>}
        </span>
      }
      description={
        upload.refusal !== null && !upload.checking
          ? upload.refusal
          : [upload.fileName, bytes(upload.sizeBytes), upload.note].filter(Boolean).join(' · ')
      }
      control={
        <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
          {!upload.inUse && (
            <Button variant="ghost" size="sm" disabled={deleting} onClick={onDelete}>
              Delete
            </Button>
          )}
          {added ? (
            <Badge tone="grass">Added</Badge>
          ) : (
            <Button
              variant="outline"
              size="sm"
              icon={<Plus {...ICON} aria-hidden />}
              disabled={!allowed || !upload.fits || upload.refusal !== null}
              onClick={onAdd}
            >
              Add
            </Button>
          )}
        </div>
      }
    />
  )
}
