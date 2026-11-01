// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Trial notices use the real account entitlement and template, and skip inapplicable owners. */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { entitlementsFor, PAID_PLANS, planName } from '../../domain/account/entitlements.ts'
import { installUnsoldPlans, planOnSaleHere } from '../../domain/account/on-sale.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { emailOf } from '../accounts/persistence.ts'
import { friendTurnedAway } from '../emails/play.ts'
import { CameByNotice } from './came-by-notice.ts'

let h: Harness
const origin = 'https://notice.example.test'
beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness()
  installUnsoldPlans([])
}, 30 * SECOND_MS)
afterAll(async () => {
  installUnsoldPlans([])
  await h?.close()
})

for (const onSale of [true, false]) {
  test.skipIf(!hasDatabase)(
    `the complete owner notice reflects a paid plan ${onSale ? 'on' : 'off'} sale`,
    async () => {
      const owner = await h.user('Notice owner', 'free')
      const server = { id: crypto.randomUUID(), name: 'Moss <and> Wood', ownerId: owner.userId }
      const player = { name: 'Alex & Sam' }
      const before = h.mail.sent.length
      installUnsoldPlans(onSale ? [] : PAID_PLANS)
      try {
        const paid = planOnSaleHere()
        const hours = paid === null ? null : entitlementsFor(paid).includedUnits
        const trialHours = entitlementsFor('free').totalUnits
        if (trialHours === null) throw new Error('The Free fixture must have a trial block')
        const to = await emailOf(h.db, owner.userId)
        if (to === null) throw new Error('The fixture owner must have an email address')
        const expected = friendTurnedAway({
          player: player.name,
          server,
          trialHours,
          paid: paid === null || hours === null ? null : { name: planName(paid), hours },
          origin,
        })
        await new CameByNotice({ db: h.db, mailer: h.mail, webOrigin: origin }).friendCame(server, player)
        expect(h.mail.sent.slice(before)).toEqual([
          {
            to,
            subject: expected.subject,
            text: expected.text,
            html: expected.html,
          },
        ])
        expect(paid === null).toBe(!onSale)
      } finally {
        installUnsoldPlans([])
      }
    },
    30 * SECOND_MS,
  )
}

test.skipIf(!hasDatabase)(
  'paid and missing accounts receive no trial notice or error',
  async () => {
    const paid = await h.user('Paid owner', 'plus')
    const missing = crypto.randomUUID()
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    const before = h.mail.sent.length
    try {
      const notice = new CameByNotice({ db: h.db, mailer: h.mail, webOrigin: origin })
      for (const ownerId of [paid.userId, missing])
        await notice.friendCame({ id: crypto.randomUUID(), name: 'Skipped', ownerId }, { name: 'Alex' })
      expect(h.mail.sent).toHaveLength(before)
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'a mail transport failure is logged with its server and does not escape',
  async () => {
    const owner = await h.user('Mail failure', 'free')
    const server = { id: crypto.randomUUID(), name: 'Kept world', ownerId: owner.userId }
    const failure = new Error('Fixture mail transport is unavailable')
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const notice = new CameByNotice({
        db: h.db,
        webOrigin: origin,
        mailer: {
          send: async () => {
            throw failure
          },
        },
      })
      await expect(notice.friendCame(server, { name: 'Alex' })).resolves.toBeUndefined()
      expect(logged).toHaveBeenCalledWith(`came-by notice for ${server.id} failed`, failure)
    } finally {
      logged.mockRestore()
    }
  },
  30 * SECOND_MS,
)
