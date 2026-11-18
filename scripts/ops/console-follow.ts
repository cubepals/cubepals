// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `ops.ts console <server> --follow`: a server's console watched live through the realtime role,
 * as its owner's console page watches it, so a change to how consoles stream can be seen in
 * production. The operators' API gives the address and a ticket for that one console (and writes
 * the watch to its audit log); this connects with it, naming no origin as a tool, asks for batches
 * as the website does, and prints what arrives until the time given is up or the realtime role
 * ends the session.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { type RealtimeMap, realtimeContract } from '@blockly/contracts/realtime'
import { Client } from 'transport-io'
import { connectWebSocket } from 'transport-io/websocket-transport'

/** What `POST /ops/v1/servers/:id/console/watch` answers. */
export interface WatchTicket {
  fallbackUrl: string
  ticket: string
}

type Line = { at: string; text: string }

/** What a watch saw, said at its end. */
export interface Followed {
  histories: number
  batches: number
  lines: number
  notShown: number
  /** Why the realtime role ended the session, or null when the time given ran out first. */
  endedBy: string | null
}

/** One line as the CLI prints it: when, and what the server said. */
const followLine = ({ at, text }: Line) => `${at}  ${text}`

/** The count of lines left out, as the console page says it. */
const notShownLine = ({ count, at }: { count: number; at: string }) =>
  `${at}  ${count.toLocaleString('en')} ${count === 1 ? 'line' : 'lines'} not shown: the server printed faster than anyone can read.`

/** What a watch saw, in one line. */
export const followedLine = (seen: Followed) =>
  `${seen.batches} ${seen.batches === 1 ? 'message' : 'messages'} with ${seen.lines} lines, ${seen.notShown} not shown, ` +
  `after ${seen.histories === 1 ? 'the' : 'no'} earlier lines; ${seen.endedBy === null ? 'stopped watching' : `ended by the realtime role: ${seen.endedBy}`}`

/** Watches the console the ticket names for `seconds`, saying each line as it arrives. */
export async function followConsole(
  watch: WatchTicket & { serverId: string },
  seconds: number,
  say: (line: string) => void,
): Promise<Followed> {
  const url = new URL(watch.fallbackUrl)
  url.searchParams.set('ticket', watch.ticket)
  // Bun's WebSocket names no origin, which is how the realtime role tells a tool from a page: it
  // lets one in only with an operator's ticket.
  const client = new Client<RealtimeMap>({
    contract: realtimeContract,
    connect: () => connectWebSocket({ url: url.href }),
  })
  const seen: Followed = { histories: 0, batches: 0, lines: 0, notShown: 0, endedBy: null }
  client.on('consoleHistory', ({ serverId, lines }) => {
    if (serverId !== watch.serverId) return
    seen.histories++
    for (const line of lines) say(followLine(line))
  })
  client.on('consoleLines', ({ serverId, lines, unshown }) => {
    if (serverId !== watch.serverId) return
    seen.batches++
    seen.lines += lines.length
    for (const line of lines) say(followLine(line))
    if (unshown !== null) {
      seen.notShown += unshown.count
      say(notShownLine(unshown))
    }
  })
  const connected = new Promise<void>((resolve, reject) =>
    client.onSession((state) => {
      if (state.status === 'connected') resolve()
      if (state.status === 'closed')
        reject(
          new Error(
            `the realtime role refused the watch: ${state.refused?.reason ?? state.lastError?.message ?? 'closed'}`,
          ),
        )
    }),
  )
  await client.connect()
  await connected
  client.emit('watch', { serverId: watch.serverId, topic: 'console', batched: true })
  // Until the time given is up, or the realtime role closes the session.
  const ended = new Promise<string>((resolve) =>
    client.onSession((state) => {
      if (state.status === 'closed') resolve(state.refused?.reason ?? 'closed')
    }),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), seconds * SECOND_MS)
  })
  seen.endedBy = await Promise.race([ended, timeUp])
  clearTimeout(timer)
  client.disconnect()
  return seen
}
