// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { BackupView } from '@blockly/contracts'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'

/**
 * The backup being restored, which the page asks about before it is: the one its owner pressed
 * restore on, or the one the page was opened to restore (`?restore=<id>`), as a world brought in
 * from the world page arrives here. The second is asked about once, when the list holds it.
 */
export function useRestoring(backups: readonly BackupView[]) {
  const [restoring, setRestoring] = useState<BackupView | null>(null)
  const [asked, setAsked] = useState(useSearchParams().get('restore'))
  useEffect(() => {
    if (asked === null) return
    const backup = backups.find((b) => b.id === asked)
    if (backup === undefined) return
    setAsked(null)
    setRestoring(backup)
  }, [asked, backups])
  return [restoring, setRestoring] as const
}
