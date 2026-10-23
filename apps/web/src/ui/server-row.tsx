// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * A server as Minecraft's multiplayer list shows it, drawn in the landing's print rather than the
 * game's exact pixels: its picture, its name, a two-line message, the signal bars and how many are
 * on. The plan cards open with one. Set it on ink (`.bl-print` with `--fg` paper). Not the server
 * settings' own preview, which draws the game's list to the pixel (`list-entry.tsx`).
 */
import type { ReactNode } from 'react'
import styles from './server-row.module.css'

export function ServerRow({
  picture,
  name,
  message,
  players,
}: {
  /** The server's picture, drawn square at the row's height. */
  picture: ReactNode
  name: string
  /** The message's first line, lit, and the line under it, quieter. */
  message: readonly [string, string?]
  /** On now, and the most it holds: "0/5". */
  players: { on: number; max: number }
}) {
  const [lead, rest] = message
  return (
    <div className={styles.row}>
      <div className={styles.picture}>{picture}</div>
      <p className={`bl-game ${styles.name}`}>{name}</p>
      <div className={styles.signal}>
        <span className={styles.bars} aria-hidden>
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className={`bl-game ${styles.players}`}>
          {players.on}/{players.max}
        </span>
      </div>
      <p className={`bl-game ${styles.message}`}>
        <span className={styles.lead}>{lead}</span>
        {rest && <span className={styles.rest}>{rest}</span>}
      </p>
    </div>
  )
}
