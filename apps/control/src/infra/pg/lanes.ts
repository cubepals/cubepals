// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The workers of the server operations queue's lanes (`workServerOperations` in jobs.ts), of which
 * only one in each lane waits for work. pg-boss has every worker it runs ask the database on its
 * own, so forty that each asked every second asked forty times a second for nothing. Here a lane
 * starts with one worker, adds one the moment its waiting one takes an operation, up to its size,
 * and lets one go when an operation ends and another already waits.
 *
 * A job sent wakes the waiting workers at once (pg-boss's LISTEN/NOTIFY), and they otherwise ask
 * only now and then. pg-boss announces nothing else, so what an operation ending makes ready is
 * asked for here: the worker that ran it asks again as soon as pg-boss has settled it, which takes
 * its server's next operation when that is for its lane; every lane asks a moment later, for one
 * that is the other lane's; and an attempt that failed is asked for again when its retry is due.
 * Not for what an operation does (`app/operations/runner.ts`), or how jobs are sent (jobs.ts).
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import type { Job, PgBoss, WorkOptions } from 'pg-boss'

/** One worker, known by its pg-boss id once pg-boss has given it. */
interface Worker {
  id?: string
  /** Let go while it asked: one that took a job as it was runs it, then stops. */
  letGo?: true
}

/**
 * How long after an operation ends every lane asks again: pg-boss settles its job just after it
 * ends, with one statement, well inside this.
 */
const SETTLE_MS = SECOND_MS

export class Lanes {
  readonly #boss: PgBoss
  readonly #queue: string
  readonly #lanes: Lane[] = []

  constructor(boss: PgBoss, queue: string) {
    this.#boss = boss
    this.#queue = queue
  }

  /** A lane of up to `size` workers, each working one job at a time with `handle`. */
  async open(options: WorkOptions, size: number, handle: (job: Job) => Promise<void>): Promise<void> {
    const lane = new Lane(this.#boss, this.#queue, options, size, handle, (job, failed) => {
      if (failed) this.#retried(job.id)
      setTimeout(() => this.#askAll(), SETTLE_MS).unref()
    })
    this.#lanes.push(lane)
    await lane.add()
  }

  /** Every lane's waiting worker asks for work now. */
  #askAll(): void {
    for (const lane of this.#lanes) lane.ask()
  }

  /** Once the attempt that failed is settled, every lane asks again when its retry is due. */
  #retried(jobId: string): void {
    setTimeout(async () => {
      try {
        const [job] = await this.#boss.findJobs(this.#queue, { id: jobId })
        if (job?.state !== 'retry') return
        // A little after, as the database's clock and this one may differ by a moment.
        const due = job.startAfter.getTime() - Date.now()
        for (const after of [due + SETTLE_MS / 4, due + SETTLE_MS * 2])
          setTimeout(() => this.#askAll(), Math.max(0, after)).unref()
      } catch (error) {
        // Its retry is still asked for, by the waiting workers' own asking.
        console.error('pg-boss: a retry could not be looked up', error)
      }
    }, SETTLE_MS).unref()
  }
}

class Lane {
  readonly #boss: PgBoss
  readonly #queue: string
  readonly #options: WorkOptions
  readonly #size: number
  readonly #handle: (job: Job) => Promise<void>
  readonly #ended: (job: Job, failed: boolean) => void
  /** Workers waiting for work. */
  readonly #waiting = new Set<Worker>()
  /** Workers running a job or waiting for one. */
  #count = 0

  constructor(
    boss: PgBoss,
    queue: string,
    options: WorkOptions,
    size: number,
    handle: (job: Job) => Promise<void>,
    ended: (job: Job, failed: boolean) => void,
  ) {
    this.#boss = boss
    this.#queue = queue
    this.#options = options
    this.#size = size
    this.#handle = handle
    this.#ended = ended
  }

  async add(): Promise<void> {
    const worker: Worker = {}
    this.#count++
    this.#waiting.add(worker)
    try {
      worker.id = await this.#boss.work(
        this.#queue,
        { ...this.#options, batchSize: 1, localConcurrency: 1 },
        async ([job]: Job[]) => {
          if (job) await this.#run(worker, job)
        },
      )
    } catch (error) {
      this.#count--
      this.#waiting.delete(worker)
      throw error
    }
  }

  /** The waiting worker asks for work now, rather than when it would next. */
  ask(): void {
    for (const worker of this.#waiting) if (worker.id !== undefined) this.#boss.notifyWorker(worker.id)
  }

  /**
   * Runs `job`, and hands pg-boss the run as it is. The worker is free again once pg-boss is done
   * with it: when the run ends, or when pg-boss gives up on one past its deadline, which may still
   * be running here. pg-boss's own wait is `expireInSeconds`, at least a second
   * (`resolveWithinSeconds` in its tools.js), and this one is the same. The job's signal is no
   * guide: it is aborted too when the job's claim is lost (a lapsed heartbeat, `takeBack`, an
   * admin settling it), while pg-boss's worker still waits on the handler.
   */
  #run(worker: Worker, job: Job): Promise<void> {
    // One let go as it took this job counts again while it runs it, and needs no worker added: the
    // one whose finishing let it go waits.
    if (worker.letGo) this.#count++
    this.#waiting.delete(worker)
    // None waits now: another does, unless the lane is full.
    if (!worker.letGo && this.#waiting.size === 0 && this.#count < this.#size)
      this.add().catch((error: unknown) => console.error('pg-boss: a worker could not be added', error))
    const run = this.#handle(job)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(1, job.expireInSeconds) * SECOND_MS)
    })
    void Promise.race([
      run.then(
        () => false,
        () => true,
      ),
      deadline,
    ]).then((failed) => {
      clearTimeout(timer)
      this.#freed(worker)
      this.#ended(job, failed)
    })
    return run
  }

  #freed(worker: Worker): void {
    if (worker.letGo) {
      this.#count--
      return
    }
    const spare = [...this.#waiting].find((w) => w.id !== undefined)
    if (spare !== undefined) this.#letGoOf(spare)
    this.#waiting.add(worker)
    // Asks again as soon as this job is settled, rather than after its pause.
    if (worker.id !== undefined) this.#boss.notifyWorker(worker.id)
  }

  #letGoOf(worker: Worker): void {
    worker.letGo = true
    this.#waiting.delete(worker)
    this.#count--
    this.#boss
      .offWork(this.#queue, { id: worker.id, wait: false })
      .catch((error: unknown) => console.error('pg-boss: a worker could not be let go', error))
  }
}
