// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * "Your own world", opened from the create page (docs/world-import.md): the world handed over and
 * read (`own-world.tsx`), what Cubepals found in it, and back to the create page with it chosen
 * (`kept.ts`), where the server is made to fit it. Who plays and the name are asked there, as for
 * any way to play.
 */
import { ArrowLeft } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { iconSrc } from '../../../../../lib/present'
import { Button } from '../../../../../ui'
import styles from '../create.module.css'
import { keptPath } from '../kept'
import { Thumb } from '../thumb'
import { OwnWorld, type ReadWorld } from './own-world'

export default function OwnWorldPage() {
  const router = useRouter()
  const [read, setRead] = useState<ReadWorld | null>(null)
  const { world } = read ?? {}
  return (
    <div className={styles.page}>
      <div>
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft size={16} strokeWidth={1.75} aria-hidden />}
          onClick={() => router.push('/servers/new')}
        >
          Other ways to play
        </Button>
      </div>
      <h1 className={`type-display-md bk-enter ${styles.title}`}>Your own world</h1>
      <p className="type-body">
        Bring a world you already have: a single-player save, a server’s folder, or a download from another
        host. Cubepals finds the world in it and makes a server to fit it, on the same Minecraft, game mode
        and difficulty.
      </p>
      <OwnWorld onStart={() => setRead(null)} onReady={setRead} />
      {read !== null && world !== undefined && (
        <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
          <div className={styles.row} data-picked>
            <Thumb picture={{ src: iconSrc('grass') }} state="picked" />
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{world.name}</span>
              <span className={styles.rowBlurb}>
                {world.playsOn === world.gameVersion
                  ? `Minecraft ${world.playsOn}`
                  : `Minecraft ${world.playsOn}, last played on ${world.gameVersion}`}
              </span>
            </span>
          </div>
          <div>
            <Button
              variant="primary"
              onClick={() => router.push(keptPath({ kind: 'world', importId: read.importId }, null, null))}
            >
              Make a server with it
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
