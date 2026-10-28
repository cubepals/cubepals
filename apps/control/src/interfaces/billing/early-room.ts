// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The route that sets the room for early checkouts, on the public listener beside the billing
 * webhook, so a setter outside the control plane's network reaches it, behind a token of its own.
 * What the room is, and what it does, is `app/billing/early-room.ts`'s.
 */
import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { type EarlyPlan, type EarlyRoom, EarlyRoomControl } from '../../app/billing/early-room.ts'
import { AppError } from '../../app/errors.ts'

/** Where the room for early checkouts is set, on the public listener beside the billing webhook. */
export const EARLY_ROOM_PATH = '/api/billing/early-room'

const EarlyRoomInput = z.object({
  roomPoints: z.number().int().min(0),
  points: z.object({ core: z.number().int().min(1), plus: z.number().int().min(1) }) satisfies z.ZodType<
    Record<EarlyPlan, number>
  >,
  validUntil: z.iso.datetime({ offset: true }),
  /** When the figures behind the room were read; now, when not said. */
  readAt: z.iso.datetime({ offset: true }).optional(),
})

const view = (room: EarlyRoom) => ({
  roomPoints: room.roomPoints,
  points: room.points,
  validUntil: room.validUntil?.toISOString() ?? null,
  setAt: room.setAt?.toISOString() ?? null,
})

/**
 * `PUT /api/billing/early-room`: the room, each plan's points and until when they hold, in one
 * JSON body, behind its own bearer token (EARLY_ROOM_TOKEN), compared in constant time. That token
 * opens nothing else, and nothing else opens this. Answers what is held after it; a refusal says why.
 */
export function createEarlyRoomRoute(deps: { room: EarlyRoomControl; token: string }): Hono {
  const app = new Hono()
  const expected = Buffer.from(`Bearer ${deps.token}`)
  app.put(EARLY_ROOM_PATH, async (c) => {
    const given = Buffer.from(c.req.header('authorization') ?? '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return c.json({ error: 'unauthorized' }, 401)
    const body = EarlyRoomInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success)
      return c.json({ error: { code: 'invalid', message: z.prettifyError(body.error) } }, 400)
    try {
      const { validUntil, readAt, ...rest } = body.data
      const room = await deps.room.set({
        ...rest,
        validUntil: new Date(validUntil),
        ...(readAt === undefined ? {} : { readAt: new Date(readAt) }),
      })
      return c.json(view(room))
    } catch (error) {
      if (error instanceof AppError)
        return c.json({ error: { code: error.code, message: error.message } }, 400)
      throw error
    }
  })
  return app
}

/** The route, as configured: none at all without a token (EARLY_ROOM_TOKEN), so nothing can set room. */
export function earlyRoomRoute(
  db: ConstructorParameters<typeof EarlyRoomControl>[0]['db'],
  config: { token: string | null; maxPoints: number },
): Hono {
  if (config.token === null) return new Hono()
  return createEarlyRoomRoute({
    room: new EarlyRoomControl({ db, maxPoints: config.maxPoints }),
    token: config.token,
  })
}
