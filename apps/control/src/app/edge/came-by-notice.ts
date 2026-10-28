// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Telling an owner by email that a friend came to their server while it rested for their free
 * trial, played:
 * once a rest, for the first friend it kept away (`turned-away.ts` says which), after the session
 * that kept them is stored. Anyone after is on the server's page, not in another email. It comes
 * from the address nobody reads (MAIL_NOTICE_FROM). Not for whether the server rests, or for what
 * the friend is told (the edge's).
 */
import type { Db } from '@blockly/db'
import { entitlementsFor, entitlementsOf, planName } from '../../domain/account/entitlements.ts'
import { planOnSaleHere } from '../../domain/account/on-sale.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { emailOf, loadStanding } from '../accounts/persistence.ts'
import { playTotal } from '../accounts/play-total.ts'
import { friendTurnedAway } from '../emails/play.ts'
import type { Mailer } from '../ports/platform.ts'

export class CameByNotice {
  readonly #db: Db
  readonly #mailer: Mailer
  readonly #webOrigin: string

  constructor(deps: { db: Db; mailer: Mailer; webOrigin: string }) {
    this.#db = deps.db
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
  }

  /**
   * Tells the owner of `server` that `player` came while it rested for their free trial. It never
   * throws: a failed send is logged, and the session it was told in stands.
   */
  async friendCame(
    server: Pick<MinecraftServer, 'id' | 'name' | 'ownerId'>,
    player: { name: string },
  ): Promise<void> {
    try {
      const to = await emailOf(this.#db, server.ownerId)
      const trialHours = await this.#trialHours(server.ownerId, new Date())
      if (to === null || trialHours === null) return
      // What brings it back: the plan by the month on sale here, with its own hours.
      const paid = planOnSaleHere()
      const monthly = paid === null ? null : entitlementsFor(paid).includedUnits
      const email = friendTurnedAway({
        player: player.name,
        server: { id: server.id, name: server.name },
        trialHours,
        paid: paid === null || monthly === null ? null : { name: planName(paid), hours: monthly },
        origin: this.#webOrigin,
      })
      await this.#mailer.send({
        to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        notice: true,
      })
    } catch (error) {
      console.error(`came-by notice for ${server.id} failed`, error)
    }
  }

  /** The free trial's hours in all, as the owner's plan says them; null once it counts none. */
  async #trialHours(ownerId: string, now: Date): Promise<number | null> {
    const standing = await loadStanding(this.#db, ownerId, now)
    const total = await playTotal(this.#db, standing, entitlementsOf(standing), now)
    return total === null ? null : total.included
  }
}
