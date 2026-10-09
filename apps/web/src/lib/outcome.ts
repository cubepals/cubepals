'use client'

import type { ServerView } from '@blockly/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'

/** How long a button says how its work went before it settles back to its own words. */
const SAID_MS = 2_400

/** The work a press is waiting on: the operation it started, when, and the server as it answered. */
export interface Awaited {
  operationId: string
  since: number
  version: number
}

type Seen = Pick<ServerView, 'activeOperation' | 'status' | 'lastChange' | 'version'>

/**
 * Where the work a press started stands, by what the server says now: still going while that
 * operation is the one it runs, or while the page still shows the server from before the press
 * answered; failed if the server failed, or a change that finished after the press did; done
 * otherwise.
 */
export function outcomeOf(awaited: Awaited, view: Seen): 'going' | 'done' | 'failed' {
  if (view.version < awaited.version || view.activeOperation?.id === awaited.operationId) return 'going'
  const changeFailed = view.lastChange?.status === 'failed' && Date.parse(view.lastChange.at) >= awaited.since
  return view.status === 'failed' || changeFailed ? 'failed' : 'done'
}

/**
 * How a press ended, for the button that made it (`Button`'s `done` and `failed`). A press the
 * server then acts on — settings it applies with a restart, a move, a backup — isn't done when
 * its request returns: the button stays busy in the server's own words while that runs, and says
 * it is done only once it finished well, or that it failed. A press with nothing to wait for is
 * done at once. It belongs above anything that remounts when the change lands, such as a form
 * keyed by what it saved.
 */
export function useOutcome(view: Seen | undefined) {
  const [said, setSaid] = useState<'done' | 'failed' | null>(null)
  const [awaited, setAwaited] = useState<Awaited | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const say = useCallback((outcome: 'done' | 'failed') => {
    clearTimeout(timer.current)
    setSaid(outcome)
    timer.current = setTimeout(() => setSaid(null), SAID_MS)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (awaited === null || view === undefined) return
    const outcome = outcomeOf(awaited, view)
    if (outcome === 'going') return
    setAwaited(null)
    say(outcome)
  }, [awaited, view, say])
  return {
    said,
    /**
     * The request went through. `next` is the server as it answered, with the work it started,
     * if any; call it after the page holds `next`, so the wait begins from there.
     */
    settled: (next?: Pick<ServerView, 'activeOperation' | 'version'>) => {
      const work = next?.activeOperation
      // A second's grace: the server's clock and this one's needn't agree to the millisecond.
      if (work && next) setAwaited({ operationId: work.id, since: Date.now() - 1_000, version: next.version })
      else say('done')
    },
    /** The request was refused before the server took any work on. */
    refused: () => say('failed'),
  }
}

export type Outcome = ReturnType<typeof useOutcome>

/**
 * A save button's words for how its save went: "Saved" once it has landed, and "Didn't save"
 * if it didn't — the reason is the page's to show beside it.
 */
export function said(
  outcome: Pick<Outcome, 'said'>,
  words: { done: string; failed: string } = { done: 'Saved', failed: 'Didn’t save' },
): { done: string | undefined; failed: string | undefined } {
  return {
    done: outcome.said === 'done' ? words.done : undefined,
    failed: outcome.said === 'failed' ? words.failed : undefined,
  }
}
