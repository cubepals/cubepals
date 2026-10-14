// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The small bar under the server message: Minecraft's sixteen colours and its four text styles,
 * and reset. Each press writes the same `&` code a person could type (`message-codes.ts`); the
 * bar holds no state of its own beyond showing what the selection already has.
 */
import { MOTD_COLOURS } from '@blockly/contracts'
import { Bold, Italic, RemoveFormatting, Strikethrough, Underline } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './style-bar.module.css'

/** The game's names for its colours, in the game's order, as a player would say them. */
const COLOUR_NAMES: Record<string, string> = {
  '0': 'Black',
  '1': 'Dark blue',
  '2': 'Dark green',
  '3': 'Dark aqua',
  '4': 'Dark red',
  '5': 'Dark purple',
  '6': 'Gold',
  '7': 'Grey',
  '8': 'Dark grey',
  '9': 'Blue',
  a: 'Green',
  b: 'Aqua',
  c: 'Red',
  d: 'Light purple',
  e: 'Yellow',
  f: 'White',
}

const STYLES: Array<{ code: string; name: string; icon: ReactNode }> = [
  { code: 'l', name: 'Bold', icon: <Bold size={16} strokeWidth={2.25} aria-hidden /> },
  { code: 'o', name: 'Italic', icon: <Italic size={16} strokeWidth={2.25} aria-hidden /> },
  { code: 'n', name: 'Underline', icon: <Underline size={16} strokeWidth={2.25} aria-hidden /> },
  { code: 'm', name: 'Strikethrough', icon: <Strikethrough size={16} strokeWidth={2.25} aria-hidden /> },
]

export function StyleBar({
  field,
  pressed,
  onCode,
}: {
  /** The input the bar writes into. */
  field: string
  /** The codes the whole selection already has. */
  pressed: string[]
  onCode: (code: string) => void
}) {
  // Pressing with a pointer leaves the selection and the caret in the field, where they were.
  const keep = (event: { preventDefault: () => void }) => event.preventDefault()
  return (
    <fieldset className={styles.bar} aria-controls={field}>
      <legend className="bk-visually-hidden">Colour and style</legend>
      <div className={styles.colours}>
        {Object.entries(MOTD_COLOURS).map(([code, colour]) => (
          <button
            key={code}
            type="button"
            className={styles.swatch}
            style={{ background: colour }}
            aria-label={COLOUR_NAMES[code]}
            title={COLOUR_NAMES[code]}
            aria-pressed={pressed.includes(code)}
            onMouseDown={keep}
            onClick={() => onCode(code)}
          />
        ))}
      </div>
      <div className={styles.styles}>
        {STYLES.map((style) => (
          <button
            key={style.code}
            type="button"
            className={styles.toggle}
            aria-label={style.name}
            title={style.name}
            aria-pressed={pressed.includes(style.code)}
            onMouseDown={keep}
            onClick={() => onCode(style.code)}
          >
            {style.icon}
          </button>
        ))}
        <button
          type="button"
          className={styles.toggle}
          aria-label="Reset"
          title="Reset"
          onMouseDown={keep}
          onClick={() => onCode('r')}
        >
          <RemoveFormatting size={16} strokeWidth={2.25} aria-hidden />
        </button>
      </div>
    </fieldset>
  )
}
