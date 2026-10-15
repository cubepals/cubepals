// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server its runtime resumed, told apart as it comes back: as it was, answering at once; booting
 * from its disk, where the provider dropped the memory it kept; or hung, never running or frozen
 * where it was, which is given up on and started fresh (docs/resume-fallback.md). What a boot
 * then waits for, and what a start does once it is up, are `boot.ts`'s.
 */

import { inFull, PlainFailure } from '../errors.ts'
import type { GameEndpoint, ReadinessProbe } from '../ports/minecraft.ts'
import type { LogSource } from '../ports/platform.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import type { OperationContext } from './runner.ts'

/**
 * A machine whose resume hung and that then wouldn't stop or start again: wedged on its host, as
 * Fly's was for 15 hours (community.fly.io/t/28766), where only another machine helps
 * (`handlers/host-refused.ts`).
 */
export class StuckOnHost extends PlainFailure {
  constructor(options?: ErrorOptions) {
    super('Its computer stopped responding while it woke.', options)
    this.name = 'StuckOnHost'
  }
}

/**
 * How long a resumed server has to answer once it runs, before it counts as booting instead. A
 * resume answers within about 50 ms of running again, and a boot takes 40 s or more.
 */
const RESUME_MS = 10_000
/**
 * How long a resume has to come back before the memory kept for it is given up on (`#startFresh`).
 * Fly's resumes on staging all reached a player within 3.2 s, 2.3 s at p95, at 3 to 8 GB (60
 * wakes), and at 16 GB (5 wakes, 2026-10-15) were running within 0.95 s and answering within 1 s:
 * a resume doesn't take longer for more memory, so one bound serves every size. 30 s is over nine
 * times the slowest, so a slow resume is never cut off, and still short of a cold boot's answer
 * (35 to 45 s; 23 s at 16 GB, running after 3.3 s). A machine that got running at all has
 * `RESUME_MS` past it besides (`cameBack`), so one that boots from its disk isn't taken for hung.
 */
const RESUME_HUNG_MS = 30_000
/** The least a resuming server's ping is given to answer, once a verdict on it is due. */
const PING_MS = 2_000
/** How often a resuming server is pinged: it answers within about 50 ms of running again. */
const RESUME_PAUSE_MS = 200
/** Enough of the tail to hold whatever a boot printed in its first seconds. */
const LINES_READ = 50

export class Resume {
  readonly #runtime: Pick<Runtimes, 'waitRunning' | 'forceStop' | 'start'>
  readonly #probe: ReadinessProbe
  readonly #logs: LogSource
  readonly #hungMs: number

  constructor(deps: {
    runtime: Pick<Runtimes, 'waitRunning' | 'forceStop' | 'start'>
    probe: ReadinessProbe
    logs: LogSource
    /** `RESUME_HUNG_MS` by default; tests shorten it. */
    resumeMs?: number
  }) {
    this.#runtime = deps.runtime
    this.#probe = deps.probe
    this.#logs = deps.logs
    this.#hungMs = deps.resumeMs ?? RESUME_HUNG_MS
  }

  /**
   * Whether a server its runtime resumed came back as it was: running, and answering a status
   * ping within `RESUME_MS` of running, which no boot does. False where the provider dropped the
   * memory it kept and boots it from its storage instead (a deploy, a host move, maintenance), as
   * what it printed since `since` shows: the start goes on as a boot, whose output is then followed
   * from there, a few seconds into it. False too where the resume hung, once the machine is
   * started fresh (`#startFresh`).
   */
  async cameBack(
    ctx: OperationContext,
    handle: RuntimeHandle,
    endpoint: () => GameEndpoint,
    since = new Date(),
  ): Promise<boolean> {
    const hungAt = Date.now() + this.#hungMs
    const running = AbortSignal.timeout(this.#hungMs)
    let came: 'answered' | 'booting' | 'hung'
    try {
      await this.#runtime.waitRunning(handle, running)
      // Running at last, it has `RESUME_MS` to answer or print: a boot from its disk that got
      // running late in the bound is never cut off before its output could show it boots.
      came = await this.#answer(endpoint(), handle, since, Math.max(hungAt, Date.now() + RESUME_MS))
    } catch (error) {
      // Not running in time is a hung resume; a machine that stopped is the boot's to explain.
      if (!running.aborted) return false
      await this.#startFresh(ctx, handle, error)
      return false
    }
    if (came === 'hung')
      await this.#startFresh(ctx, handle, new Error('It ran, but answered and printed nothing'))
    return came === 'answered'
  }

  /**
   * How a resumed server that runs came back: `answered` a ping; `booting`, past `RESUME_MS`
   * without an answer and printing since `since`, as a boot from its disk does; or `hung` by
   * `hungAt`, answering nothing and printing nothing, frozen where it was. A log that can't be read
   * says nothing either way, and leaves it to boot.
   */
  async #answer(
    endpoint: GameEndpoint,
    handle: RuntimeHandle,
    since: Date,
    hungAt: number,
  ): Promise<'answered' | 'booting' | 'hung'> {
    const bootAt = Date.now() + RESUME_MS
    for (;;) {
      // Up to the first verdict, and never so short a ping can't be answered past it.
      const left = Math.max(PING_MS, Math.min(bootAt, hungAt) - Date.now())
      const answered = await this.#probe.ping(endpoint, AbortSignal.timeout(left)).then(
        () => true,
        () => false,
      )
      if (answered) return 'answered'
      const now = Date.now()
      if (now >= bootAt || now >= hungAt) {
        const lines = await this.#logs.recent(handle, LINES_READ).catch(() => null)
        const printed = lines === null || lines.some((line) => line.at >= since)
        if (printed && now >= bootAt) return 'booting'
        if (!printed && now >= hungAt) return 'hung'
      }
      await new Promise((resolve) => setTimeout(resolve, RESUME_PAUSE_MS))
    }
  }

  /**
   * A resume that never came back: the memory its provider kept is given up on, and the machine
   * is killed, which drops it, and started from its storage. Nothing played is lost: a server
   * sleeps only once its world is saved and written through to its disk (`winding-down.ts`), and
   * nobody plays on it while it sleeps. The operation keeps it for the platform's alert
   * (`resumes_hung`). A machine that won't be killed or started again is stuck on its host.
   */
  async #startFresh(ctx: OperationContext, handle: RuntimeHandle, error: unknown): Promise<void> {
    console.warn(
      `operation ${ctx.op.kind} ${ctx.op.id}: its resume didn't come back, starting it fresh (${inFull(error)})`,
    )
    await ctx.mark('resume_hung')
    try {
      await this.#runtime.forceStop(handle)
      await this.#runtime.start(handle)
    } catch (again) {
      throw new StuckOnHost({ cause: again })
    }
  }
}
