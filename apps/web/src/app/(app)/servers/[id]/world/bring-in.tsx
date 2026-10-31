// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * "Bring a world" on the world page (docs/world-import.md): a world a player already has, handed
 * over as its folder, a launcher's instance among them, or as a file (`world-drop.tsx`). Sending
 * it, reading it and playing it are `bring-world.tsx`'s.
 */
import type { ServerView } from '@blockly/contracts'
import { useState } from 'react'
import { type Brought, broughtFrom } from '../../../../../lib/brought-files'
import { FormSection } from '../../../../../ui'
import { WorldDrop } from '../../../world-drop'
import { BringWorld } from '../bring-world'

export function BringIn({ view }: { view: ServerView }) {
  const [brought, setBrought] = useState<Brought | null>(null)
  return (
    <FormSection
      title="Bring a world"
      description="Play a world you already have: a single-player save, a server’s folder, or a download from another host."
    >
      <WorldDrop
        onFile={(file) => setBrought({ kind: 'file', file })}
        onFolder={(files) => setBrought(broughtFrom(files))}
      />
      {brought && <BringWorld view={view} brought={brought} onClose={() => setBrought(null)} />}
    </FormSection>
  )
}
