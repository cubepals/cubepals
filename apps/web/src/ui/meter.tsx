// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { blocksFilled, METER, meterLine } from '@blockly/contracts/meter'
import type { CSSProperties } from 'react'

/**
 * Play as ten blocks filled to the mark, the meter the emails draw and players know from the game,
 * with the line under it in words: "96 of 120 hours left". The shape, the rounding and the line
 * come from `@blockly/contracts/meter`, which the emails draw from too; the colours are the
 * theme's. On a phone the blocks shrink so all ten stay on one line.
 */
export function BlockMeter({ left, included, label }: { left: number; included: number; label: string }) {
  const filled = blocksFilled(left, included)
  const line = meterLine(left, included, 'left')
  const shape = {
    '--meter-blocks': METER.blocks,
    '--meter-block': `${METER.blockPx}px`,
    '--meter-gap': `${METER.gapPx}px`,
    '--meter-edge': `${METER.edgePx}px`,
  } as CSSProperties
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> draws its own bar; this one is blocks.
    <div
      className="bk-meter"
      style={shape}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={included}
      aria-valuenow={Math.min(included, Math.max(0, left))}
      aria-valuetext={line}
    >
      <span className="bk-meter__blocks">
        {Array.from({ length: METER.blocks }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are fixed places, never reordered.
          <span key={i} className="bk-meter__block" data-filled={i < filled || undefined} />
        ))}
      </span>
      <span className="bk-meter__line type-mono-md bk-num">{line}</span>
    </div>
  )
}
