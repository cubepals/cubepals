// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deployment's free-link tuning, abuse limits, capacity tuning and economics figures (`domain/account/tuning.ts`),
 * installed once at startup from private configuration and read wherever they are needed. Until
 * installed, as in tests, the defaults apply.
 */
import {
  type AbuseLimits,
  type CapacityTuning,
  DEFAULT_ABUSE_LIMITS,
  DEFAULT_CAPACITY_TUNING,
  DEFAULT_ECONOMICS_TUNING,
  DEFAULT_FREE_LINK_TUNING,
  type EconomicsTuning,
  type FreeLinkTuning,
} from '../domain/account/tuning.ts'

interface Tuning {
  freeLinks: FreeLinkTuning
  abuse: AbuseLimits
  capacity: CapacityTuning
  /** Null leaves fees and margin out of the economics report. */
  economics: EconomicsTuning | null
}

let installed: Tuning = {
  freeLinks: DEFAULT_FREE_LINK_TUNING,
  abuse: DEFAULT_ABUSE_LIMITS,
  capacity: DEFAULT_CAPACITY_TUNING,
  economics: DEFAULT_ECONOMICS_TUNING,
}

/** The tuning in force. */
export const tuning = (): Tuning => installed

/** Puts a deployment's own tuning in force; the composition root's, once, at startup. */
export function installTuning(values: Tuning): void {
  installed = values
}
