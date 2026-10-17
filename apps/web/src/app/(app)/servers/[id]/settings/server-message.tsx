// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The server list message, typed as plain text with Minecraft's `&` codes for colour, a small bar
 * under it that writes those codes around the selected words (`style-bar.tsx`), a hint for each
 * code that won't do what it looks like (`message-hints.ts`), and the server as Minecraft's
 * multiplayer list draws it (`list-entry.tsx`). What is typed is what the game reads; the bar only
 * types for you.
 */
import {
  type MotdRun,
  motdCutSentence,
  motdLayout,
  motdRuns,
  motdText,
  type ServerView,
} from '@blockly/contracts'
import { sealProblem } from '@blockly/contracts/seal'
import { type CSSProperties, useId, useLayoutEffect, useRef, useState } from 'react'
import { TextField } from '../../../../../ui'
import { GROUND, ListEntry, scrambled } from './list-entry'
import { pressedCodes, withCode } from './message-codes'
import { messageHints } from './message-hints'
import { StyleBar } from './style-bar'

/**
 * Why a message can't be saved, as the control plane would refuse it (`settingsProblems`): it is
 * kept without the spaces around it, needs some text with no check marks or seals in it, and all
 * of it must show in the list.
 */
export function messageProblem(motd: string): string | null {
  if (motdText(motd).trim() === '') return 'Write something to show under the name.'
  const seal = sealProblem(motd, 'Server messages')
  if (seal !== null) return seal
  const { cutCount } = motdLayout(motd.trim())
  return cutCount > 0 ? motdCutSentence(cutCount) : null
}

export function ServerMessage({
  view,
  value,
  maxPlayers,
  problem,
  onChange,
}: {
  view: ServerView
  value: string
  /** For the player count beside it, as the list shows it. */
  maxPlayers: number
  /** Why it can't be saved: what the list would cut. */
  problem: string | null
  onChange: (motd: string) => void
}) {
  const field = useId()
  const input = useRef<HTMLInputElement>(null)
  const [selection, setSelection] = useState({ start: value.length, end: value.length })
  // Where the selection goes once the message the bar wrote is in the field.
  const placed = useRef<{ start: number; end: number } | null>(null)
  useLayoutEffect(() => {
    const at = placed.current
    if (at === null || input.current === null) return
    placed.current = null
    input.current.focus()
    input.current.setSelectionRange(at.start, at.end)
  })
  const start = Math.min(selection.start, value.length)
  const end = Math.min(selection.end, value.length)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <TextField
        ref={input}
        id={field}
        label="Server message"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onSelect={(event) =>
          setSelection({
            start: event.currentTarget.selectionStart ?? 0,
            end: event.currentTarget.selectionEnd ?? 0,
          })
        }
        error={problem}
        help="Shown under the name in your friends’ server list, from the server’s next start. Select some words and pick a colour or style, or type & codes like &6 for gold."
      />
      <StyleBar
        field={field}
        pressed={pressedCodes(value, start, end)}
        onCode={(code) => {
          const next = withCode(value, start, end, code)
          placed.current = { start: next.start, end: next.end }
          setSelection(placed.current)
          onChange(next.motd)
        }}
      />
      {messageHints(value).map((hint) => (
        <p key={hint} className="bk-field__help" style={{ margin: 0 }}>
          {hint}
        </p>
      ))}
      <figure style={{ margin: 0 }}>
        {/* The server keeps the message without the spaces around it, so the list never shows them. */}
        <ListEntry view={view} motd={value.trim()} maxPlayers={maxPlayers} />
        <figcaption className="bk-field__help" style={{ marginTop: 'var(--space-4)' }}>
          How it shows in Minecraft’s server list.
        </figcaption>
      </figure>
    </div>
  )
}

/**
 * A message as the list draws it, for where a page shows one as words: on the list's own dark
 * ground, in the game's colours, never as its codes.
 */
export function StyledMessage({ motd }: { motd: string }) {
  return (
    <span style={{ ...GAME_TEXT, display: 'inline', padding: '0 var(--space-4)', background: GROUND }}>
      <Runs motd={motd} />
    </span>
  )
}

/** The product's monospace stands in for the game's font, which only the landing page loads. */
const GAME_TEXT: CSSProperties = {
  fontFamily: 'var(--font-pixel, var(--font-plex-mono)), ui-monospace, monospace',
  fontSize: '15px',
  lineHeight: 1.2,
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
}

function Runs({ motd }: { motd: string }) {
  return motdRuns(motd).map((run, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the runs are the message in order, told apart by place
    <span key={i} style={runStyle(run)}>
      {run.styles.includes('obfuscated') ? scrambled(run.text) : run.text}
    </span>
  ))
}

function runStyle(run: MotdRun): CSSProperties {
  const lines = [
    run.styles.includes('underlined') ? 'underline' : '',
    run.styles.includes('strikethrough') ? 'line-through' : '',
  ].filter(Boolean)
  return {
    color: run.colour,
    fontWeight: run.styles.includes('bold') ? 700 : 400,
    fontStyle: run.styles.includes('italic') ? 'italic' : 'normal',
    textDecoration: lines.length > 0 ? lines.join(' ') : 'none',
  }
}
