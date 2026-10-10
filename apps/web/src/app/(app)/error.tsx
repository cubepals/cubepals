// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useEffect } from 'react'
import { reportError } from '../../lib/insight'
import { LoadFailed } from '../../ui'

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
  return <LoadFailed error="This page didn’t load. Something went wrong on our side." onRetry={reset} />
}
