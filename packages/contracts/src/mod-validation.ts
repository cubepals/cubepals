// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What checking an exact server mod configuration has established, independent of importing files. */
export interface ModValidationView {
  key: string
  state: 'checking' | 'verified' | 'blocked' | 'unavailable'
  message: string | null
  checkedAt: string | null
}

/** Null means this configuration contains no mods requiring a runtime check. */
export const modValidationPassed = (view: ModValidationView | null | undefined): boolean =>
  view == null || view.state === 'verified'

export const modValidationPending = (view: ModValidationView | null | undefined): boolean =>
  view?.state === 'checking' || view?.state === 'unavailable'
