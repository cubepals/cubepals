// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The pack a world was played with, asked for where the world says it was played with mods
 * (docs/world-import.md § Mods and plugins): found by name as any pack is (`modpacks.tsx`), or
 * dropped as a file (`pack-drop.tsx`). Plain Minecraft would lose the world's modded blocks and
 * items, so its server is made from the pack, and only what it is comes back to `onPack`.
 */
import type { ModpackHit, PackSourceInput } from '@blockly/contracts'
import { useState } from 'react'
import { PackDrop } from '../../../pack-drop'
import { Modpacks } from '../modpacks'

/** The server types a world was opened with, as a person says them. */
const LOADER_NAMES: Record<string, string> = {
  forge: 'Forge',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
  quilt: 'Quilt',
}

export function PlayedWith({
  moddedWith,
  onPack,
}: {
  /** The modded server types that opened it; empty where only mods beside it said so. */
  moddedWith: string[]
  onPack: (pack: { source: PackSourceInput; name: string } | null) => void
}) {
  const [file, setFile] = useState(false)
  const [picked, setPicked] = useState<{ hit: ModpackHit; versionId: string | null } | null>(null)
  const loaders = moddedWith.map((brand) => LOADER_NAMES[brand] ?? brand)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      <p className="type-body">
        {loaders.length > 0
          ? `It was played with ${loaders.join(' and ')} mods. `
          : 'It was played with mods. '}
        Plain Minecraft would lose their blocks and items, so its server is made from the pack it was played
        with. Find the pack, or drop its file.
      </p>
      {file ? (
        <PackDrop
          onStart={() => onPack(null)}
          onReady={(read) =>
            onPack({ source: { kind: 'import', importId: read.importId }, name: read.pack.name })
          }
        />
      ) : (
        <Modpacks
          picked={picked?.hit.projectId ?? null}
          pickedVersion={picked?.versionId ?? null}
          checking={null}
          refused={null}
          offer={null}
          disabled={false}
          onPick={(hit, versionId) => {
            setPicked({ hit, versionId: versionId ?? null })
            onPack({
              source: {
                kind: 'modpack',
                projectId: hit.projectId,
                ...(versionId === undefined ? {} : { versionId }),
              },
              name: hit.name,
            })
          }}
          onHaveFile={() => {
            setPicked(null)
            onPack(null)
            setFile(true)
          }}
        />
      )}
    </div>
  )
}
