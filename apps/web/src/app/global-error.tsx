'use client'

import { useEffect } from 'react'
import { reportError } from '../lib/insight'

/**
 * What shows when even the root layout failed: its own page, with nothing of the layout's, and the
 * error reported to PostHog. Plain on purpose, since the styles may be what failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => reportError(error, 'root'), [error])
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
        <h1 style={{ fontSize: 20 }}>Cubepals didn’t load.</h1>
        <p>Something went wrong on our side.</p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </body>
    </html>
  )
}
