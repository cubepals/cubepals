// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The drawing's measurements, the way a spec sheet sets them: the cube's width along its near
 * bottom edge, held off it by extension lines, and the levels of the grass and the cut at its
 * right-hand corner. Hairlines in the ground's own ink, always off the drawing, set where the
 * scene says its corners are. Not the drawing, which is scene.ts.
 */
import styles from './island.module.css'
import type { Marks } from './scene'

export function Measures({ marks }: { marks: Marks }) {
  const { from, to, middle, grass, cut } = marks
  if (!from || !to || !middle || !grass || !cut) return null
  // Out from the edge, away from the cube's middle, so the line never sits on the drawing.
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy) || 1
  let nx = -dy / length
  let ny = dx / length
  const mx = (from[0] + to[0]) / 2
  const my = (from[1] + to[1]) / 2
  if ((mx - middle[0]) * nx + (my - middle[1]) * ny < 0) {
    nx = -nx
    ny = -ny
  }
  const off = 0.045
  const a = [from[0] + nx * off, from[1] + ny * off] as const
  const b = [to[0] + nx * off, to[1] + ny * off] as const
  const p = (v: number) => v * 100
  const pc = (v: number) => `${(v * 100).toFixed(2)}%`
  const tick = 0.014
  return (
    <>
      <svg className={styles.measures} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <line
          x1={p(from[0] + nx * 0.012)}
          y1={p(from[1] + ny * 0.012)}
          x2={p(a[0] + nx * tick)}
          y2={p(a[1] + ny * tick)}
        />
        <line
          x1={p(to[0] + nx * 0.012)}
          y1={p(to[1] + ny * 0.012)}
          x2={p(b[0] + nx * tick)}
          y2={p(b[1] + ny * tick)}
        />
        <line x1={p(a[0])} y1={p(a[1])} x2={p(b[0])} y2={p(b[1])} />
        <line x1={p(grass[0] + 0.02)} y1={p(grass[1])} x2={p(grass[0] + 0.1)} y2={p(grass[1])} />
        <line x1={p(cut[0] + 0.02)} y1={p(cut[1])} x2={p(cut[0] + 0.1)} y2={p(cut[1])} />
      </svg>
      <span
        className={styles.measure}
        style={{ left: pc((a[0] + b[0]) / 2 + nx * 0.035), top: pc((a[1] + b[1]) / 2 + ny * 0.035) }}
      >
        {marks.across} blocks
      </span>
      <span
        className={`${styles.measure} ${styles.level}`}
        style={{ left: pc(grass[0] + 0.115), top: pc(grass[1]) }}
      >
        Y {marks.grassY}
      </span>
      <span
        className={`${styles.measure} ${styles.level}`}
        style={{ left: pc(cut[0] + 0.115), top: pc(cut[1]) }}
      >
        Y {marks.cutY}
      </span>
    </>
  )
}
