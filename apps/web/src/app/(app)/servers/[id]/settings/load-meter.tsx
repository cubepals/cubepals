// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * How hard the server works for the settings as they are slid, before they are saved: the ten
 * blocks of the site's meter, lit to the work, with a word and a line under them. Past
 * comfortable it names the size that keeps up, as the overview's out-of-memory note does, and
 * one press takes the owner to the size section with that size chosen; changing it still asks
 * there. An estimate that refuses nothing (`load.ts`). Every word it can say holds its place, so
 * the card keeps its height while the sliders move.
 */

import type { PartySize } from '@blockly/contracts'
import { METER } from '@blockly/contracts/meter'
import { type CSSProperties, type ReactNode, useId } from 'react'
import { Button } from '../../../../../ui'
import {
  blocksLit,
  type Level,
  type Load,
  levelOf,
  loadLine,
  type Size,
  sizeThatFits,
  workload,
} from './load'
import styles from './load-meter.module.css'

const LEVELS: Level[] = ['light', 'comfortable', 'busy', 'heavy']
const byLevel = (say: (level: Level) => string) =>
  Object.fromEntries(LEVELS.map((level) => [level, say(level)])) as Record<Level, string>

export function LoadMeter({
  load,
  sizes,
  onAskSize,
}: {
  load: Load
  sizes: readonly (Size & { value: PartySize })[]
  onAskSize: (size: PartySize) => void
}) {
  const title = useId()
  const work = workload(load)
  const level = levelOf(work)
  const lit = blocksLit(work)
  const easy = level === 'light' || level === 'comfortable'
  const offer = sizeThatFits(load, sizes)
  const size = offer?.size as (Size & { value: PartySize }) | undefined
  return (
    <section className={styles.card} data-level={level} aria-labelledby={title}>
      <div className={styles.head}>
        <h3 id={title} className="bk-field__label">
          How hard your server works
        </h3>
        <Steady shown={level} live className={`${styles.word} type-eyebrow`}>
          {byLevel((l) => loadLine(l, load.players).word)}
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
        aria-valuetext={loadLine(level, load.players).word}
      >
        {Array.from({ length: METER.blocks }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are fixed places, never reordered.
          <span key={i} className={styles.block} data-lit={i < lit || undefined} />
        ))}
      </div>
      <Steady shown={level} className={`${styles.line} type-body-sm`}>
        {byLevel((l) => loadLine(l, load.players).line)}
      </Steady>
      <Steady shown={easy ? 'easy' : size ? 'offer' : 'none'} className={styles.foot}>
        {{
          easy: (
            <p className="type-body-sm bk-num">
              Your server holds up to {load.holds} at once. An estimate from the players and distances above.
            </p>
          ),
          offer: size ? (
            <div className={styles.offer}>
              <p className="type-body-sm bk-num">
                A server for up to {size.maxPlayers} {offer?.fits ? 'keeps up easily' : 'works less hard'}{' '}
                with this{size.allowed ? '.' : ', on a bigger plan.'}
              </p>
              <Button variant="secondary" size="sm" onClick={() => onAskSize(size.value)}>
                {size.allowed ? `Choose up to ${size.maxPlayers}` : 'See the plans'}
              </Button>
            </div>
          ) : (
            <span />
          ),
          none: <p className="type-body-sm">Shorter distances or fewer players bring it down.</p>,
        }}
      </Steady>
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
