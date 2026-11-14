// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * How far a plan's hours go at each of its sizes, worked out where the size is picked: a bigger
 * server counts more than one of the plan's hours for each hour it runs, and this is where that
 * is said, with the hours of play it leaves. Read from the plan's own sizes, so it says what the
 * plan does. Not the plans themselves, which are their cards (Pricing.tsx).
 */
import type { PublicPlan } from '@blockly/contracts'
import { useId, useState } from 'react'
import { sizesOf } from '../../ui/plans'
import styles from './pricing.module.css'

const TIMES: Record<number, string> = { 1: 'one hour', 2: 'two hours', 3: 'three hours', 4: 'four hours' }

export function Hours({ plan }: { plan: PublicPlan }) {
  const sizes = sizesOf(plan)
  const name = useId()
  const [at, setAt] = useState(0)
  const size = sizes[at] ?? sizes[0]
  if (!size) return null
  const hours = plan.totalHours ?? plan.includedHours
  const play = Math.floor(hours / size.hoursAnHour)
  const counts = TIMES[size.hoursAnHour] ?? `${size.hoursAnHour} hours`
  return (
    <div className={styles.hours}>
      <p className="lp-label">How far {plan.name}’s hours go</p>
      <fieldset className={`bk-chips ${styles.sizes}`}>
        <legend className="bk-visually-hidden">Server size</legend>
        {sizes.map((one, index) => (
          <label key={one.gb} className="bk-chip bk-num">
            <input type="radio" name={name} checked={index === at} onChange={() => setAt(index)} />
            {one.gb} GB
          </label>
        ))}
      </fieldset>
      <p className={styles.play} aria-live="polite">
        <span className={styles.number}>{play}</span>
        <span>
          hours of play {plan.per === 'month' ? 'a month' : 'in all'}, for up to {size.maxPlayers} players
        </span>
      </p>
      <div className={styles.bar} aria-hidden>
        <span style={{ width: `${(play / hours) * 100}%` }} />
      </div>
      <p className="lp-body">
        An hour on a {size.gb} GB server counts as {counts} of {plan.name}’s {hours}.
        {size.hoursAnHour > 1 ? ' It’s for a big group, or a heavy modpack.' : ''}
      </p>
    </div>
  )
}
