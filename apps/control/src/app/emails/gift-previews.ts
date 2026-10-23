// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Each gift email filled in with an example, as the tests read them (emails.test.ts) and as a
 * person looks at them rendered. The From name and note are what a buyer might type, a tag, a web
 * address and an email address among them, so a preview shows what reaches the recipient.
 *
 * Not for sending: nothing here is a real gift.
 */
import type { Email } from '../emails.ts'
import {
  giftBounced,
  giftEnded,
  giftPaid,
  giftReminder,
  giftStarted,
  giftToHand,
  giftWaiting,
} from './gifts.ts'

type GiftPreview = {
  name: string
  email: Email
  subject: string
  shape: 'layout' | 'plain'
  figure?: string
  /** The one link it leads to. */
  link: string
}

const PLUS = { planKey: 'plus', months: 1 }
const FROM = 'Sam <b>'
const NOTE =
  'Happy birthday! Build us a castle on www.example.com, or mail me at sam@example.com. See you on Saturday.'

export function giftPreviews(origin: string): GiftPreview[] {
  const manage = `${origin}/gift/manage/gm_4Tq9`
  const claim = `${origin}/gift/claim/gc_8Hw2`
  return [
    {
      name: 'gift paid',
      email: giftPaid({ ...PLUS, to: 'alex@example.com', paidCents: 2500, manage }),
      subject: 'Your Cubepals gift is on its way',
      shape: 'plain',
      link: manage,
    },
    {
      name: 'gift to hand',
      email: giftToHand({ ...PLUS, code: 'BLKY-7Q4M-2XRT', manage, origin }),
      subject: 'Your Cubepals gift code: a month of Plus',
      shape: 'plain',
      link: manage,
    },
    {
      name: 'gift waiting',
      email: giftWaiting({ ...PLUS, from: FROM, note: NOTE, account: false, claim }),
      subject: 'Sam <b> sent you a month of Plus on Cubepals',
      shape: 'plain',
      link: claim,
    },
    {
      name: 'gift waiting, on an account',
      email: giftWaiting({ ...PLUS, from: FROM, account: true, claim }),
      subject: 'Sam <b> sent you a month of Plus on Cubepals',
      shape: 'plain',
      link: claim,
    },
    {
      name: 'gift started',
      email: giftStarted({ ...PLUS, from: FROM, endsAt: new Date('2026-11-23T00:00:00Z'), origin }),
      subject: 'Your gift of Plus has started',
      shape: 'layout',
      figure: 'moss-waving.gif',
      link: `${origin}/servers`,
    },
    {
      name: 'gift bounced',
      email: giftBounced({ ...PLUS, to: 'alex@exmaple.com', manage }),
      subject: 'Your Cubepals gift couldn’t be delivered',
      shape: 'plain',
      link: manage,
    },
    {
      name: 'gift reminder',
      email: giftReminder({ ...PLUS, from: FROM, account: false, claim }),
      subject: 'Your gift from Sam <b> is still waiting',
      shape: 'plain',
      link: claim,
    },
    {
      name: 'gift refunded',
      email: giftEnded({ ...PLUS, how: 'refunded', refundedCents: 2500, to: 'alex@example.com', origin }),
      subject: 'Your Cubepals gift was refunded',
      shape: 'plain',
      link: `${origin}/contact`,
    },
    {
      name: 'gift cancelled',
      email: giftEnded({ ...PLUS, how: 'voided', to: 'alex@example.com', origin }),
      subject: 'Your Cubepals gift was cancelled',
      shape: 'plain',
      link: `${origin}/contact`,
    },
  ]
}
