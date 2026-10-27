// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { PackImportView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { type DragEvent, useState } from 'react'
import { messageOf, useTRPC } from '../../lib/api'
import { useHandedOnce, useSentImport } from '../../lib/sent-import'
import { FileButton, ICON, Note, ProgressBar } from '../../ui'
import { PackWorld } from './servers/new/pack-world'

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
  keepsWorld,
  onReady,
  onStart,
}: {
  disabled?: boolean
  /**
   * For a server that keeps its own world: a world that came inside the pack isn't offered.
   * Otherwise it is read too, for the new server to start on (`pack-world.tsx`), and handed with
   * the pack once it is ready, or null for a new world.
   */
  keepsWorld?: boolean
  onReady: (pack: ReadPack, world?: string | null) => void
  /** A new file was chosen: whatever the last one was is no longer the choice. */
  onStart?: () => void
}) {
  const trpc = useTRPC()
  const begin = useMutation(trpc.packs.beginUpload.mutationOptions())
  const finish = useMutation(trpc.packs.finishUpload.mutationOptions())
  const {
    progress: sending,
    importId,
    failure,
    send,
  } = useSentImport(
    {
      begin: (file) => begin.mutateAsync(file),
      finish: (ticket) => finish.mutateAsync({ ticket, world: !keepsWorld }),
    },
    onStart,
  )
  const [over, setOver] = useState(false)

  // While Blockly reads the pack, the page asks after it; reading a big server pack takes a while.
  const reading = useQuery({
    ...trpc.packs.import.queryOptions({ importId: importId ?? '' }),
    enabled: importId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'reading' ? 1500 : false),
  })
  const read = reading.data
  // A pack that came with a world is handed with it, once the world is read (`PackWorld`): handed
  // alone first, Create would make a server on a new world while the page says it starts on its own.
  const withWorld = !keepsWorld && read?.status === 'ready' && read.worldImportId !== null
  useHandedOnce(withWorld ? undefined : read, onReady)

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
      {!keepsWorld && read?.status === 'ready' && read.worldImportId !== null && (
        <PackWorld importId={read.worldImportId} onWorld={(world) => onReady(read, world)} />
      )}
      {read?.status === 'refused' && <Note tone="info">{read.message}</Note>}
      {(failure !== null || reading.isError) && (
        <Note tone="danger">{failure ?? messageOf(reading.error)}</Note>
      )}
    </div>
  )
}
