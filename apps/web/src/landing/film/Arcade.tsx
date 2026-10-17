// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The first screen's proof: Cubepals' own Arcade, which anyone can join, as it is right now. Read
 * from the same public status Browse and a server's page read, after the page has loaded, so the
 * first screen never waits on it. Said only when the status is known and the Arcade is awake or
 * asleep; otherwise nothing is said. The address copies at a press.
 */
import { useEffect, useRef, useState } from 'react'
import type { PublicStatus } from '../../app/(public)/status'
import { ctaMark } from '../../app/(public)/steps'

/** The Arcade's address on the public status endpoint. */
const ARCADE = 'arcade'

export function Arcade({ className }: { className?: string }) {
  const [status, setStatus] = useState<PublicStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const address = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    const read = () =>
      fetch(`/api/public/servers/${ARCADE}`, { signal: controller.signal })
        .then((response) => (response.ok ? (response.json() as Promise<PublicStatus>) : null))
        .then((read) => setStatus(read && (read.state === 'awake' || read.state === 'asleep') ? read : null))
        .catch(() => setStatus(null))
    if (document.readyState === 'complete') read()
    else window.addEventListener('load', read, { once: true })
    return () => {
      controller.abort()
      window.removeEventListener('load', read)
    }
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  if (!status) return <p className={className} />
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
