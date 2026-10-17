// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The first screen's proof: Cubepals' own Arcade, which anyone can join, as it was read on the
 * server a moment ago (Landing.tsx), so it is there with the first screen. Said only when the
 * Arcade is awake or asleep; otherwise nothing is said. The address copies at a press.
 */
import { useEffect, useRef, useState } from 'react'
import type { PublicStatus } from '../../app/(public)/status'
import { ctaMark } from '../../app/(public)/steps'

export function Arcade({ status, className }: { status: PublicStatus | null; className?: string }) {
  const [copied, setCopied] = useState(false)
  const address = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  if (!status) return null
  const copy = async () => {
    // The clipboard exists only in a secure context; anywhere else the address is selected.
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(status.address)
      setCopied(true)
    } else if (address.current) window.getSelection()?.selectAllChildren(address.current)
  }
  const shown = (
    <button type="button" onClick={copy} title="Copy the address" {...ctaMark('copy_arcade')}>
      <span ref={address}>{status.address}</span>
      <span aria-live="polite">{copied ? ' Copied' : ''}</span>
    </button>
  )
  return status.state === 'asleep' ? (
    <p className={className}>Try ours first: {shown} is asleep. Join it and it wakes.</p>
  ) : (
    <p className={className}>
      {shown} · {status.players.online} playing. Join from Minecraft.
    </p>
  )
}
