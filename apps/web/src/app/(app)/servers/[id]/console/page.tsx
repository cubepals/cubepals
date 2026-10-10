// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { realtime, useWatchConsole } from '../../../../../lib/realtime'
import { Console, type ConsoleLine, Note } from '../../../../../ui'
import { useServer } from '../use-server'

const KEEP = 500

/** A console line, and when it was printed, for putting history and live lines in order. */
type Shown = ConsoleLine & { at: number }

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

export default function ConsolePage() {
  const server = useServer()
  const trpc = useTRPC()
  const [lines, setLines] = useState<Shown[]>([])
  const counter = useRef(0)
  /** Server lines already shown, by time and text: history and the live tail can overlap. */
  const seen = useRef(new Set<string>())
  const run = useMutation(trpc.console.run.mutationOptions())

  const shown = (line: { at: string; text: string; level: ConsoleLine['level'] }): Shown => {
    counter.current += 1
    return {
      id: String(counter.current),
      at: Date.parse(line.at),
      time: clock(line.at),
      text: line.text,
      level: line.level,
    }
  }
  /** Lines in the order the server printed them, the newest KEEP of them. */
  const merge = (incoming: Shown[]) =>
    setLines((current) => [...current, ...incoming].sort((a, b) => a.at - b.at).slice(-KEEP))
  const fresh = (line: { at: string; text: string }) => {
    const key = `${line.at}|${line.text}`
    if (seen.current.has(key)) return false
    seen.current.add(key)
    return true
  }

  useWatchConsole(server.id)

  realtime.useEvent('consoleLine', (line) => {
    if (line.serverId === server.id && fresh(line)) merge([shown(line)])
  })
  // What the server printed before this page watched it, sent when watching starts.
  realtime.useEvent('consoleHistory', (history) => {
    if (history.serverId === server.id) merge(history.lines.filter(fresh).map(shown))
  })

  const running = server.data?.status === 'running'

  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Console
      </h1>
      {run.isError && <Note tone="danger">{messageOf(run.error)}</Note>}
      <Console
        lines={lines}
        disabled={!running}
        onSubmit={async (command) => {
          merge([shown({ at: new Date().toISOString(), text: `> ${command}`, level: 'info' })])
          const result = await run.mutateAsync({ serverId: server.id, command }).catch(() => null)
          if (result?.output)
            merge([shown({ at: new Date().toISOString(), text: result.output, level: 'info' })])
        }}
      />
    </>
  )
}
