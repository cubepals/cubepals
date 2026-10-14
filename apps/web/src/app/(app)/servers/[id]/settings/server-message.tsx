// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The server list message, typed as plain text with Minecraft's `&` codes for colour, a small bar
 * under it that writes those codes around the selected words (`style-bar.tsx`), and beside it the
 * server as Minecraft's multiplayer list draws it: its icon, its name, and the message on up to
 * two lines. What is typed is what the game reads; the bar only types for you.
 */
import { type MotdRun, motdRuns, motdText, type ServerView } from '@blockly/contracts'
import Image from 'next/image'
import { type CSSProperties, useId, useLayoutEffect, useRef, useState } from 'react'
import { iconSrc } from '../../../../../lib/present'
import { TextField } from '../../../../../ui'
import { pressedCodes, withCode } from './message-codes'
import { StyleBar } from './style-bar'

export function ServerMessage({
  view,
  value,
  limit,
  problem,
  onChange,
}: {
  view: ServerView
  value: string
  limit: number
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
  const left = Math.max(0, limit - motdText(value).length)
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
        help={`Shown under the name in your friends’ server list, from the server’s next start. Select some words and pick a colour or style, or type & codes like &6 for gold. ${left} characters left.`}
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
      <ListEntry view={view} motd={value} />
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

/** The game's own list is dark whatever the page's theme, and its text is the game's colours. */
const GROUND = '#1b1b1b'

/** The product's monospace stands in for the game's font, which only the landing page loads. */
const GAME_TEXT: CSSProperties = {
  fontFamily: 'var(--font-pixel, var(--font-plex-mono)), ui-monospace, monospace',
  fontSize: '15px',
  lineHeight: 1.2,
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
}

const ENTRY: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '32px minmax(0, 1fr)',
  gap: 'var(--space-8)',
  alignItems: 'start',
  maxWidth: '100%',
  width: 'fit-content',
  padding: 'var(--space-8)',
  borderRadius: 'var(--radius-8)',
  background: GROUND,
  ...GAME_TEXT,
}

/** Two lines of the list's width: about as many characters as the game fits in one. */
const LINES: CSSProperties = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  width: '45ch',
  maxWidth: '100%',
}

function ListEntry({ view, motd }: { view: ServerView; motd: string }) {
  return (
    <figure style={{ margin: 0 }}>
      <div style={ENTRY}>
        <Image
          src={iconSrc(view.icon, view.ownIcon)}
          alt=""
          width={32}
          height={32}
          unoptimized
          style={{ imageRendering: 'pixelated' }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#FFFFFF' }}>{view.name}</div>
          <div style={LINES}>
            <Runs motd={motd} />
          </div>
        </div>
      </div>
      <figcaption className="bk-field__help" style={{ marginTop: 'var(--space-4)' }}>
        How it shows in Minecraft’s server list.
      </figcaption>
    </figure>
  )
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

/** The game draws obfuscated text as ever-changing letters; the preview shows some, still. */
const SCRAMBLE = 'Ξ#%&@?§¥ÆØ'
const scrambled = (text: string) =>
  [...text].map((c, i) => (c === ' ' ? c : (SCRAMBLE[(c.charCodeAt(0) + i) % SCRAMBLE.length] ?? c))).join('')
