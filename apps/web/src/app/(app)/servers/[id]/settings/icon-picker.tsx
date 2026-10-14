// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The Icon field of a server's name and address: Blockly's pictures to pick from, and the owner's
 * own, which the page crops and shrinks itself. It is saved with the rest of the form, so this
 * only says what changed; the form sends it.
 */
import { SERVER_ICONS, type ServerIcon, type ServerView } from '@blockly/contracts'
import { ImagePlus } from 'lucide-react'
import Image from 'next/image'
import { type ChangeEvent, useRef, useState } from 'react'
import { type OwnIconPicked, squareIcon } from '../../../../../lib/own-icon'
import { iconSrc } from '../../../../../lib/present'

/** The owner's own picture: one already saved (no bytes to send) or one just chosen. */
type Own = { src: string; base64: string | null }

export interface IconChoice {
  icon: ServerIcon | null
  own: Own | null
  usingOwn: boolean
  /** What a save sends, beside the name and description. */
  input: { icon: ServerIcon | null; picture?: string | null }
  dirty: boolean
  pick(icon: ServerIcon | null): void
  takeOwn(picked?: OwnIconPicked): void
}

export function useIconChoice(view: ServerView): IconChoice {
  const [icon, setIcon] = useState<ServerIcon | null>(view.icon)
  const [own, setOwn] = useState<Own | null>(
    view.ownIcon === null ? null : { src: view.ownIcon, base64: null },
  )
  const [usingOwn, setUsingOwn] = useState(view.ownIcon !== null)
  const hadOwn = view.ownIcon !== null
  // A new picture is sent; one already saved isn't; leaving one for a picked icon takes it away.
  const picture = usingOwn ? (own?.base64 ?? undefined) : hadOwn ? null : undefined
  return {
    icon,
    own,
    usingOwn,
    input: { icon, ...(picture === undefined ? {} : { picture }) },
    dirty: icon !== view.icon || usingOwn !== hadOwn || picture !== undefined,
    pick: (next) => {
      setIcon(next)
      setUsingOwn(false)
    },
    takeOwn: (picked) => {
      if (picked !== undefined) setOwn(picked)
      setUsingOwn(true)
    },
  }
}

export function IconPicker({ choice }: { choice: IconChoice }) {
  const file = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const chosen = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    event.target.value = ''
    if (picked === undefined) return
    try {
      choice.takeOwn(await squareIcon(picked))
      setProblem(null)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That picture can’t be used. Try another.')
    }
  }
  return (
    <fieldset className="bk-stack" style={{ gap: 'var(--space-8)', border: 0, padding: 0 }}>
      <legend className="bk-field__label">Icon</legend>
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
        {/* Blockly's own comes first: it is what a server shows until another is picked. */}
        {[null, ...SERVER_ICONS].map((key) => (
          <button
            key={key ?? 'blockly'}
            type="button"
            className="bk-icon-pick"
            aria-pressed={!choice.usingOwn && choice.icon === key}
            aria-label={key ?? 'Cubepals’ own'}
            onClick={() => choice.pick(key)}
          >
            <Image src={iconSrc(key)} alt="" width={32} height={32} />
          </button>
        ))}
        {choice.own !== null && (
          <button
            type="button"
            className="bk-icon-pick"
            aria-pressed={choice.usingOwn}
            aria-label="Your own picture"
            onClick={() => choice.takeOwn()}
          >
            <Image src={choice.own.src} alt="" width={32} height={32} unoptimized />
          </button>
        )}
        <button
          type="button"
          className="bk-icon-pick"
          aria-label={choice.own === null ? 'Use your own picture' : 'Use another picture of your own'}
          title={choice.own === null ? 'Use your own picture' : 'Use another picture'}
          onClick={() => file.current?.click()}
        >
          <ImagePlus size={20} aria-hidden />
        </button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(event) => void chosen(event)}
        />
      </div>
      {problem === null ? (
        <span className="bk-field__help">
          Shown on the server’s page, and in Minecraft’s server list after the next start.
        </span>
      ) : (
        <span className="bk-field__error" role="alert">
          {problem}
        </span>
      )}
    </fieldset>
  )
}
