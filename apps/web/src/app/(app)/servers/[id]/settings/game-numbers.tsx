// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The game form's numbers, on sliders: a map of the distances drawn to scale (`reach-map.tsx`),
 * the distances, max players and spawn protection, and under them how hard the server works
 * for all of it (`load-meter.tsx`). It holds no state; the form keeps the draft and saves it.
 */

import type { PartySize, ServerSettingsView, SettingsOptions } from '@blockly/contracts'
import { DEFAULT_DISTANCE } from '@blockly/contracts/game-defaults'
import type { ReactNode } from 'react'
import { settingLabel } from '../../../../../lib/present'
import { type NumberSetting, numberBounds } from './game-fields'
import { LoadMeter } from './load-meter'
import { RangeField } from './range-field'
import { ReachMap } from './reach-map'

/** A distance as the slider says it: "10 chunks". */
const chunks = (n: number) => `${n} ${n === 1 ? 'chunk' : 'chunks'}`
const players = (n: number) => `${n} ${n === 1 ? 'player' : 'players'}`
const protection = (n: number) => `${n} ${n === 1 ? 'block' : 'blocks'}`

/** Minecraft's own distance, marked on both distance sliders. */
const DEFAULT_MARK = { value: DEFAULT_DISTANCE, label: `Default ${DEFAULT_DISTANCE}` }

export function GameNumbers({
  draft,
  options,
  problems,
  onChange,
  onAskSize,
}: {
  draft: ServerSettingsView
  options: SettingsOptions
  problems: Record<NumberSetting, string | null>
  onChange: (next: ServerSettingsView) => void
  /** Take the owner to the size section with this size chosen. */
  onAskSize: (size: PartySize) => void
}) {
  const bounds = numberBounds(options)
  const holds = options.bounds.maxPlayers
  // The next size that holds more, whether this plan has it or the size section names the plan that does.
  const next = options.partySizes
    .filter((size) => size.maxPlayers > holds)
    .sort((a, b) => a.maxPlayers - b.maxPlayers)[0]
  const slider = (
    key: NumberSetting,
    said: (value: number) => string,
    help: ReactNode,
    mark?: { value: number; label: string },
  ) => (
    <RangeField
      label={settingLabel(key)}
      value={draft[key]}
      {...bounds[key]}
      said={said}
      mark={mark}
      help={help}
      error={problems[key]}
      onChange={(value) => onChange({ ...draft, [key]: value })}
    />
  )
  return (
    <>
      <ReachMap
        view={draft.viewDistance}
        simulation={draft.simulationDistance}
        max={bounds.viewDistance.max}
      />
      <div className="bk-grid" style={{ gap: 'var(--space-24)' }}>
        {slider('viewDistance', chunks, 'How far players see. A chunk is 16 blocks.', DEFAULT_MARK)}
        {slider(
          'simulationDistance',
          chunks,
          'How far the world keeps moving: crops grow, mobs wander, redstone runs. Never past what players see.',
          DEFAULT_MARK,
        )}
      </div>
      <div className="bk-grid" style={{ gap: 'var(--space-24)' }}>
        {slider(
          'maxPlayers',
          players,
          <>
            This size holds up to {holds}.{' '}
            {next && (
              <button type="button" className="bk-linkbutton" onClick={() => onAskSize(next.value)}>
                Choose up to {next.maxPlayers}
              </button>
            )}
          </>,
        )}
        {slider('spawnProtection', protection, 'Blocks around spawn only operators can change.')}
      </div>
      <LoadMeter
        sizes={options.partySizes}
        onAskSize={onAskSize}
        load={{
          players: draft.maxPlayers,
          holds,
          view: draft.viewDistance,
          simulation: draft.simulationDistance,
        }}
      />
    </>
  )
}
