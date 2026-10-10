// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { OperationView, ServerView } from '@blockly/contracts'
import { useEffect, useRef, useState } from 'react'
import { useNow } from '../../../../lib/hooks'
import { quietLine } from '../../../../lib/present'
import { realtime, useWatchConsole } from '../../../../lib/realtime'

/** How long a line stays before the next may take its place, however fast the server talks. */
const HOLD_MS = 1_600
/** How long the server may say nothing before the line says, in words, what it is doing. */
const QUIET_MS = 6_000

/** The image saying one more mod or plugin has landed, for counting them as they do. */
const DOWNLOADED = /Downloaded \/data\/(?:mods|plugins)\//

/**
 * Minecraft's own words, which are worth a glance. Not Java's warnings or the image setting up,
 * which the console marks as such; not a line that is mostly a web address; not the console's
 * own "For help, type help", which is for someone at a console; and not the answers to Blockly's
 * own commands ("[Rcon: Automatic saving is now enabled]"), which are Blockly talking to itself.
 */
const worthShowing = (line: { text: string; level: string }): boolean =>
  line.level === 'info' &&
  line.text.trim().length > 0 &&
  !line.text.includes('://') &&
  !line.text.includes('For help, type') &&
  !line.text.includes('[Rcon')

/**
 * One quiet line under the step a new server is on, so nobody wonders whether it's stuck: the
 * newest thing Minecraft said, changing at a calm pace however fast it talks, and, while it says
 * nothing, what it is doing in words. It shows it's alive; the steps say how far it is.
 */
export function BootLine({
  server,
  step,
  kind = 'provision',
}: {
  server: ServerView
  step: OperationView['step']
  /** What the server is going through: a first build, or a change to one that runs already. */
  kind?: OperationView['kind']
}) {
  useWatchConsole(server.id)
  const now = useNow(1_000)
  const [said, setSaid] = useState<{ text: string; at: number } | null>(null)
  // Mods arrive faster than anyone reads them: the line counts them instead of naming each one.
  const [landed, setLanded] = useState({ count: 0 })
  realtime.useEvent('consoleLine', (line) => {
    if (line.serverId !== server.id) return
    if (worthShowing(line)) setSaid({ text: line.text, at: Date.now() })
    else if (DOWNLOADED.test(line.text)) setLanded((was) => ({ count: was.count + 1 }))
  })
  // Opened partway through: the newest line so far, as if it had just been said.
  realtime.useEvent('consoleHistory', (history) => {
    if (history.serverId !== server.id) return
    const newest = history.lines.filter(worthShowing).at(-1)
    if (newest) setSaid((current) => current ?? { text: newest.text, at: Date.now() })
  })
  // Once mods are landing, the count stays until the step moves on: a big one can take a while,
  // and the count going back to words would read as if the download had stopped.
  const counting = step === 'booting' && landed.count > 0
  const target = counting
    ? `${landed.count} ${landed.count === 1 ? 'mod' : 'mods'} downloaded`
    : said !== null && now - said.at < QUIET_MS
      ? said.text
      : quietLine(step, server, kind)
  const { shown, before } = usePaced(target)
  return (
    <span className="bk-prov__live" aria-hidden>
      {before && (
        <span key={before.key} className="bk-prov__said bk-prov__said--out">
          {before.text}
        </span>
      )}
      <span key={shown.key} className="bk-prov__said bk-prov__said--in">
        {shown.text}
      </span>
    </span>
  )
}

interface Said {
  text: string
  key: number
}

/**
 * The newest `target`, at most one change every HOLD_MS: whatever arrived in between is skipped
 * for the newest, and the one it replaces is kept long enough to fade out.
 */
function usePaced(target: string): { shown: Said; before: Said | null } {
  const [state, setState] = useState<{ shown: Said; before: Said | null }>({
    shown: { text: target, key: 0 },
    before: null,
  })
  const changedAt = useRef(0)
  const latest = useRef(target)
  useEffect(() => {
    latest.current = target
    if (target === state.shown.text) return
    const timer = setTimeout(
      () => {
        changedAt.current = Date.now()
        setState((current) =>
          latest.current === current.shown.text
            ? current
            : { shown: { text: latest.current, key: current.shown.key + 1 }, before: current.shown },
        )
      },
      Math.max(0, changedAt.current + HOLD_MS - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [target, state.shown.text])
  return state
}
