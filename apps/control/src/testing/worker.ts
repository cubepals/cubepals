// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The worker that runs server operations in the harness, on a pg-boss of its own, so a test can
 * end it as a restart does and start another: killed, as a process is that gets no chance to say
 * so, or stopped, as a deploy stops one. Queues, retries and upkeep stay the harness's own
 * pg-boss's.
 */

import pg from 'pg'
import { PgBoss } from 'pg-boss'
import type { ControlPlane } from '../app/control-plane.ts'
import { OPERATION_HEARTBEAT_SECONDS, workServerOperations } from '../infra/pg/jobs.ts'

/** How a worker ends: `killed`, or stopped with `drainMs` for what it runs to finish. */
export type WorkerEnd = 'killed' | { drainMs: number }

export interface OperationsWorker {
  /** Ends this worker as asked and starts a new one in its place, as a restart brings one. */
  restart(ended: WorkerEnd): Promise<void>
  /** Every worker gone, at once: the harness is closing. */
  stop(): Promise<void>
}

export async function startOperationsWorker(url: string, app: ControlPlane): Promise<OperationsWorker> {
  let current = await oneWorker(url, app)
  // A killed worker's pg-boss still runs, asking and failing, until the harness closes.
  const killed: Array<Awaited<ReturnType<typeof oneWorker>>> = []
  return {
    async restart(ended) {
      if (ended === 'killed') {
        current.kill()
        killed.push(current)
      } else await current.stop(ended.drainMs)
      current = await oneWorker(url, app)
    },
    async stop() {
      for (const worker of [current, ...killed]) await worker.stop()
    },
  }
}

async function oneWorker(url: string, app: ControlPlane) {
  const pool = new pg.Pool({ connectionString: url, max: 4 })
  let killed = false
  const boss = new PgBoss({
    // Killed, its connection is cut: what it holds stays claimed, its heartbeats stop and nothing
    // it was doing settles.
    db: {
      executeSql: async (text: string, values?: unknown[]) => {
        if (killed) throw new Error('This worker is gone')
        return pool.query(text, values)
      },
    },
    schema: 'pgboss',
    supervise: false,
    schedule: false,
  })
  boss.on('error', (error: unknown) => {
    if (!killed) console.error('pg-boss', error)
  })
  await boss.start()
  // As main.node.ts's worker starts: what an earlier one was running when it stopped is taken
  // back now, and again once the heartbeat it may have sent just before has lapsed.
  await app.stuck.takeBack()
  const again = setTimeout(() => void app.stuck.takeBack(), (OPERATION_HEARTBEAT_SECONDS + 1) * 1000)
  await workServerOperations(
    boss,
    (attempt) => app.runner.run(attempt),
    { concurrency: 4, wakeConcurrency: 2 },
    0.5,
  )
  return {
    kill() {
      killed = true
      clearTimeout(again)
    },
    /** What it runs has `drainMs` to finish, then is handed back; with none, or once killed, at once. */
    async stop(drainMs?: number) {
      clearTimeout(again)
      const graceful = drainMs !== undefined && !killed
      await boss.stop(graceful ? { graceful, timeout: drainMs } : { graceful })
      await pool.end()
    },
  }
}
