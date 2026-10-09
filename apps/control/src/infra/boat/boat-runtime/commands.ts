/**
 * The sandbox's program and other commands, run through Boat's command endpoint. It never reads or
 * changes the sandbox itself, which `sandboxes.ts` does, and never decides which verb a port verb
 * needs, which `boat-runtime.ts` does.
 */

import type { ExecResult, RuntimeSpec } from '../../../app/ports/runtime.ts'
import { BoatApiError, type BoatClient, must, type Sandbox } from '../client.ts'
import {
  NEXT_CONFIG,
  SETTLE_PART_SECONDS,
  SETTLE_SECONDS,
  script,
  scriptOnNew,
  specDigest,
  type Verb,
  workloadConfig,
} from '../sandbox-scripts.ts'

/** How long a sandbox may take to finish a long job. */
export const JOB_SECONDS = 6 * 3600
/** Longer than this, a command runs detached and is polled: Boat holds one for at most 600 s. */
const SYNC_SECONDS = 300
/**
 * How many times a verb may answer "wait" while the sandbox brings back its workload after a
 * resume: the program stops answering it once SETTLE_SECONDS have gone, and this bounds it anyway.
 */
const WAITS = Math.ceil(SETTLE_SECONDS / SETTLE_PART_SECONDS) + 2

/**
 * Whether Boat has never saved the sandbox's disk: then it was never stopped and resumed, nothing
 * of it comes back lazily, and the program needn't wait for a container it never held.
 */
export const neverSaved = (sandbox: Sandbox) => sandbox.snapshotCompletedAt == null

const commandOf = (verb: Verb, args: readonly string[], isNew: boolean) =>
  isNew ? scriptOnNew(verb, ...args) : script(verb, ...args)

export class SandboxCommands {
  readonly #boat: BoatClient
  readonly #pause: (ms: number) => Promise<void>

  constructor(client: BoatClient, pause: (ms: number) => Promise<void>) {
    this.#boat = client
    this.#pause = pause
  }

  /**
   * The workload's configuration, written through Boat's file endpoint, then put in place. `isNew`:
   * as for `run`.
   */
  async configure(id: string, key: string, spec: RuntimeSpec, isNew = false): Promise<void> {
    must(
      await this.#boat.PUT('/sandboxes/{sandboxId}/files', {
        params: { path: { sandboxId: id } },
        body: { path: NEXT_CONFIG, content: JSON.stringify(workloadConfig(spec, key)) },
      }),
      'writing the configuration',
    )
    await this.run(id, 'configure', [specDigest(spec), spec.image], JOB_SECONDS, isNew)
  }

  /**
   * One verb of the sandbox's program; what followed its "ok". A short one is one command; a long
   * one runs detached and is polled, since Boat holds a command for ten minutes at most. One that
   * answers "wait", its sandbox still bringing the workload back after a resume, is asked again at
   * once, up to WAITS times. `isNew`: the sandbox was never saved (`neverSaved`), so it has
   * nothing coming back to wait for.
   */
  async run(
    id: string,
    verb: Verb,
    args: readonly string[] = [],
    seconds = 180,
    isNew = false,
  ): Promise<string> {
    const command = commandOf(verb, args, isNew)
    for (let waits = 0; ; waits++) {
      const said = await this.#ask(id, verb, command, seconds)
      if (said.startsWith('ok')) return said.slice(2).trim()
      if (waits >= WAITS) throw new Error(`The sandbox couldn't ${verb}: ${said.slice(4).trim()}`)
    }
  }

  /** The program's last line, "ok …" or "wait …", asked again where it reached no verdict. */
  async #ask(id: string, verb: Verb, command: string, seconds: number): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      // Every verb ends where it would have from wherever it stopped, so one Boat dropped (502) or
      // one whose program never reached its own verdict is simply asked again: both were seen just
      // after a sandbox rebooted (2026-09-28).
      const result = await (seconds <= SYNC_SECONDS
        ? this.exec(id, command, seconds)
        : this.#job(id, command, seconds)
      ).catch((error: unknown) => {
        if (attempt < 3 && error instanceof BoatApiError && error.status >= 502 && error.status <= 504)
          return null
        throw error
      })
      const last = result?.stdout.trim().split('\n').at(-1) ?? ''
      if (last.startsWith('ok') || last.startsWith('wait')) return last
      if (result !== null && last.startsWith('failed'))
        throw new Error(`The sandbox couldn't ${verb}: ${last.slice(6).trim()}`)
      if (attempt >= 3)
        throw new Error(
          `The sandbox couldn't ${verb}: exit ${result?.exitCode ?? '?'} (${`${result?.stdout ?? ''} ${result?.stderr ?? ''}`.trim().slice(-300)})`,
        )
      await this.#pause(3000)
    }
  }

  /** A command in the sandbox, once Boat will take one: it refuses them while it is still coming up. */
  async exec(id: string, command: string, timeoutSeconds: number): Promise<ExecResult> {
    for (let attempt = 0; ; attempt++) {
      const ran = await this.#boat.POST('/sandboxes/{sandboxId}/commands', {
        params: { path: { sandboxId: id } },
        body: { command, timeoutSeconds: Math.min(600, Math.max(1, Math.ceil(timeoutSeconds))) },
      })
      if (ran.response.status === 409 && attempt < 30) {
        await this.#pause(2000)
        continue
      }
      const done = must(ran, 'running a command') as {
        exitCode?: number | null
        stdout?: string
        stderr?: string
      }
      return { exitCode: done.exitCode ?? -1, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
    }
  }

  async #job(id: string, command: string, seconds: number): Promise<ExecResult> {
    const started = must(
      await this.#boat.POST('/sandboxes/{sandboxId}/commands', {
        params: { path: { sandboxId: id } },
        body: { command, detached: true },
      }),
      'starting a command',
    ) as { processId?: number }
    if (started.processId === undefined) throw new Error('Boat started a command without saying which')
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      await this.#pause(3000)
      const status = must(
        await this.#boat.GET('/sandboxes/{sandboxId}/commands/{processId}', {
          params: { path: { sandboxId: id, processId: started.processId } },
        }),
        'reading a command',
      )
      if (!status.running)
        return { exitCode: status.exitCode ?? -1, stdout: status.stdout ?? '', stderr: status.stderr ?? '' }
    }
    throw new Error(`A command in the sandbox ran past ${Math.round(seconds / 60)} minutes`)
  }
}
