// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The server list message, typed as plain text with Minecraft's `&` codes for colour, and beside
 * it the server as Minecraft's multiplayer list draws it: its icon, its name, and the message on
 * up to two lines. No pickers: what is typed is what the game reads.
 */
import { type MotdRun, motdRuns, motdText, type ServerView } from '@blockly/contracts'
import Image from 'next/image'
import type { CSSProperties } from 'react'
import { iconSrc } from '../../../../../lib/present'
import { TextField } from '../../../../../ui'

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
  const left = Math.max(0, limit - motdText(value).length)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <TextField
        label="Server message"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        error={problem}
        help={`Shown under the name in your friends’ server list, from the server’s next start. Add colour with & and a code: &6 for gold, &l for bold. ${left} characters left.`}
      />
      <ListEntry view={view} motd={value} />
    </div>
  )
}

/** The game's own list is dark whatever the page's theme, and its text is the game's colours. */
const ENTRY: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '32px minmax(0, 1fr)',
  gap: 'var(--space-8)',
  alignItems: 'start',
  maxWidth: '100%',
  width: 'fit-content',
  padding: 'var(--space-8)',
  borderRadius: 'var(--radius-8)',
  background: '#1b1b1b',
  // The product's monospace stands in for the game's font, which only the landing page loads.
  fontFamily: 'var(--font-pixel, var(--font-plex-mono)), ui-monospace, monospace',
  fontSize: '15px',
  lineHeight: 1.2,
}

/** Two lines of the list's width: about as many characters as the game fits in one. */
const LINES: CSSProperties = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  width: '45ch',
  maxWidth: '100%',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
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
            {motdRuns(motd).map((run, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the runs are the message in order, told apart by place
              <span key={i} style={runStyle(run)}>
                {run.styles.includes('obfuscated') ? scrambled(run.text) : run.text}
              </span>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="bk-field__help" style={{ marginTop: 'var(--space-4)' }}>
        How it shows in Minecraft’s server list.
      </figcaption>
    </figure>
  )
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
