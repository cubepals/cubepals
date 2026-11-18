// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What a server is doing while it wakes, under the button that woke it: the step it is on, how
 * long is left, and the newest few things it said, in Minecraft's words, entering one at a time.
 * The same on the server page and in settings. A resume that is back in a second or two never
 * opens it; a cold boot fills it for most of a minute; silence says, in words, what it is doing.
 *
 * `useWake` keeps what it heard where the page keeps it, so a wake that fails can still show how
 * far it got after the button that started it is gone. `WakeLog` only draws it. Not for a first
 * build, which has its own panel (`boot-line.tsx`), nor for the console, which shows everything.
 */

import type { OperationView, ServerView } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import Link from 'next/link'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { useNow, useSince } from '../../../../lib/hooks'
import { isBooting, isWake, presentProgress, quietLine, wakeLine } from '../../../../lib/present'
import { realtime, useConsoleLines, useWatchConsole } from '../../../../lib/realtime'
import { type WakeWords, wakeWords } from '../../../../lib/wake-words'
import { KEPT, type Line, lower, nextLines } from './wake-lines'

/** How long each line holds before the next takes its place, however fast the server talks. */
const HOLD_MS = 700
/** How long a resume is given before the log opens: most are back well inside it. */
const RESUME_GRACE_MS = 4_000
/** How long the finished log stays before it gives way to the page. */
const DONE_MS = 1_600

export interface Wake {
  /** `waking` while it wakes, `done` for a moment after, `failed` until the next wake. */
  phase: 'idle' | 'waking' | 'done' | 'failed'
  /** Whether the log is in view: not for a resume that is back before anyone would wait. */
  open: boolean
  lines: Line[]
  /** The wake it is about, kept after it ends for the step it got to. */
  operation: OperationView | null
}

/**
 * The wake under way on `server`, or the one that just ended, and what it said. Called where
 * the page keeps it for as long as the page is open, so the lines outlive the button.
 */
