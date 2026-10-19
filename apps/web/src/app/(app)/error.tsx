// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { reportError } from '../../lib/insight'
import { Lost } from '../../ui/lost'

/**
 * A page of the app that failed to render: said plainly, with a way to try again, and reported to
 * PostHog with where it was caught. The sidebar and the rest of the frame stay.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => reportError(error, 'app'), [error])
  return (
    <Lost kind="broken" onRetry={reset}>
      <Link href="/servers" className="bk-btn bk-btn--outline bk-btn--md">
        Your servers
      </Link>
    </Lost>
  )
}
