// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useLayoutEffect } from 'react'
import { markBetaRead } from '../../../lib/beta'
import { FILL_MS, fadeFromLetter, letterArrived } from '../../../ui/letter-motion'

/**
 * The letter on screen. Opening it, however someone got here, puts the first-visit banner away
 * for good. Arriving by the fill, its parts wait for the yellow to finish growing before they come
 * in; leaving, its yellow fades off the next page. Before paint, so neither shows a wrong frame.
 */
export function Read() {
  useLayoutEffect(() => {
    const letter = document.querySelector<HTMLElement>('[data-letter]')
    // The fill's curve has done most of its growing by two thirds of the way: the title starts then.
    if (letter && document.documentElement.hasAttribute('data-letter-fill'))
      letter.style.setProperty('--after', `${Math.round((FILL_MS * 2) / 3)}ms`)
    markBetaRead()
    letterArrived()
    return () => {
      // A development remount runs this and mounts again at once: only a letter that is gone fades.
      queueMicrotask(() => {
        if (document.querySelector('[data-letter]') === null) fadeFromLetter()
      })
    }
  }, [])
  return null
}
