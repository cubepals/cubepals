// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Chipping in, on a server's page or an invitation: a friend who plays there adds hours to it, paid
 * once, through the same checkout a plan uses. It is not where the owner sees who did (the Share
 * sheet's `ui/chip-ins.tsx`).
 */
import { CHIP_IN_AMOUNTS, type PublicServerView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { messageOf, useTRPC } from '../../lib/api'
import { chipInOpened, chipInReturned } from '../../lib/paying'
import { behindSignIn, useSignedIn } from '../../lib/viewer'
import { Button, FormSection, Note } from '../../ui'

/**
 * The offer itself: only where the server takes it, and never to its own owner. `to` is the page
 * it was opened as, which the payment comes back to.
 */
export function ChipIn({ view, to }: { view: PublicServerView; to: { slug: string } | { code: string } }) {
  const trpc = useTRPC()
  const signedIn = useSignedIn()
  // Back from the payment: read once the page is in the browser, the only place the address is.
  const [back, setBack] = useState(false)
  useEffect(() => {
    const chipped = new URLSearchParams(window.location.search).get('chipped') === '1'
    setBack(chipped)
    if (chipped) chipInReturned()
  }, [])
  const start = useMutation(
    trpc.chipIns.start.mutationOptions({ onSuccess: ({ url }) => window.location.assign(url) }),
  )
  const offer = view.chipIn
  if (offer === null) return null
  const page = 'code' in to ? `/join/${to.code}` : `/server/${to.slug}`
  const hours = (cents: number) => Math.round((cents / 100) * offer.hoursPerDollar * 10) / 10
  return (
    <FormSection
      title="Chip in"
      description={`Help keep ${view.name} running. What you chip in becomes hours of play on it, kept until they’re played, and its owner sees that it came from you.`}
    >
      {back && (
        <Note tone="success">
          Thank you. The hours reach {view.name} as soon as the payment goes through.
        </Note>
      )}
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
        {CHIP_IN_AMOUNTS.map((cents) =>
          signedIn ? (
            <Button
              key={cents}
              variant="outline"
              disabled={start.isPending}
              onClick={() => {
                chipInOpened(cents)
                start.mutate({ to, cents })
              }}
            >
              ${cents / 100} · {hours(cents)} hours
            </Button>
          ) : (
            <Button key={cents} variant="outline" href={behindSignIn(false, page)}>
              ${cents / 100} · {hours(cents)} hours
            </Button>
          ),
        )}
      </div>
      {start.isError && <Note tone="danger">{messageOf(start.error)}</Note>}
    </FormSection>
  )
}
