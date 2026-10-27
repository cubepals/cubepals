// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The world that came inside a pack its owner dropped (docs/world-import.md § Mods and plugins):
 * a launcher's saves or a server's world, read from the same upload while the page waits. Once it
 * is read, or can't be, `onWorld` hands the page the pack and its world together, and the server
 * made from the pack starts on it; what only its owner knows is asked here (`world-questions.tsx`),
 * with who of its players come along (`world-people.tsx`), and they can start on a new world
 * instead.
 */
import { useEffect, useRef, useState } from 'react'
import { messageOf } from '../../../../lib/api'
import { Button, Note } from '../../../../ui'
import { WorldPeopleChoice } from '../../world-people'
import { BroughtNotes, WorldQuestions } from '../../world-questions'
import { useChosenPeople, useNewWorld } from './world/own-world'

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
  const people = useChosenPeople(read)
  // Handed once, as soon as the world is read or can't be, whatever the page passes as `onWorld`
  // each render; after that only when its owner says, so a late answer never undoes their pick.
  const handTo = useRef(onWorld)
  handTo.current = onWorld
  const handed = useRef(false)
  const settled =
    read?.status === 'ready' ? importId : read?.status === 'refused' || watched.isError ? null : undefined
  useEffect(() => {
    if (settled === undefined || handed.current) return
    handed.current = true
    handTo.current(settled)
  }, [settled])
  const toggle = () => {
    setFresh(!fresh)
    handTo.current(fresh ? importId : null)
  }

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
          {!fresh && people !== null && (
            <WorldPeopleChoice people={people.people} choice={people.choice} onChange={people.change} />
          )}
          {!fresh && people !== null && people.failure !== null && (
            <Note tone="danger">{people.failure}</Note>
          )}
          <div>
            <Button variant="ghost" size="sm" onClick={toggle}>
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
