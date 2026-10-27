// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The world that came inside a pack its owner dropped (docs/world-import.md § Mods and plugins):
 * a launcher's saves or a server's world, read from the same upload while the page waits. Once it
 * is ready, the server made from the pack starts on it, which `onWorld` hands the page; what only
 * its owner knows is asked here (`world-questions.tsx`), and they can start on a new world instead.
 */
import { useEffect, useRef, useState } from 'react'
import { messageOf } from '../../../../lib/api'
import { Button, Note } from '../../../../ui'
import { BroughtNotes, WorldQuestions } from '../../world-questions'
import { useNewWorld } from './world/own-world'

export function PackWorld({
  importId,
  onWorld,
}: {
  /** The world's own import, as the pack's says it. */
  importId: string
  /** The world the server starts on: this one once it is ready, or null for a new one. */
  onWorld: (importId: string | null) => void
}) {
  const { watched, answer } = useNewWorld(importId)
  const read = watched.data
  const [fresh, setFresh] = useState(false)
  const ready = read?.status === 'ready'
  // Handed once each time the choice changes, whatever the page passes as `onWorld` each render.
  const handTo = useRef(onWorld)
  handTo.current = onWorld
  useEffect(() => {
    if (ready) handTo.current(fresh ? null : importId)
  }, [ready, fresh, importId])

  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      {read?.status === 'reading' && (
        <p className="type-body-sm" role="status">
          It came with a world. Reading it: its Minecraft, its seed and its players…
        </p>
      )}
      {read?.status === 'asking' && (
        <WorldQuestions
          asks={read}
          answering={answer.isPending}
          failure={answer.isError ? messageOf(answer.error) : null}
          onAnswer={(given) => answer.mutate({ importId: read.importId, ...given })}
        />
      )}
      {read?.status === 'ready' && (
        <>
          <p className="type-body-sm">
            {fresh
              ? 'The server starts on a new world.'
              : `The server starts on its world, ${read.world.name}, from Minecraft ${read.world.gameVersion}.`}
          </p>
          {!fresh && <BroughtNotes notes={read.notes} />}
          <div>
            <Button variant="ghost" size="sm" onClick={() => setFresh(!fresh)}>
              {fresh ? `Start on ${read.world.name} instead` : 'Start on a new world instead'}
            </Button>
          </div>
        </>
      )}
      {read?.status === 'refused' && (
        <Note tone="info">
          It came with a world Cubepals can’t open: {read.message} The server starts on a new one.
        </Note>
      )}
      {watched.isError && <Note tone="danger">{messageOf(watched.error)}</Note>}
    </div>
  )
}
