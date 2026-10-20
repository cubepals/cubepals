// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The error page of last resort: shown when even the root layout failed (see GlobalError below).
 * Nothing in it depends on the layout, its styles or its images.
 */
'use client'

import { useEffect } from 'react'
import { LOST, SUPPORT } from '../errors/copy'
import { reportError } from '../lib/insight'

/**
 * What shows when even the root layout failed: its own page, with nothing of the layout's, and the
 * error reported to PostHog. Plain on purpose, since the styles may be what failed, but in the
 * words and the figure of every other error page (errors/copy.ts).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => reportError(error, 'root'), [error])
  const button = {
    display: 'inline-block',
    padding: '10px 18px',
    border: '2px solid #0d0d0d',
    borderRadius: 8,
    font: 'inherit',
    fontWeight: 700,
    color: 'inherit',
    background: 'transparent',
  }
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: '48px 16px',
          background: '#f8f7f5',
          color: '#0d0d0d',
          font: '18px/28px system-ui, sans-serif',
        }}
      >
        <main style={{ maxWidth: '34rem', margin: '0 auto', display: 'grid', gap: 16 }}>
          {/* biome-ignore lint/performance/noImgElement: the layout and its image pipeline may be what failed */}
          <img src="/errors/kai-shrugging.png" alt="" width={78} height={105} />
          <h1 style={{ margin: 0, fontSize: 36, lineHeight: '40px', letterSpacing: '-0.05em' }}>
            {LOST.broken.title}
          </h1>
          <p style={{ margin: 0 }}>{LOST.broken.line}</p>
          <p style={{ margin: 0, display: 'flex', gap: 12 }}>
            <button
              type="button"
              onClick={reset}
              style={{ ...button, background: '#0d0d0d', color: '#f8f7f5' }}
            >
              Try again
            </button>
            <a href="/" style={{ ...button, textDecoration: 'none' }}>
              Go home
            </a>
          </p>
          <p style={{ margin: 0, fontSize: 16, color: '#5b5954' }}>
            Still stuck? Write to <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>.
          </p>
        </main>
      </body>
    </html>
  )
}
