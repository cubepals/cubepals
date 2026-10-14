// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deployment's free-link tuning, abuse limits and capacity tuning (`domain/account/tuning.ts`),
 * installed once at startup from private configuration and read wherever they are needed. Until
 * installed, as in tests, the defaults apply.
 */
import {
  type AbuseLimits,
  type CapacityTuning,
  DEFAULT_ABUSE_LIMITS,
  DEFAULT_CAPACITY_TUNING,
  DEFAULT_FREE_LINK_TUNING,
  type FreeLinkTuning,
} from '../domain/account/tuning.ts'

interface Tuning {
  freeLinks: FreeLinkTuning
  abuse: AbuseLimits
  capacity: CapacityTuning
}

let installed: Tuning = {
  freeLinks: DEFAULT_FREE_LINK_TUNING,
  abuse: DEFAULT_ABUSE_LIMITS,
  capacity: DEFAULT_CAPACITY_TUNING,
}

/** The tuning in force. */
export const tuning = (): Tuning => installed

/** Puts a deployment's own tuning in force; the composition root's, once, at startup. */
export function installTuning(values: Tuning): void {
  installed = values
}
