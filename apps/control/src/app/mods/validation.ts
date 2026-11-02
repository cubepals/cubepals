// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared mod-configuration verification, requested cheaply from APIs and executed on workers.
 * Successful evidence belongs to exact artifacts and runtime inputs; transient failures are not
 * incompatibility verdicts. Temporary resource identities are durable before provisioning begins.
 *
 * Parts:
 * - `validation-plan.ts`: stable configuration identity and the ordinary Minecraft runtime spec.
 * - `validation-runtime.ts`: isolated startup, readiness, loader and installation checks.
 * - `validation-records.ts`: resource ownership used by the normal orphan sweep.
 */
import { randomUUID } from 'node:crypto'
import type { ModValidationView } from '@blockly/contracts'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { type Db, type ModValidationPlanJson, schema } from '@blockly/db'
import { and, eq, notInArray } from 'drizzle-orm'
import type { JobQueue } from '../ports/jobs.ts'
import { LockBusy, type Locks } from '../ports/locks.ts'
import { runtimeKey } from '../ports/runtime.ts'
import { validationKey } from './validation-plan.ts'
import {
  DiagnosedMods,
  IncompatibleMods,
  type ValidationRuntimePorts,
  ValidationUnavailable,
  verifyModRuntime,
} from './validation-runtime.ts'

const UNAVAILABLE =
  'Cubepals couldn’t finish checking the server’s mods. Your world is safe; the check will be retried.'
const RETRY_AFTER_MS = MINUTE_MS

type ValidationPorts = ValidationRuntimePorts & {
  jobs: JobQueue
  locks: Locks
  learn: (
    plan: ModValidationPlanJson,
    found: import('../../minecraft/diagnosis.ts').Diagnosis,
  ) => Promise<boolean>
}

type Record = typeof schema.modValidations.$inferSelect

export class ModValidation {
  readonly #ports: ValidationPorts
  readonly #db: Db
  readonly #budgetMs: number

  constructor(ports: ValidationPorts) {
    this.#ports = ports
    this.#db = ports.db
    this.#budgetMs = ports.timeouts.runningMs + ports.timeouts.readyMs
  }

  /** Queueing is transactional and deduplicated. Reading a plan never waits for a server boot. */
  async request(plan: ModValidationPlanJson): Promise<ModValidationView> {
    const key = validationKey(plan)
    return this.#db.transaction(async (tx) => {
      await tx
        .insert(schema.modValidations)
        .values({ key, plan, runtimeId: randomUUID() })
        .onConflictDoNothing()
      const [record] = await tx.select().from(schema.modValidations).where(eq(schema.modValidations.key, key))
      if (record === undefined) throw new Error('The compatibility record disappeared')
      if (
        record.state === 'unavailable' &&
        Date.now() - (record.checkedAt?.getTime() ?? 0) >= RETRY_AFTER_MS
      ) {
        await tx
          .update(schema.modValidations)
          .set({ state: 'checking', message: null })
          .where(eq(schema.modValidations.key, key))
        record.state = 'checking'
        record.message = null
      }
      if (record.state === 'checking') await this.#ports.jobs.enqueueModValidation(tx, key)
      return view(record)
    })
  }

  /** Worker-side gate; concurrent callers share a check, including across API and worker machines. */
  async ensure(plan: ModValidationPlanJson): Promise<ModValidationView> {
    let result = await this.request(plan)
    const deadline = Date.now() + this.#budgetMs
    while (result.state === 'checking' && Date.now() < deadline) {
      await this.runImport(result.key).catch((error: unknown) => {
        if (!(error instanceof LockBusy)) throw new ValidationUnavailable(UNAVAILABLE, { cause: error })
      })
      result = await this.status(result.key)
      if (result.state === 'checking') await new Promise<void>((resolve) => setTimeout(resolve, SECOND_MS))
    }
    if (result.state === 'blocked')
      throw new IncompatibleMods(
        result.message ?? 'The server’s mods did not pass their compatibility check.',
      )
    if (result.state !== 'verified') throw new ValidationUnavailable(UNAVAILABLE)
    return result
  }

  async status(key: string): Promise<ModValidationView> {
    const [record] = await this.#db
      .select()
      .from(schema.modValidations)
      .where(eq(schema.modValidations.key, key))
    return record === undefined
      ? { key, state: 'unavailable', message: UNAVAILABLE, checkedAt: null }
      : view(record)
  }

  /** Same importer protocol as packs/worlds, so queue retries and final failure handling are shared. */
  async runImport(key: string): Promise<void> {
    await this.#ports.locks.hold(`mod-validation:${key}`, 0, async () => {
      const [record] = await this.#db
        .select()
        .from(schema.modValidations)
        .where(eq(schema.modValidations.key, key))
      if (record === undefined) return
      if (record.state === 'verified' || record.state === 'blocked') {
        if (record.handle !== null || record.leaseUntil !== null) await this.#cleanup(record)
        return
      }
      await this.#execute(record)
    })
  }

  async #execute(record: Record): Promise<void> {
    if (record.leaseUntil !== null) await this.#cleanup(record)
    const leaseUntil = new Date(Date.now() + this.#budgetMs)
    record.runtimeId = randomUUID()
    await this.#db.transaction(async (tx) => {
      await tx.insert(schema.modValidationRuns).values({ id: record.runtimeId, key: record.key, leaseUntil })
      await tx
        .update(schema.modValidations)
        .set({ state: 'checking', runtimeId: record.runtimeId, leaseUntil })
        .where(eq(schema.modValidations.key, record.key))
    })
    try {
      const evidence = await verifyModRuntime(this.#ports, record.plan, record.runtimeId, async (handle) => {
        await this.#db
          .update(schema.modValidations)
          .set({ handle })
          .where(eq(schema.modValidations.key, record.key))
      })
      await this.#db
        .update(schema.modValidations)
        .set({ state: 'verified', evidence, message: null, checkedAt: new Date() })
        .where(eq(schema.modValidations.key, record.key))
    } catch (error) {
      if (error instanceof DiagnosedMods) await this.#ports.learn(record.plan, error.found)
      const blocked = error instanceof IncompatibleMods
      await this.#db
        .update(schema.modValidations)
        .set({
          state: blocked ? 'blocked' : 'unavailable',
          message: blocked ? error.message : UNAVAILABLE,
          checkedAt: new Date(),
        })
        .where(eq(schema.modValidations.key, record.key))
      if (!blocked) throw error
    } finally {
      await this.#cleanup(record)
    }
  }

  async importGaveUp(key: string, _error: string): Promise<void> {
    await this.#db
      .update(schema.modValidations)
      .set({ state: 'unavailable', message: UNAVAILABLE, checkedAt: new Date() })
      .where(
        and(
          eq(schema.modValidations.key, key),
          notInArray(schema.modValidations.state, ['verified', 'blocked']),
        ),
      )
  }

  async #cleanup(record: Record): Promise<void> {
    await this.#ports.runtime.destroy(record.plan.provider, runtimeKey(record.runtimeId))
    await this.#db
      .update(schema.modValidationRuns)
      .set({ finishedAt: new Date() })
      .where(eq(schema.modValidationRuns.id, record.runtimeId))
    await this.#db
      .update(schema.modValidations)
      .set({ handle: null, leaseUntil: null })
      .where(eq(schema.modValidations.key, record.key))
  }
}

function view(record: Record): ModValidationView {
  return {
    key: record.key,
    state: record.state,
    message: record.message,
    checkedAt: record.checkedAt?.toISOString() ?? null,
  }
}
