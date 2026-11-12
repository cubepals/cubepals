// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * How hard the server works for the players and distances as they are slid, and the size it
 * runs them on, in one card: the ten blocks of the site's meter lit to the work (`load.ts`), a
 * word and a line under them, then the sizes, with the one this change saves chosen. Cubepals
 * moves the size up for what was slid (`use-sizing.ts`) and says so, with the way back; the owner
 * can pick another, and a bigger one says it uses hours faster. Saving asks before anything
 * changes. Every word the card can say holds its place, so it keeps its height while sliding.
 */

import type { SettingsOptions } from '@blockly/contracts'
import { METER } from '@blockly/contracts/meter'
import { type CSSProperties, type ReactNode, useId } from 'react'
import { PlusOffer } from '../../../plus-offer'
import { blocksLit, type Level, levelOf, loadLine, workload } from './load'
import styles from './load-meter.module.css'
import { compareSizes, lockedFit, neededSize } from './sizing'
import type { Sizing } from './use-sizing'

const LEVELS: Level[] = ['light', 'comfortable', 'busy', 'heavy']
const byLevel = (say: (level: Level) => string) =>
  Object.fromEntries(LEVELS.map((level) => [level, say(level)])) as Record<Level, string>

type Note = 'same' | 'raised' | 'bigger' | 'smaller' | 'offer' | 'plan' | 'none'

/**
 * What the card says under the sizes. Past comfortable: the size that keeps up, the plan that has
 * one, or what brings it down. Otherwise what the size chosen means: moved up by Cubepals, with the
 * way back; bigger or smaller by the owner's pick, with what it does to their hours; or as it is.
 */
function noteFor(sizing: Sizing, level: Level) {
  const { want, size, holds, current, sizes } = sizing
  const chosen = sizes.find((s) => s.value === size)
  const own = sizes.find((s) => s.value === current.size)
  const better = sizes.find((s) => s.value === neededSize(want, sizes, { size, holds }))
  const locked = lockedFit(want, sizes, { size, holds })
  const easy = level === 'light' || level === 'comfortable'
  const strained: Note = better && better.value !== size ? 'offer' : locked ? 'plan' : 'none'
  const moved = compareSizes(chosen, own)
  const picked: Note = sizing.raised ? 'raised' : moved > 0 ? 'bigger' : moved < 0 ? 'smaller' : 'same'
  return { note: easy ? picked : strained, chosen, own, better, locked }
}

export function LoadMeter({
  sizing,
  options,
  serverId,
}: {
  sizing: Sizing
  options: SettingsOptions
  serverId: string
}) {
  const title = useId()
  const { want, size, holds, current, sizes } = sizing
  const work = workload({ ...want, holds })
  const level = levelOf(work)
  const lit = blocksLit(work)
  const { note, chosen, own, better, locked } = noteFor(sizing, level)
  // The first size this plan stops at, with the plan that has it, as the size choice always showed.
  const stop = options.partySizes.find((s) => !s.allowed)
  return (
    <section className={styles.card} data-level={level} aria-labelledby={title}>
      <div className={styles.head}>
        <h3 id={title} className="bk-field__label">
          How hard your server works
        </h3>
        <Steady shown={level} live className={`${styles.word} type-eyebrow`}>
          {byLevel((l) => loadLine(l, want.players).word)}
        </Steady>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> draws its own bar; this one is blocks. */}
      <div
        className={styles.blocks}
        style={{ '--blocks': METER.blocks } as CSSProperties}
        role="meter"
        aria-labelledby={title}
        aria-valuemin={0}
        aria-valuemax={METER.blocks}
        aria-valuenow={lit}
        aria-valuetext={loadLine(level, want.players).word}
      >
        {Array.from({ length: METER.blocks }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are fixed places, never reordered.
          <span key={i} className={styles.block} data-lit={i < lit || undefined} />
        ))}
      </div>
      <Steady shown={level} className={`${styles.line} type-body-sm`}>
        {byLevel((l) => loadLine(l, want.players).line)}
      </Steady>
      <fieldset className={styles.sizes}>
        <legend className="bk-field__label">Size</legend>
        <div className="bk-chips">
          {sizes.map((s) => (
            <label key={s.value} className="bk-chip bk-num" title={s.reason}>
              <input
                type="radio"
                name="party-size"
                value={s.value}
                checked={size === s.value}
                disabled={!s.allowed && s.value !== current.size}
                onChange={() => sizing.choose(s.value)}
              />
              <span className={styles.chip}>
                {s.label}
                {s.value === current.size && <span className={`${styles.now} type-eyebrow`}>Now</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Steady shown={note} className={`${styles.foot} type-body-sm`}>
        {{
          same: <p>Cubepals moves your server up a size when what you slide needs it.</p>,
          raised: (
            <p>
              Moves up to the size for {chosen?.maxPlayers} to keep up. A bigger server uses your hours faster
              while it runs.{' '}
              <button type="button" className="bk-linkbutton" onClick={() => sizing.choose(current.size)}>
                Keep the size for {own?.maxPlayers ?? current.holds}
              </button>
            </p>
          ),
          bigger: <p>A bigger server uses your hours faster while it runs.</p>,
          smaller: <p>A smaller server uses your hours more slowly.</p>,
          offer: (
            <p>
              The size for {better?.maxPlayers} keeps up easily with this.{' '}
              <button
                type="button"
                className="bk-linkbutton"
                onClick={() => better && sizing.choose(better.value)}
              >
                Move up to it
              </button>
            </p>
          ),
          plan: <p>The size for {locked?.maxPlayers} keeps up, on a bigger plan.</p>,
          none: <p>Shorter distances or fewer players bring it down.</p>,
        }}
      </Steady>
      {stop?.plan ? (
        <PlusOffer
          why={stop.reason ?? 'Bigger groups come with a bigger plan.'}
          plan={stop.plan}
          reason="players"
          next={`/servers/${serverId}/settings`}
        />
      ) : (
        stop && <p className="type-body-sm">Bigger sizes need a bigger plan.</p>
      )}
    </section>
  )
}

/**
 * Every variant in one place, one shown: the tallest sets the height, so a change of words never
 * moves what comes after. The hidden ones are hidden from screen readers and the keyboard too.
 */
function Steady<K extends string>({
  shown,
  live,
  className,
  children,
}: {
  shown: K
  /** Read out when it changes: the meter's word, and nothing else, so a slide isn't a speech. */
  live?: boolean
  className?: string
  children: Record<K, ReactNode>
}) {
  return (
    <div className={`${styles.steady} ${className ?? ''}`} aria-live={live ? 'polite' : undefined}>
      {(Object.keys(children) as K[]).map((key) => (
        <div
          key={key}
          className={styles.variant}
          data-shown={key === shown || undefined}
          aria-hidden={key !== shown}
        >
          {children[key]}
        </div>
      ))}
    </div>
  )
}
