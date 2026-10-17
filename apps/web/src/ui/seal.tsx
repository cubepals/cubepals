// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The seal beside an official server's name on Browse and on the server's page, and the card it
 * opens. Only a listing or page marked `official` renders it; the admin row keeps its own badge.
 */
import { Tip } from './tip'

/** What the seal is called, read out and shown on hover. */
const SEAL_LABEL = 'Official: run by Cubepals'

/**
 * The seal beside the name of a server Cubepals runs: an eight-lobed seal in Ink with a Paper
 * check, the brand's two colours (`brand/README.md`) in either theme, drawn at the cap height of
 * the name it follows. Hovering it, focusing it or tapping it opens a card saying what it means.
 */
export function OfficialSeal() {
  return (
    <>
      {/* A word joiner: the seal never starts a line of its own. */}
      {'\u2060'}
      <Tip card tip={<SealCard />}>
        <SealDrawing className="bk-seal" label={SEAL_LABEL} />
      </Tip>
    </>
  )
}

function SealCard() {
  return (
    <div className="bk-seal-card">
      <SealDrawing className="bk-seal-card__seal" />
      <p className="bk-seal-card__title">Official server</p>
      <p>
        Cubepals runs this server itself, on the same Cubepals servers anyone can make. Only servers Cubepals
        runs carry this mark.
      </p>
    </div>
  )
}

/** The seal alone, in Ink and Paper whatever the theme. Titled where it stands alone. */
function SealDrawing({ className, label }: { className: string; label?: string }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: titled where it stands alone, aria-hidden in the card
    <svg
      viewBox="0 0 600 600"
      className={className}
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      {label === undefined ? null : <title>{label}</title>}
      <path
        fill="#0d0d0d"
        d="M300 50A130 130 0 0 1 476.8 123.2A130 130 0 0 1 550 300A130 130 0 0 1 476.8 476.8A130 130 0 0 1 300 550A130 130 0 0 1 123.2 476.8A130 130 0 0 1 50 300A130 130 0 0 1 123.2 123.2A130 130 0 0 1 300 50Z"
      />
      <path
        d="M178 312L262 396L428 214"
        fill="none"
        stroke="#f8f7f5"
        strokeWidth="74"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
