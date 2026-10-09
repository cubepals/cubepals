import {
  type ConsoleTarget,
  ConsoleUnavailable,
  type ReadinessProbe,
  type ServerConsole,
  type ServerStatusPing,
} from '../../app/ports/minecraft.ts'
import type { LogLine, LogSource } from '../../app/ports/platform.ts'
import type { Endpoint, RuntimeHandle } from '../../app/ports/runtime.ts'
import type { BoatRuntime } from './boat-runtime.ts'
import { decodeHandle } from './handle.ts'

/**
 * The console, readiness and output of a server on Boat, through Boat's command endpoint rather
 * than the network: sandboxes have no private network, and RCON on a public address would put its
 * password on the internet. The control plane's endpoint for a Boat server names its sandbox, and
 * these run the image's own tools inside the workload: `rcon-cli`, which signs in with the
 * password the server was started with, so a key rotation asks nothing of it, and `mc-monitor`.
 */

const sandboxOf = (endpoint: Endpoint): string => {
  if (!/^bx_[0-9a-z]+$/.test(endpoint.host))
    throw new ConsoleUnavailable('This server has no sandbox to reach')
  return endpoint.host
}

/** Ends each command's output in `runAll`, with the command's exit status. */
const END = '@@blockly-end'

export class BoatConsole implements ServerConsole {
  readonly #boat: BoatRuntime

  constructor(boat: BoatRuntime) {
    this.#boat = boat
  }

  async run(target: ConsoleTarget, command: string): Promise<string> {
    const [result] = await this.runAll(target, [command])
    if (result === undefined || !result.ok)
      throw new ConsoleUnavailable(result?.error ?? 'The console did not answer')
    return result.output
  }

  /** Every command in one call to Boat, in order, each through its own sign-in. */
  async runAll(
    target: ConsoleTarget,
    commands: readonly string[],
  ): Promise<Array<{ ok: true; output: string } | { ok: false; error: string }>> {
    if (commands.length === 0) return []
    let result: Awaited<ReturnType<BoatRuntime['execIn']>>
    try {
      result = await this.#boat.execIn(
        sandboxOf(target.endpoint),
        [
          'sh',
          '-c',
          `for c in "$@"; do rcon-cli --port ${target.endpoint.port} "$c" 2>&1; echo; echo "${END} $?"; done`,
          'console',
          ...commands,
        ],
        30 + 5 * commands.length,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return commands.map(() => ({ ok: false as const, error: message }))
    }
    const outputs = result.stdout.split(new RegExp(`\\n?${END} (\\d+)\\n?`))
    return commands.map((_, index) => {
      const output = (outputs[index * 2] ?? '').replace(/\n$/, '')
      const status = outputs[index * 2 + 1]
      if (status === '0') return { ok: true as const, output }
      return {
        ok: false as const,
        error: output.trim() || `The console did not answer (${status ?? 'no status'})`,
      }
    })
  }
}

export class BoatProbe implements ReadinessProbe {
  readonly #boat: BoatRuntime

  constructor(boat: BoatRuntime) {
    this.#boat = boat
  }

  /** A status ping from inside the workload, as players' clients send one. */
  async ping(endpoint: Endpoint, signal: AbortSignal): Promise<ServerStatusPing> {
    const pinged = this.#boat.execIn(
      sandboxOf(endpoint),
      ['mc-monitor', 'status', '--host', 'localhost', '--port', String(endpoint.port)],
      15,
    )
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('The status ping timed out')), { once: true }),
    )
    const result = await Promise.race([pinged, aborted])
    const said = result.stdout.trim()
    const answer = / version=(\S*) online=(\d+) max=(\d+)/.exec(said)
    if (result.exitCode !== 0 || answer === null)
      throw new Error(`No answer to a status ping: ${said.slice(0, 200)}`)
    return { version: answer[1] ?? '', online: Number(answer[2]), max: Number(answer[3]) }
  }
}

/** What the workload printed, read through Boat's command endpoint; followed by reading it again. */
export class BoatLogSource implements LogSource {
  readonly #boat: BoatRuntime
  readonly #everyMs: number

  constructor(boat: BoatRuntime, options: { everyMs?: number } = {}) {
    this.#boat = boat
    this.#everyMs = options.everyMs ?? 2000
  }

  async recent(handle: RuntimeHandle, limit: number): Promise<LogLine[]> {
    const { sandboxId } = decodeHandle(handle)
    if (sandboxId === null) return []
    return linesOf(await this.#boat.output(sandboxId, { tail: limit }))
  }

  async *tail(handle: RuntimeHandle, signal: AbortSignal): AsyncIterable<LogLine> {
    const { sandboxId } = decodeHandle(handle)
    if (sandboxId === null) return
    let since: string | undefined
    let seen = ''
    while (!signal.aborted) {
      const read = await this.#boat
        .output(sandboxId, since === undefined ? { tail: 0 } : { since })
        .catch(() => '')
      for (const { line, stamp } of stamped(read)) {
        // `--since` takes whole seconds' worth again: what was already yielded is skipped.
        if (stamp <= seen) continue
        seen = stamp
        since = stamp
        yield line
      }
      since ??= new Date().toISOString()
      await new Promise((resolve) => setTimeout(resolve, this.#everyMs))
    }
  }
}

/** Docker's `--timestamps` lines: an RFC 3339 time with nanoseconds, a space, the text. */
function stamped(output: string): Array<{ line: LogLine; stamp: string }> {
  return output
    .split('\n')
    .filter((text) => text.length > 0)
    .flatMap((text) => {
      const at = text.indexOf(' ')
      const said = at > 0 ? text.slice(0, at) : ''
      const time = Date.parse(said)
      if (Number.isNaN(time)) return []
      // Docker drops trailing zeros from the nanoseconds: padded, stamps sort as the times do.
      const stamp = said.replace(
        /(?:\.(\d+))?Z$/,
        (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(9, '0')}Z`,
      )
      return [{ line: { at: new Date(time), text: text.slice(at + 1) }, stamp }]
    })
}

export const linesOf = (output: string): LogLine[] => stamped(output).map(({ line }) => line)
