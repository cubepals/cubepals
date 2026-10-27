// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What a world being brought asks its player, where only they know (docs/world-import.md): which
 * world, when the file holds several, and which Minecraft account played a single-player one.
 * Sending the answer is the page's, to a server's import or a new server's; so is what follows.
 */
import type { WorldImportView } from '@blockly/contracts'
import { useState } from 'react'
import { Button, Note, Select, TextField } from '../../ui'

/** What a world asks, as both kinds of import ask it. */
export type WorldAsks = Pick<Extract<WorldImportView, { status: 'asking' }>, 'worlds' | 'player' | 'problem'>

/** An answer: the world's folder, or the account that played it, null for none. */
export type WorldAnswer = { folder?: string; player?: string | null }

export function WorldQuestions({
  asks,
  answering,
  failure,
  onAnswer,
}: {
  asks: WorldAsks
  /** The answer is on its way. */
  answering: boolean
  failure: string | null
  onAnswer: (answer: WorldAnswer) => void
}) {
  const [folder, setFolder] = useState(asks.worlds?.[0]?.folder ?? '')
  const [player, setPlayer] = useState('')
  const busy = answering ? 'Bringing it' : undefined
  if (asks.worlds !== null)
    return (
      <form
        className="bk-stack"
        style={{ gap: 'var(--space-12)' }}
        onSubmit={(event) => {
          event.preventDefault()
          onAnswer({ folder })
        }}
      >
        <p>This file holds more than one world. Which one do you want?</p>
        <Select
          label="World"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          options={asks.worlds.map((world) => ({
            value: world.folder,
            label: [
              world.name,
              world.gameVersion && `Minecraft ${world.gameVersion}`,
              world.folder.slice(0, -1),
            ]
              .filter(Boolean)
              .join(' · '),
          }))}
        />
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Bring this one
          </Button>
        </div>
        {failure && <Note tone="danger">{failure}</Note>}
      </form>
    )
  return (
    <form
      className="bk-stack"
      style={{ gap: 'var(--space-12)' }}
      onSubmit={(event) => {
        event.preventDefault()
        if (player.trim()) onAnswer({ player: player.trim() })
      }}
    >
      <p>
        This is a single-player world. Who played it? What they carried and where they stood go to that
        Minecraft account on the server.
      </p>
      <TextField
        label="Minecraft name"
        maxLength={32}
        autoComplete="off"
        value={player}
        onChange={(event) => setPlayer(event.target.value)}
        {...(asks.problem ? { error: asks.problem } : {})}
      />
      <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
        <Button type="submit" variant="primary" disabled={!player.trim()} busy={busy}>
          Continue
        </Button>
        <Button variant="ghost" disabled={answering} onClick={() => onAnswer({ player: null })}>
          Nobody, just the world
        </Button>
      </div>
      {failure && <Note tone="danger">{failure}</Note>}
    </form>
  )
}

/** What Cubepals did to bring a world, in the player's words. */
export function BroughtNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null
  return (
    <ul className="type-body-sm" style={{ color: 'var(--ink-muted)', paddingLeft: 'var(--space-16)' }}>
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  )
}
