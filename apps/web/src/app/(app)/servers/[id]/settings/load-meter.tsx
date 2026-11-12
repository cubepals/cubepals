// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { METER } from '@blockly/contracts/meter'
import { type CSSProperties, useId } from 'react'
import { blocksLit, type Load, levelOf, loadLine, workload } from './load'
import styles from './load-meter.module.css'

/**
 * How hard the server works for the settings as they are slid, before they are saved: the ten
 * blocks of the site's meter, lit to the work, with a word and a line under them. Heavy turns
 * the blocks red and points to the sizes below. An estimate that refuses nothing (`load.ts`).
 */
export function LoadMeter({ load, bigger }: { load: Load; bigger: boolean }) {
  const title = useId()
  const work = workload(load)
  const level = levelOf(work)
  const lit = blocksLit(work)
  const { word, line } = loadLine(level, load.players, bigger)
  return (
    <section className={styles.card} data-level={level} aria-labelledby={title}>
      <div className={styles.head}>
        <h3 id={title} className="bk-field__label">
          How hard your server works
        </h3>
        <span className={`${styles.word} type-eyebrow`} aria-live="polite">
          {word}
        </span>
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
        aria-valuetext={word}
      >
        {Array.from({ length: METER.blocks }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are fixed places, never reordered.
          <span key={i} className={styles.block} data-lit={i < lit || undefined} />
        ))}
      </div>
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        {line} An estimate from the players and distances above.
      </p>
    </section>
  )
}
