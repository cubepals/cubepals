'use client'

import type { PackImportView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { type DragEvent, useEffect, useState } from 'react'
import { messageOf, useTRPC } from '../../lib/api'
import { putFile } from '../../lib/upload'
import { FileButton, ICON, Note, ProgressBar } from '../../ui'

/** A pack Blockly has read, as the pages that pick one show it. */
export type ReadPack = Extract<PackImportView, { status: 'ready' }>

/**
 * A pack someone has as a file, whatever kind it is: a server pack, a Modrinth pack, a launcher's
 * export or a folder of mods. It goes straight to the store, Blockly reads it while this waits, and
 * what it turned out to be comes back to `onReady`; a file that can't be a server says why in one
 * sentence. Nothing here asks what kind of file it is.
 */
export function PackDrop({
  disabled,
  onReady,
  onStart,
}: {
  disabled?: boolean
  onReady: (pack: ReadPack) => void
  /** A new file was chosen: whatever the last one was is no longer the choice. */
  onStart?: () => void
}) {
  const trpc = useTRPC()
  const begin = useMutation(trpc.packs.beginUpload.mutationOptions())
  const finish = useMutation(trpc.packs.finishUpload.mutationOptions())
  const [sending, setSending] = useState<{ name: string; done: number } | null>(null)
  const [importId, setImportId] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [over, setOver] = useState(false)

  // While Blockly reads the pack, the page asks after it; reading a big server pack takes a while.
  const reading = useQuery({
    ...trpc.packs.import.queryOptions({ importId: importId ?? '' }),
    enabled: importId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'reading' ? 1500 : false),
  })
  const read = reading.data
  // Each pack read is handed over once. The pages pass a new `onReady` on every render, and
  // handing it over again would reopen a question someone just answered or cancelled.
  const [handed, setHanded] = useState<string | null>(null)
  useEffect(() => {
    if (read?.status !== 'ready' || read.importId === handed) return
    setHanded(read.importId)
    onReady(read)
  }, [read, onReady, handed])

  const send = async (file: File) => {
    onStart?.()
    setFailure(null)
    setImportId(null)
    try {
      setSending({ name: file.name, done: 0 })
      const start = await begin.mutateAsync({ fileName: file.name, sizeBytes: file.size })
      await putFile(start.url, start.headers, file, (sent) =>
        setSending({ name: file.name, done: (sent / file.size) * 100 }),
      )
      const { importId } = await finish.mutateAsync({ ticket: start.ticket })
      setImportId(importId)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setSending(null)
    }
  }
  const drop = (event: DragEvent) => {
    event.preventDefault()
    setOver(false)
    const file = event.dataTransfer.files[0]
    if (file && !disabled && sending === null) void send(file)
  }

  const busy = sending !== null || read?.status === 'reading'
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is how a keyboard picks a file */}
      <div
        className="bk-drop"
        data-over={over || undefined}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          Drop the pack’s file here: a server pack, a Modrinth pack, or a launcher’s export.
        </p>
        <FileButton
          accept=".zip,.mrpack,application/zip,application/x-modrinth-modpack+zip"
          icon={<Upload {...ICON} aria-hidden />}
          disabled={disabled || busy}
          onFile={(file) => void send(file)}
        >
          Choose the file
        </FileButton>
      </div>
      {sending !== null && (
        <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
          <span className="type-body-sm">{sending.name}: sending it…</span>
          <ProgressBar value={sending.done} label={`Sending ${sending.name}`} />
        </div>
      )}
      {read?.status === 'reading' && (
        <p className="type-body-sm" role="status">
          Reading {read.fileName}: finding its mods, its Minecraft and what a server needs of it…
        </p>
      )}
      {read?.status === 'refused' && <Note tone="info">{read.message}</Note>}
      {(failure !== null || reading.isError) && (
        <Note tone="danger">{failure ?? messageOf(reading.error)}</Note>
      )}
    </div>
  )
}
