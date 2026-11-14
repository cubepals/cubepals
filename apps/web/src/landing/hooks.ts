// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/** True for someone who asked their device for less motion: a demonstration then shows its end state. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(QUERY)
      media.addEventListener('change', changed)
      return () => media.removeEventListener('change', changed)
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
