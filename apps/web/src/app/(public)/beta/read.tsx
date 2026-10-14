// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useEffect } from 'react'
import { markBetaRead } from '../../../lib/beta'

/** Opening the letter, however someone got here, puts the first-visit banner away for good. */
export function Read() {
  useEffect(markBetaRead, [])
  return null
}
