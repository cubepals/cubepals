// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The owner's own datapacks: a zip dropped here goes the way a jar does (`own-uploads.tsx`), is
 * checked as a datapack for this server's Minecraft, and is then offered as a change like a
 * Modrinth datapack. On a plan without datapacks, the plan that has them is offered instead.
 */

import type { ModChangeInput, ModsView, ServerView } from '@blockly/contracts'
import { Upload } from 'lucide-react'
import { type DragEvent, useState } from 'react'
import { FileButton, FormSection, ICON, Note } from '../../../../../ui'
import { PlusOffer } from '../../../plus-offer'
import { changeable } from '../settings/shared'
import { UploadRow, useOwnUploads } from './own-uploads'

export function OwnDatapacks({
  view,
  list,
  onChange,
}: {
  view: ServerView
  list: ModsView
  onChange: (pending: { title: string; change: Omit<ModChangeInput, 'serverId'> }) => void
}) {
  const [over, setOver] = useState(false)
  const own = useOwnUploads(view, 'datapack', (done) =>
    onChange({ title: `Add ${done.fileName}?`, change: { addUploads: [done.uploadId] } }),
  )
  const allowed = changeable(view)
  const installed = new Set(list.mods.map((m) => m.id))
  const available = list.datapackUploads
  const open = available.available && allowed.ok && own.sending === null
  const drop = (event: DragEvent) => {
    event.preventDefault()
    setOver(false)
    const file = event.dataTransfer.files[0]
    if (file && open) void own.send(file)
  }

  if (!available.available && available.code === 'deployment_unsupported') return null
  return (
    <FormSection
      title="Your own datapacks"
      description="A datapack you made, as its .zip. Cubepals checks it’s a datapack for this server’s Minecraft before anything changes."
    >
      {!available.available &&
        (available.code === 'not_entitled' ? (
          <PlusOffer why="Datapacks come with Plus." reason="mods" />
        ) : (
          <Note tone="info">{available.message}</Note>
        ))}
      {available.available && (
        // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is how a keyboard picks a file
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
            Drop your datapack’s .zip here.
          </p>
          <FileButton
            accept=".zip,application/zip"
            icon={<Upload {...ICON} aria-hidden />}
            disabled={!open}
            onFile={(file) => void own.send(file)}
          >
            Choose the file
          </FileButton>
        </div>
      )}
      {own.status}
      {own.uploads?.map((upload) => (
        <UploadRow
          key={upload.id}
          upload={upload}
          added={installed.has(`upload:${upload.id}`)}
          allowed={allowed.ok}
          misfit="For another Minecraft"
          deleting={own.remove.isPending}
          onDelete={() => own.remove.mutate({ serverId: view.id, uploadId: upload.id })}
          onAdd={() => onChange({ title: `Add ${upload.fileName}?`, change: { addUploads: [upload.id] } })}
        />
      ))}
    </FormSection>
  )
}
