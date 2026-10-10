// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { PassThrough, Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import Docker from 'dockerode'
import type { LogLine, LogSource } from '../../app/ports/platform.ts'
import type { RuntimeHandle } from '../../app/ports/runtime.ts'
import { decodeHandle } from './handle.ts'

/** Container output as raw lines. Docker prefixes each with an RFC 3339 timestamp when asked. */
export class DockerLogSource implements LogSource {
  readonly #docker: Docker

  constructor(socketPath: string) {
    this.#docker = new Docker({ socketPath })
  }

  async recent(handle: RuntimeHandle, limit: number): Promise<LogLine[]> {
    const { container } = decodeHandle(handle)
    const buffer = (await this.#docker
      .getContainer(container)
      .logs({ stdout: true, stderr: true, timestamps: true, tail: limit, follow: false })) as Buffer
    const lines: LogLine[] = []
    for await (const line of this.#lines(Readable.from([buffer]))) lines.push(line)
    return lines
  }

  /**
   * Follows one container through restarts, as a Fly machine's log stream does. Docker ends a
   * follow when the container stops, so the tail waits for its next start and reads on from there.
   * It ends when the container is gone or the reader stops.
   */
  async *tail(handle: RuntimeHandle, signal: AbortSignal): AsyncIterable<LogLine> {
    const target = this.#docker.getContainer(decodeHandle(handle).container)
    const state = await stateOf(target)
    if (state === null) return
    // A running container is read from now on; a stopped one from the start of its next run.
    let run = state.Running ? state.StartedAt : await nextStart(target, state.StartedAt, signal)
    let since = state.Running || run === null ? Math.floor(Date.now() / 1000) : Date.parse(run) / 1000
    while (run !== null && !signal.aborted) {
      const stream = (await target.logs({
        stdout: true,
        stderr: true,
        timestamps: true,
        follow: true,
        since,
      })) as Readable
      const stop = () => stream.destroy()
      signal.addEventListener('abort', stop, { once: true })
      const watching = endOnNextRun(target, run, stop)
      try {
        yield* this.#lines(stream)
      } finally {
        signal.removeEventListener('abort', stop)
        watching.abort()
      }
      run = await nextStart(target, run, signal)
      // A new run's lines all follow its start; everything before belongs to the last run.
      if (run !== null) since = Date.parse(run) / 1000
    }
  }

  /**
   * Docker multiplexes stdout and stderr into one framed stream, and dockerode's own demuxer
   * takes the frames apart. Lines can span frames, and characters can span chunks.
   */
  async *#lines(stream: Readable): AsyncIterable<LogLine> {
    const merged = new PassThrough()
    this.#docker.modem.demuxStream(stream, merged, merged)
    stream.on('end', () => merged.end())
    stream.on('close', () => merged.end())
    const decoder = new StringDecoder('utf8')
    let pending = ''
    for await (const chunk of merged) {
      pending += decoder.write(chunk as Buffer)
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) yield* parseLine(line)
    }
    yield* parseLine(pending + decoder.end())
  }
}

/** The container's state, or null once it is gone. */
async function stateOf(target: Docker.Container): Promise<Docker.ContainerInspectInfo['State'] | null> {
  try {
    return (await target.inspect()).State
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null
    throw error
  }
}

/**
 * Ends a follow once its run is over. The daemon does that itself when the container stops, but
 * CI once saw a tail stall across a restart, which only a follow that outlived its run explains.
 */
function endOnNextRun(target: Docker.Container, run: string, end: () => void): AbortController {
  const watching = new AbortController()
  void (async () => {
    while (!watching.signal.aborted) {
      await sleep(1000, undefined, { signal: watching.signal }).catch(() => {})
      if (watching.signal.aborted) return
      const state = await stateOf(target).catch(() => undefined)
      if (state === null || (state !== undefined && state.StartedAt !== run)) return end()
    }
  })()
  return watching
}

/** The container's next start after `previous`, or null once it is gone or the reader stops. */
async function nextStart(
  target: Docker.Container,
  previous: string,
  signal: AbortSignal,
): Promise<string | null> {
  while (!signal.aborted) {
    const state = await stateOf(target)
    if (state === null) return null
    if (state.Running && state.StartedAt !== previous) return state.StartedAt
    await sleep(1000, undefined, { signal }).catch(() => {})
  }
  return null
}

function parseLine(line: string): LogLine[] {
  const trimmed = line.replace(/\r$/, '')
  if (trimmed.length === 0) return []
  const space = trimmed.indexOf(' ')
  const at = new Date(trimmed.slice(0, space))
  if (space < 0 || Number.isNaN(at.getTime())) return [{ at: new Date(), text: trimmed }]
  return [{ at, text: trimmed.slice(space + 1) }]
}
