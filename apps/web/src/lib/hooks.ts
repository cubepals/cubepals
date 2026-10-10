// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useEffect, useRef, useState } from 'react'

/** The value once it has stopped changing for `ms`, so typing doesn't ask the API on every key. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** The current time, refreshed every `everyMs`, for countdowns and "5 minutes ago". */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/** When `value` last changed, as this page saw it: how long a step has been going, for one. */
export function useSince(value: unknown): number {
  const [since, setSince] = useState(() => Date.now())
  const seen = useRef(value)
  useEffect(() => {
    if (Object.is(seen.current, value)) return
    seen.current = value
    setSince(Date.now())
  }, [value])
  return since
}