export function useWake(server: ServerView): Wake {
  const active = isWake(server.activeOperation) ? server.activeOperation : null
  const [last, setLast] = useState<OperationView | null>(active)
  const [phase, setPhase] = useState<Wake['phase']>(active ? 'waking' : 'idle')
  const [lines, setLines] = useState<Line[]>([])
  const [shown, setShown] = useState(false)
  const kept = useRef<Line[]>([])
  const pending = useRef<WakeWords[]>([])
  const shownAt = useRef(0)
  const seenAt = useSince(active?.id ?? null)
  const now = useNow(phase === 'waking' ? 500 : MINUTE_MS)

  // A new wake starts a new log.
  useEffect(() => {
    if (active === null) return
    if (active.id !== last?.id) {
      pending.current = []
      shownAt.current = 0
      kept.current = []
      setLines([])
      setShown(false)
    }
    if (active.step !== last?.step || active.id !== last?.id) setLast(active)
    setPhase('waking')
  }, [active, last])
  // The end of one says how it went: anything but running at the end is a wake that didn't make
  // it. A failed wake's log stays until the server moves on: running again, or busy with something else.
  const busy = server.activeOperation !== null
  useEffect(() => {
    if (active !== null) return
    if (phase === 'waking') setPhase(server.status === 'running' ? 'done' : 'failed')
    else if (phase === 'failed' && (server.status === 'running' || busy)) setPhase('idle')
  }, [active, phase, server.status, busy])
  useEffect(() => {
    if (phase !== 'done') return
    const timer = setTimeout(() => setPhase('idle'), DONE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  // In view once it is clearly a wait: a cold boot or a world coming back from storage at once,
  // a resume only once it has taken longer than resumes do. Once in view, it stays to the end.
  const wait =
    active !== null && (active.kind === 'unstore' || isBooting(active.step) || now - seenAt > RESUME_GRACE_MS)
  useEffect(() => {
    if (wait) setShown(true)
  }, [wait])

  const since = last === null ? 0 : Date.parse(last.createdAt) - 2_000
  const hear = (line: { at: string; text: string; level: string }) => {
    if (Date.parse(line.at) < since) return
    const words = wakeWords(line)
    // A burst keeps only its newest: nobody reads forty lines in a second.
    if (words !== null) pending.current = [...pending.current, words].slice(-(KEPT - 1))
  }
  useConsoleLines(server.id, ({ lines }) => {
    if (phase === 'waking') for (const line of lines) hear(line)
  })
  // Opened partway through a wake: what it said since it began.
  realtime.useEvent('consoleHistory', (history) => {
    if (history.serverId !== server.id || phase !== 'waking' || kept.current.length > 1) return
    for (const line of history.lines) hear(line)
  })

  // One line at a time: the next one heard, or, after a while of nothing, what it is doing.
  const quiet = quietLine(last?.step ?? null, server, last?.kind ?? 'start')
  useEffect(() => {
    if (phase !== 'waking' && phase !== 'done') return
    const tick = () => {
      const at = Date.now()
      if (at - shownAt.current < HOLD_MS) return
      const heard = pending.current[0]
      pending.current = pending.current.slice(1)
      const next = nextLines(kept.current, heard, {
        quiet,
        waking: phase === 'waking',
        at,
        shownAt: shownAt.current,
      })
      if (next === null) return
      shownAt.current = at
      kept.current = next
      setLines(next)
    }
    tick()
    const timer = setInterval(tick, HOLD_MS / 2)
    return () => clearInterval(timer)
  }, [phase, quiet])

  const open = phase === 'failed' || (phase !== 'idle' && shown)
  return { phase, open, lines, operation: active ?? last }
}

/** Listens to the console only while there is a wake to show, so a running server's page doesn't. */
function Listening({ serverId }: { serverId: string }) {
  useWatchConsole(serverId)
  return null
}

/** The log itself, under the wake button wherever there is one. */
export function WakeLog({
  server,
  wake,
  section,
}: {
  server: ServerView
  wake: Wake
  /**
   * The gap of the stack it stands in ("var(--space-16)"), where the stack spaces it: closed, it
   * hands that gap back, so a page without a wake looks as it did.
   */
  section?: string
}) {
  const now = useNow(1_000)
  const since = useSince(wake.operation?.step ?? null)
  const operation = wake.operation
  const progress = operation === null ? null : presentProgress(operation, server)
  const index = wake.phase === 'done' ? (progress?.steps.length ?? 0) : (progress?.index ?? 0)
  // The step it is on creeps on while it is on it, as the first build's bar does.
  const within = Math.min(0.9, 1 - Math.exp(-(now - since) / 10_000))
  const failed = wake.phase === 'failed'
  return (
    <div
      className={[
        'bk-wake',
        section && 'bk-wake--section',
        wake.open && 'bk-wake--open',
        failed && 'bk-wake--failed',
      ]
        .filter(Boolean)
        .join(' ')}
      style={section === undefined ? undefined : ({ '--wake-gap': section } as CSSProperties)}
      aria-hidden={!wake.open}
      inert={!wake.open}
    >
      {wake.phase === 'waking' && <Listening serverId={server.id} />}
      <div className="bk-wake__fold">
        <div className="bk-wake__body">
          <div className="bk-wake__track" aria-hidden>
            {progress?.steps.map((step, i) => (
              <span
                key={step.label}
                className={
                  i < index
                    ? 'bk-wake__segment bk-wake__segment--done'
                    : i === index
                      ? 'bk-wake__segment bk-wake__segment--active'
                      : 'bk-wake__segment'
                }
                style={i === index ? ({ '--within': within } as CSSProperties) : undefined}
              />
            ))}
          </div>
          <span className="bk-wake__step bk-num">
            {wake.phase === 'done'
              ? 'Ready to join'
              : failed
                ? `It got as far as ${lower(progress?.steps[index]?.label ?? 'waking')}`
                : wakeLine({ ...server, activeOperation: operation }, now)}
          </span>
          <Said lines={wake.lines} still={failed} />
          {failed && (
            <Link href={`/servers/${server.id}/console`} className="bk-wake__more">
              See everything it said
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The newest lines. They fill from the top; once full, each new one lifts the others and the
 * oldest leaves. `still` for a wake that is over, whose lines stay as they were, whole.
 */
function Said({ lines, still }: { lines: Line[]; still: boolean }) {
  const newest = lines.at(-1)?.key ?? 0
  return (
    <ol
      className={lines.length >= KEPT ? 'bk-wake__lines bk-wake__lines--full' : 'bk-wake__lines'}
      key={still ? 'still' : newest}
      aria-hidden
    >
      {lines.map((line) => (
        <li
          key={line.key}
          className={line.key === newest ? 'bk-wake__line bk-wake__line--newest' : 'bk-wake__line'}
        >
          <span key={line.text} className={line.key === newest && !still ? 'bk-wake__said' : undefined}>
            {line.text}
          </span>
        </li>
      ))}
    </ol>
  )
}
