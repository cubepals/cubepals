// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whose the work in hand is: the request, procedure, job or pass it runs under, and the account
 * and server it is for once they are known. Opened where work enters the control plane (an HTTP
 * listener, a tRPC procedure, a job, a scheduled pass) and read wherever something slow or failed
 * is recorded, so a slow query names the account it ran for without any caller passing it on.
 *
 * Not for anything a decision depends on: what it holds is for the record alone.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface Work {
  /** What it runs under: `trpc:<path>`, `http:<listener> <route>`, `job:<queue>`, `schedule:<job>`. */
  origin: string
  requestId?: string
  accountId?: string
  serverId?: string
  /** What else names it: an operation's kind, an operator's name. */
  detail?: Record<string, string>
  /** Set while the record itself is written, so writing it is never recorded. */
  quiet?: boolean
}

const store = new AsyncLocalStorage<Work>()

/** Runs `run` as `work`, under what is in hand now: what `work` doesn't say is kept from it. */
export function within<T>(work: Partial<Work>, run: () => T): T {
  const outer = store.getStore()
  const detail = outer?.detail || work.detail ? { ...outer?.detail, ...work.detail } : undefined
  return store.run({ origin: 'process', ...outer, ...work, ...(detail ? { detail } : {}) }, run)
}

/**
 * Adds what has come to be known to the work in hand: the account once the session is read, the
 * server and what the work is once an operation is loaded.
 */
export function note(known: Partial<Omit<Work, 'quiet'>>): void {
  const work = store.getStore()
  if (work === undefined) return
  const { detail, ...rest } = known
  Object.assign(work, rest)
  if (detail) work.detail = { ...work.detail, ...detail }
}

/** The work in hand, or null outside any. */
export function currentWork(): Readonly<Work> | null {
  return store.getStore() ?? null
}
