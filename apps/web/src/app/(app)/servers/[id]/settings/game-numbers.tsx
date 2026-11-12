// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The game form's players, distance and size, as one part: max players, a map of the distances
 * drawn to scale (`reach-map.tsx`), the distances, and how hard the server works for them with
 * the size it runs them on (`load-meter.tsx`). Sliding past what the size keeps up with moves it
 * up (`use-sizing.ts`). It holds no state; the form keeps the draft and the size, and saves both
 * in one change. The overview's out-of-memory note links here as #size.
 */

import type { ServerSettingsView, SettingsOptions } from '@blockly/contracts'
import { DEFAULT_DISTANCE } from '@blockly/contracts/game-defaults'
import { type ReactNode, useEffect } from 'react'
import { settingLabel } from '../../../../../lib/present'
import { type NumberSetting, numberBounds } from './game-fields'
import { LoadMeter } from './load-meter'
import { RangeField } from './range-field'
import reach from './reach.module.css'
import { ReachMap } from './reach-map'
import type { Sizing } from './use-sizing'

/** A distance as the slider says it: "10 chunks". */
const chunks = (n: number) => `${n} ${n === 1 ? 'chunk' : 'chunks'}`
const players = (n: number) => `${n} ${n === 1 ? 'player' : 'players'}`

/** Minecraft's own distance, marked on both distance sliders. */
const DEFAULT_MARK = { value: DEFAULT_DISTANCE, label: `Default ${DEFAULT_DISTANCE}` }

export function GameNumbers({
  draft,
  options,
  problems,
  onChange,
  sizing,
  serverId,
}: {
  draft: ServerSettingsView
  options: SettingsOptions
  problems: Record<NumberSetting, string | null>
  onChange: (next: ServerSettingsView) => void
  sizing: Sizing
  serverId: string
}) {
  const bounds = numberBounds(options, sizing.holds)
  // Linked to as #size (the overview's out-of-memory note); it renders after its data, so the
  // browser's own jump to the hash has already come and gone.
  useEffect(() => {
    if (window.location.hash === '#size') document.getElementById('size')?.scrollIntoView({ block: 'start' })
  }, [])
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
  const bigger = sizing.most > sizing.current.holds
  return (
    <div id="size" className={reach.part}>
      <div className={reach.intro}>
        <h3 className="type-heading-xs">Players, distance and size</h3>
        <p className="type-body-sm">Slide what your server needs. Cubepals sizes it to keep up.</p>
      </div>
      <RangeField
        label={settingLabel('maxPlayers')}
        value={draft.maxPlayers}
        min={1}
        max={sizing.most}
        said={players}
        help={
          bigger
            ? `Past ${sizing.current.holds}, your server moves up a size.`
            : `This size holds up to ${sizing.current.holds}.`
        }
        error={problems.maxPlayers}
        onChange={(value) => onChange(sizing.withPlayers(value))}
      />
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
      <LoadMeter sizing={sizing} options={options} serverId={serverId} />
    </div>
  )
}
