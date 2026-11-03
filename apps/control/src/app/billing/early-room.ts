// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Room for checkouts at an early price, as an operator sets it on the controls row: the room in
 * points, the points one checkout of each plan takes, and when it is due to be set again. What the
 * room should be is decided outside the control plane; here it is only kept and capped. A setting
 * holds until the next one replaces it, past its due time too: when its setter stops, the room
 * stays as last set, and checkouts paid since keep counting against it.
 * Each change of room or points is audited.
 *
 * An admin can close it, and it stays closed, whatever is set, until one opens it again
 * (`setEarlyClosed`). It decides no checkout's price, which is read from it.
 */
import { HOUR_MS } from '@blockly/contracts/durations'
import { type Db, type Queryable, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { AppError } from '../errors.ts'

/** The plans a checkout at an early price can be for, each with its own points. */
const EARLY_PLANS = ['core', 'plus'] as const
export type EarlyPlan = (typeof EARLY_PLANS)[number]

export interface EarlyRoom {
  roomPoints: number
  /** What one checkout of each plan takes from the room. */
  points: Record<EarlyPlan, number>
  /** When it is due to be set again; past it, it still holds. Null before any was set. */
  validUntil: Date | null
  /**
   * When the figures it was worked out from were read, as its setter said, or else when it was set.
   * A checkout paid after this is in no figure it was worked out from yet.
   */
  setAt: Date | null
  /** When an admin closed it, and who: while closed, it counts as none. Null while open. */
  closedSince: Date | null
  closedBy: string | null
}

/**
 * How far ahead the next setting may be due. Settings are meant to come every few minutes, so a due
 * time further out is refused: a setter that stops shows as overdue on the platform page within this.
 */
const EARLY_ROOM_MOST_AHEAD_MS = 2 * HOUR_MS

const controls = schema.platformControls

/** Who the audit log says set it. */
const EARLY_ROOM_SETTER = 'system:early-room'

/** The room as the controls row holds it. */
export async function readEarlyRoom(q: Queryable): Promise<EarlyRoom> {
  const [row] = await q
    .select({
      roomPoints: controls.earlyRoomPoints,
      core: controls.earlyPointsCore,
      plus: controls.earlyPointsPlus,
      validUntil: controls.earlyValidUntil,
      setAt: controls.earlyRoomSetAt,
      closedSince: controls.earlyClosedSince,
      closedBy: controls.earlyClosedBy,
    })
    .from(controls)
    .where(eq(controls.id, 1))
  if (!row) throw new Error('platform_controls has no row; run the migrations')
  return {
    roomPoints: row.roomPoints,
    points: { core: row.core, plus: row.plus },
    validUntil: row.validUntil,
    setAt: row.setAt,
    closedSince: row.closedSince,
    closedBy: row.closedBy,
  }
}

/** The room there is now: as last set (none before one was), or none while an admin has it closed. */
export const roomNow = (room: EarlyRoom): number => (room.closedSince === null ? room.roomPoints : 0)

/**
 * An admin closes the early price now, or opens it again: closed, the room counts as none whatever
 * is set from outside, and nobody's price already paid changes. Audited with who did it.
 */
export async function setEarlyClosed(db: Db, by: string, closed: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: controls.id }).from(controls).where(eq(controls.id, 1)).for('update')
    const before = await readEarlyRoom(tx)
    if ((before.closedSince !== null) === closed) return
    await tx
      .update(controls)
      .set(
        closed
          ? { earlyClosedSince: new Date(), earlyClosedBy: by }
          : { earlyClosedSince: null, earlyClosedBy: null },
      )
      .where(eq(controls.id, 1))
    await tx.insert(schema.auditLog).values({
      actor: by,
      action: closed ? 'platform.early_room_closed' : 'platform.early_room_opened',
      subjectType: 'platform',
      subjectId: 'early_room',
      data: { roomPoints: before.roomPoints },
    })
  })
}

/** Sets the room, refusing what is past `maxPoints` or due again too far ahead. */
export class EarlyRoomControl {
  readonly #db: Db
  readonly #maxPoints: number

  constructor(deps: { db: Db; maxPoints: number }) {
    this.#db = deps.db
    this.#maxPoints = deps.maxPoints
  }

  /**
   * The room, the points of each plan and when it is due to be set again, all at once. Room above
   * the configured cap is refused, so a bug or a token in the wrong hands can't open more than that;
   * so are points no checkout could take (none, or more than the cap), and a due time already passed
   * or further ahead than `EARLY_ROOM_MOST_AHEAD_MS`. `readAt`, when the figures behind it were read,
   * is no later than now and no more than an hour before.
   */
  async set(
    next: { roomPoints: number; points: Record<EarlyPlan, number>; validUntil: Date; readAt?: Date },
    now = new Date(),
  ): Promise<EarlyRoom> {
    if (!Number.isInteger(next.roomPoints) || next.roomPoints < 0)
      throw new AppError('invalid_choice', 'Room is a whole number of points, 0 or more.')
    if (next.roomPoints > this.#maxPoints)
      throw new AppError('invalid_choice', `Room above ${this.#maxPoints} points is refused here.`)
    for (const plan of EARLY_PLANS) {
      const points = next.points[plan]
      if (!Number.isInteger(points) || points < 1 || points > this.#maxPoints)
        throw new AppError('invalid_choice', `A ${plan} checkout takes from 1 to ${this.#maxPoints} points.`)
    }
    if (next.validUntil <= now || next.validUntil.getTime() > now.getTime() + EARLY_ROOM_MOST_AHEAD_MS)
      throw new AppError('invalid_choice', 'The room is due to be set again within the next two hours.')
    const readAt = next.readAt ?? now
    if (readAt > now || readAt.getTime() < now.getTime() - HOUR_MS)
      throw new AppError('invalid_choice', 'The figures behind the room were read within the last hour.')
    return this.#db.transaction(async (tx) => {
      // One setting at a time, and none while a checkout takes from the room.
      await tx.select({ id: controls.id }).from(controls).where(eq(controls.id, 1)).for('update')
      const before = await readEarlyRoom(tx)
      await tx
        .update(controls)
        .set({
          earlyRoomPoints: next.roomPoints,
          earlyPointsCore: next.points.core,
          earlyPointsPlus: next.points.plus,
          earlyValidUntil: next.validUntil,
          earlyRoomSetAt: readAt,
        })
        .where(eq(controls.id, 1))
      // Renewing the same room only moves its time on: the log keeps what changed.
      const changed =
        before.roomPoints !== next.roomPoints ||
        EARLY_PLANS.some((plan) => before.points[plan] !== next.points[plan])
      if (changed)
        await tx.insert(schema.auditLog).values({
          actor: EARLY_ROOM_SETTER,
          action: 'billing.early_room_set',
          subjectType: 'platform',
          subjectId: 'early_room',
          data: {
            from: { roomPoints: before.roomPoints, points: before.points },
            to: { roomPoints: next.roomPoints, points: next.points },
            validUntil: next.validUntil.toISOString(),
          },
        })
      return readEarlyRoom(tx)
    })
  }
}
