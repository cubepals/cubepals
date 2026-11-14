// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What is counted when the island can't be drawn: the worker wouldn't start, or the drawing failed
 * once running. Either way the page keeps the printed still, and says so once to PostHog. Not the
 * drawing itself, which is island/.
 */
import { capture } from '../lib/insight'

/** What stopped the drawing: the renderer failed in its worker, or the worker never started. */
export type Reason = 'frame' | 'worker'

const counted = new Set<Reason>()

/** Counts a failure of the drawing in PostHog, as handled, once for each reason on a page. */
export function drawingFailed(reason: Reason): void {
  if (counted.has(reason)) return
  counted.add(reason)
  capture('landing_drawing_failed', { reason })
}
