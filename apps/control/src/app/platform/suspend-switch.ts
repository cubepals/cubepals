// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether servers put to sleep on Fly are suspended rather than stopped, as admins switch it at
 * runtime: stored on the platform controls' row, FLY_SUSPEND deciding while nothing is stored.
 * The Fly runtime asks at each sleep, so a change applies to the next one; waking never asks,
 * since a suspended machine resumes and a stopped one boots either way. What a sleep does with
 * the answer is the runtime's (`infra/fly/fly-runtime.ts`).
 */
import type { FlySuspendView } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Actor, requestedBy, runsThePlatform } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'

/** How long an answer is kept: another process sees a change at its next sleep after this. */
const TTL_MS = 10_000

export class SuspendSwitch {
  readonly #db: Db
  readonly #fallback: boolean | null
  readonly #ttlMs: number
  readonly #now: () => number
  #cached: { on: boolean; until: number } | null = null

  constructor(deps: {
    db: Db
    /** FLY_SUSPEND as configured; null where this deployment runs no Fly runtime. */
    fallback: boolean | null
    ttlMs?: number
    now?: () => number
  }) {
    this.#db = deps.db
    this.#fallback = deps.fallback
    this.#ttlMs = deps.ttlMs ?? TTL_MS
    this.#now = deps.now ?? Date.now
  }

  /** Whether the next sleep suspends. A database that won't answer leaves it to FLY_SUSPEND. */
  async on(): Promise<boolean> {
    const now = this.#now()
    if (this.#cached !== null && this.#cached.until > now) return this.#cached.on
    const stored = await this.#stored().catch((error: unknown) => {
      console.warn('fly suspend: read FLY_SUSPEND, the stored switch did not answer', error)
      return null
    })
    const on = stored ?? this.#fallback ?? false
    this.#cached = { on, until: now + this.#ttlMs }
    return on
  }

  /** The switch as the platform page shows it; null where this deployment runs no Fly runtime. */
  async view(actor: Actor): Promise<FlySuspendView | null> {
    if (!runsThePlatform(actor)) throw new NotFound('Platform')
    if (this.#fallback === null) return null
    const stored = await this.#stored()
    return {
      on: stored ?? this.#fallback,
      source: stored === null ? 'default' : 'stored',
      default: this.#fallback,
    }
  }

  /** On or off, or null to leave it to FLY_SUSPEND again; audited with what it was before. */
  async set(actor: Actor, on: boolean | null): Promise<void> {
    if (!runsThePlatform(actor)) throw new NotFound('Platform')
    if (this.#fallback === null)
      throw new AppError('invalid_choice', 'This deployment runs no servers on Fly.')
    await this.#db.transaction(async (tx) => {
      const controls = schema.platformControls
      const [row] = await tx
        .select({ flySuspend: controls.flySuspend })
        .from(controls)
        .where(eq(controls.id, 1))
        .for('update')
      const before = row?.flySuspend ?? null
      if (before === on) return
      await tx
        .update(controls)
        .set({ flySuspend: on, updatedBy: requestedBy(actor), updatedAt: new Date() })
        .where(eq(controls.id, 1))
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'platform.fly_suspend_changed',
        subjectType: 'platform',
        subjectId: 'controls',
        data: { from: before, to: on, default: this.#fallback },
      })
    })
    this.#cached = null
  }

  async #stored(): Promise<boolean | null> {
    const [row] = await this.#db
      .select({ flySuspend: schema.platformControls.flySuspend })
      .from(schema.platformControls)
      .where(eq(schema.platformControls.id, 1))
    return row?.flySuspend ?? null
  }
}
