// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The island's stills, printed beforehand by its own scene at the camera it opens with
 * (public/imagery), and where the scene's marks fall on them, so the measurements and a sleeping
 * server's snore are there with the first paint. stills.test.ts holds these marks to the scene's
 * own: change the camera or the cut, print the stills again, and say here where the marks are.
 */
import type { Marks } from './scene'

/** The box the stills were printed for, in CSS pixels. */
export const PRINTED = { width: 565, height: 530 } as const

/**
 * The stills, one for each end of the scene, each printed twice, at their size in dots: `fine` for
 * a screen of 1.5 device pixels to a CSS pixel or more (a dot is three device pixels), `coarse` for
 * the rest (two).
 */
export const STILLS = {
  join: {
    fine: { src: '/imagery/island-awake.png', width: 376, height: 353 },
    coarse: { src: '/imagery/island-awake-coarse.png', width: 282, height: 265 },
  },
  leave: {
    fine: { src: '/imagery/island-asleep.png', width: 376, height: 353 },
    coarse: { src: '/imagery/island-asleep-coarse.png', width: 282, height: 265 },
  },
} as const

/** Where the scene's marks fall on the stills, as fractions of their width and height. */
export const STILL_MARKS: Marks = {
  across: 16,
  grassY: 64,
  cutY: 54,
  chimney: [0.4867, 0.1179],
  middle: [0.5, 0.5962],
  from: [0.169, 0.7452],
  to: [0.5255, 0.9344],
  grass: [0.8432, 0.4133],
  cut: [0.8264, 0.7197],
}
