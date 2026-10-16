// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The emails as extra play is used: the first time in a month an account plays past its included
 * hours on extra it allowed, then at four fifths of its limit and at all of it. Each is sent once a
 * month, recorded on the standing (`extraWarned`) the way `playWarned` records the included hours'
 * warnings. Counting the hours is `billing/extra-usage.ts`'s; stopping servers is `enforceLimits`'.
 */
import type { Db } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { UNIT_CENTS } from '../../domain/account/meter.ts'
import { DEFAULT_TIME_ZONE, monthOf } from '../../domain/account/play-day.ts'
import type { AccountStanding } from '../../domain/account/standing.ts'
import { meteredMonth } from '../billing/chip-in-meter.ts'
import { extraPlayNow } from '../billing/persistence.ts'
import { extraWarning } from '../emails/play.ts'
import type { Mailer } from '../ports/platform.ts'
import { emailOf, loadStanding, lockStanding, saveStanding } from './persistence.ts'

/** Per cent of the limit the owner allowed; 0 is the moment extra play starts being used. */
const EXTRA_WARN_AT = [0, 80, 100] as const

/** Sends the extra-play email the account is due, if any; answers the mark it sent. */
export async function warnAboutExtra(
  deps: { db: Db; mailer: Mailer; origin: string },
  userId: string,
  now = new Date(),
  read?: AccountStanding,
): Promise<number | null> {
  const standing = read ?? (await loadStanding(deps.db, userId, now))
  const plan = entitlementsFor(standing.plan, standing.limitOverrides)
  const { decision } = await extraPlayNow(deps.db, standing)
  if (!decision.may || decision.units === 0) return null
  const played = await meteredMonth(deps.db, standing, plan, now)
  if (played === null) return null
  const included = played.included + played.carried
  const used = played.units - included
  if (used <= 0) return null
  const share = (used / decision.units) * 100
  const reached = [...EXTRA_WARN_AT].reverse().find((mark) => share >= mark)
  if (reached === undefined) return null

  const month = monthOf(played.start, standing.timeZone ?? DEFAULT_TIME_ZONE).slice(0, 7)
  const [saidMonth, saidMark] = (standing.extraWarned ?? '').split(':')
  if (saidMonth === month && Number(saidMark) >= reached) return null

  const to = await emailOf(deps.db, userId)
  if (to !== null)
    await deps.mailer.send({
      to,
      ...extraWarning({
        mark: reached,
        included: Math.round(included * 10) / 10,
        allowed: decision.units,
        ceiling: decision.ceiling,
        used: Math.min(decision.units, Math.round(used * 10) / 10),
        unitCents: UNIT_CENTS,
        origin: deps.origin,
      }),
    })
  await deps.db.transaction(async (tx) => {
    const locked = await lockStanding(tx, userId)
    if (locked !== null) await saveStanding(tx, userId, { extraWarned: `${month}:${reached}` })
  })
  return reached
}
