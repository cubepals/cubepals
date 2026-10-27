// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * "Bring a world" on the world page (docs/world-import.md): a world a player already has, handed
 * over as its folder or as a file (`world-drop.tsx`). Sending it and what comes of it is
 * `bring-world.tsx`'s, and playing it is a restore on the backups page.
 */
import type { ServerView } from '@blockly/contracts'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { FormSection } from '../../../../../ui'
import { WorldDrop } from '../../../world-drop'
import { BringWorld } from '../bring-world'

export function BringIn({ view }: { view: ServerView }) {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  return (
    <FormSection
      title="Bring a world"
      description="Play a world you already have: a single-player save, a server’s folder, or a download from another host."
    >
      <WorldDrop onFile={setFile} />
      {file && (
        <BringWorld
          view={view}
          file={file}
          onClose={() => setFile(null)}
          onKept={(backupId) => router.push(`/servers/${view.id}/backups?restore=${backupId}`)}
        />
      )}
    </FormSection>
  )
}
