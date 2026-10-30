// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * A file on its way up: how far, as a bar and a percentage, and under it how much has gone, how
 * fast and about how long is left (`lib/upload-pace.ts`), with a way to stop it. The pace is
 * sampled each second, so a stalled connection shows as one rather than as a frozen bar.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { useEffect, useRef, useState } from 'react'
import { keptSamples, paceLine, type Sample } from '../../lib/upload-pace'
import { Button, ProgressBar } from '../../ui'

export function UploadProgress({
  name,
  sent,
  total,
  onStop,
}: {
  name: string
  sent: number
  total: number
  /** Stops the upload; left out where it can't be stopped from here. */
  onStop?: () => void
}) {
  const latest = useRef(sent)
  latest.current = sent
  const [samples, setSamples] = useState<Sample[]>(() => [{ at: Date.now(), sent }])
  useEffect(() => {
    const timer = setInterval(
      () => setSamples((kept) => keptSamples(kept, { at: Date.now(), sent: latest.current })),
      SECOND_MS,
    )
    return () => clearInterval(timer)
  }, [])
  const percent = Math.min(100, (sent / Math.max(total, 1)) * 100)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <span className="type-body-sm">
        Uploading {name} · <span className="bk-num">{Math.floor(percent)}%</span>
      </span>
      <ProgressBar value={percent} label={`Uploading ${name}`} />
      <div className="bk-row" style={{ gap: 'var(--space-12)', justifyContent: 'space-between' }}>
        <span className="type-body-sm bk-num" style={{ color: 'var(--ink-muted)' }}>
          {paceLine(samples, total)}
        </span>
        {onStop && (
          <Button variant="ghost" size="sm" onClick={onStop}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
