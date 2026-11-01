// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The complete messages at play and spending boundaries. Each case names the hours, price,
 * next action and promise an owner reads, including text-only mail and escaped player names.
 * The shared layout is exercised separately; these contracts hold the template's whole output.
 */
import { afterAll, expect, test } from 'bun:test'
import { PAID_PLANS } from '../../domain/account/entitlements.ts'
import { installUnsoldPlans, planOnSaleHere } from '../../domain/account/on-sale.ts'
import { ACCOUNT, type Email, INK, layout, meter, OWNER, p } from '../emails.ts'
import { extraWarning, freeHoursWarning, friendTurnedAway, playWarning } from './play.ts'

const origin = 'https://mail.example.test'
const account = `${origin}/account`
const reply = 'Reply if you want to keep playing and something’s in the way.'
const asleep = { label: 'Asleep until the 1st', tone: 'sleeping' as const }

afterAll(() => installUnsoldPlans([]))

function message(
  actual: Email,
  expected: {
    subject: string
    preheader: string
    heading: string
    lines: string[]
    gauge?: string
    action: { label: string; url: string }
    chip?: Parameters<typeof layout>[0]['chip']
  },
) {
  expect(actual).toEqual({
    subject: expected.subject,
    preheader: expected.preheader,
    text: [...expected.lines, '', expected.action.url].join('\n'),
    html: layout({
      origin,
      preheader: expected.preheader,
      heading: expected.heading,
      body: (expected.gauge ?? '') + expected.lines.map(p).join(''),
      action: expected.action,
      chip: expected.chip,
      why: ACCOUNT,
    }),
  })
}

const larger = { name: 'Forest', extraHoursCheaper: 37 }
const largerWords =
  'Extra hours are $0.31 each. Past 37 extra hours a month, Forest costs less, and has more hours.'

test('monthly warnings count carry, round hours and offer only permitted spending', () => {
  const base = {
    mark: 80,
    included: 10,
    carried: 0,
    used: 8,
    extraAllowed: 0,
    mayBuyMore: false,
    unitCents: 31,
    origin,
  }
  for (const sample of [
    { used: 9.6, left: 0.4, words: 'less than an hour' },
    { used: 9, left: 1, words: 'about an hour' },
    { used: 7.7, left: 2.3, words: 'about 2 hours' },
  ]) {
    message(playWarning({ ...base, used: sample.used }), {
      subject: `${sample.words[0]?.toUpperCase()}${sample.words.slice(1)} of play left this month`,
      preheader: 'Just so the 1st is never a surprise.',
      heading: 'This month’s play is running low',
      lines: [
        `You have ${sample.words} left of the 10 hours of play your plan includes this month. A large server uses them twice as fast.`,
        'When they run out, your servers sleep until the 1st. Nothing is charged unless you allow it.',
      ],
      gauge: meter(sample.left, 10, 'left'),
      action: { label: 'Open your account', url: account },
    })
  }
  message(playWarning({ ...base, carried: 3, used: 10, mayBuyMore: true, larger }), {
    subject: 'About 3 hours of play left this month',
    preheader: 'Just so the 1st is never a surprise.',
    heading: 'This month’s play is running low',
    lines: [
      'You have about 3 hours left of your 13 hours of play this month: 10 from your plan and 3 left from last month. A large server uses them twice as fast.',
      'When they run out, your servers sleep until the 1st, unless you allow some extra play. Nothing is charged unless you allow it.',
      largerWords,
    ],
    gauge: meter(3, 13, 'left'),
    action: { label: 'Open your account', url: account },
  })
  // A larger plan is not offered when this account cannot buy extra play.
  expect(playWarning({ ...base, larger })).toEqual(playWarning(base))
  for (const [carried, extraAllowed, mayBuyMore] of [
    [0, 0, false],
    [0, 0, true],
    [0, 4, false],
    [0, 4, true],
    [3, 0, false],
    [3, 0, true],
    [3, 4, false],
    [3, 4, true],
  ] as const) {
    const lines = [
      carried === 0
        ? 'This month’s 10 hours of play are used up.'
        : 'This month’s 10 hours of play, and the 3 left from last month, are used up.',
      extraAllowed === 0
        ? 'Your servers are asleep until the 1st. Nothing was charged: Cubepals only spends what you allow.'
        : 'You allowed up to 4 hours past them, so your servers keep running until those are used too.',
    ]
    if (mayBuyMore && extraAllowed === 0)
      lines.push('If you want them back before then, allow some extra play on your account.')
    lines.push(largerWords)
    message(playWarning({ ...base, mark: 100, used: 14, carried, extraAllowed, mayBuyMore, larger }), {
      subject: 'Your Cubepals servers are asleep until the 1st',
      preheader: 'Nothing was charged.',
      heading: 'This month’s play is used up',
      lines,
      gauge: meter(0, 10 + carried, 'left'),
      chip: extraAllowed === 0 ? asleep : undefined,
      action: {
        label: extraAllowed === 0 && mayBuyMore ? 'Allow extra play' : 'Open your account',
        url: account,
      },
    })
  }
})

test('extra-hour messages preserve prices, caps and each warning boundary', () => {
  const base = { included: 17, allowed: 7, ceiling: 9, used: 2.25, unitCents: 31, plan: 'Forest', origin }
  message(extraWarning({ ...base, mark: 0 }), {
    subject: 'You’re on extra hours now',
    preheader: '$0.31 an hour, up to the limit you set, on your next Forest payment.',
    heading: 'You’re past your included hours',
    lines: [
      'You’ve played all 17 of this month’s hours, so your servers are on extra hours now: $0.31 an hour, up to the 7 you allowed ($2.17).',
      'They’re added to your next Forest payment. You can change your limit on your account whenever you like.',
    ],
    gauge: meter(2.25, 7),
    action: { label: 'Open your account', url: account },
  })
  for (const ceiling of [7, 9]) {
    message(extraWarning({ ...base, mark: 80, ceiling }), {
      subject: 'You’ve used 80% of the extra hours you allowed',
      heading: '80% of your extra hours are used',
      preheader: '$0.70 so far, on your next Forest payment.',
      lines: [
        'You’ve played 2.25 of the 7 extra hours you allowed this month: $0.70 so far, added to your next Forest payment.',
        ceiling === 7
          ? 'When they’re used up your servers sleep until the 1st.'
          : 'When they’re used up your servers sleep until the 1st, unless you raise your limit.',
      ],
      gauge: meter(2.25, 7),
      action: { label: 'Open your account', url: account },
    })
    message(extraWarning({ ...base, mark: 100, used: 8, ceiling }), {
      subject: 'Your Cubepals servers are asleep until the 1st',
      heading: 'The extra hours you allowed are used up',
      preheader: '$2.48 of extra hours, on your next Forest payment.',
      lines: [
        'You’ve played the 7 extra hours you allowed this month: $2.48, added to your next Forest payment.',
        ceiling === 7
          ? 'Your servers sleep until the 1st.'
          : 'Your servers sleep until the 1st, or until you raise your limit on your account.',
      ],
      gauge: meter(7, 7),
      chip: asleep,
      action: { label: 'Raise your limit', url: account },
    })
  }
})

test('trial mail keeps downloads available and checkout returns to servers', () => {
  installUnsoldPlans([])
  const plan = planOnSaleHere()
  expect(plan).not.toBeNull()
  const paid = { name: 'Forest', hours: 53 }
  for (const left of [0.4, 1, 2.3]) {
    const words = left < 0.5 ? 'less than an hour' : left === 1 ? 'about an hour' : 'about 2 hours'
    message(freeHoursWarning({ mark: 80, included: 10, used: 10 - left, paid, origin }), {
      subject: `${words[0]?.toUpperCase()}${words.slice(1)} of your free trial left`,
      preheader: 'Just so the end is never a surprise.',
      heading: 'Your free trial is running low',
      lines: [
        `You have ${words} left of your free trial. Its 10 hours come once, not every month.`,
        'When they’re played, your worlds are kept and you can still download them. Forest starts them again, with 53 hours a month.',
      ],
      gauge: meter(left, 10, 'left'),
      action: { label: 'Open your account', url: account },
    })
  }
  for (const [sold, offer] of [
    [true, paid],
    [false, paid],
    [true, null],
    [false, null],
  ] as const) {
    installUnsoldPlans(sold ? [] : PAID_PLANS)
    const action =
      sold && offer !== null
        ? {
            label: 'Keep playing',
            url: `${origin}/checkout?${new URLSearchParams({ plan: String(plan), reason: 'trial_over', next: '/servers' })}`,
          }
        : { label: 'Open your account', url: account }
    message(freeHoursWarning({ mark: 100, included: 10, used: 11, paid: offer, origin }), {
      subject: 'Your Cubepals free trial is over',
      preheader: 'Your worlds are kept.',
      heading: 'Your free trial is over',
      lines: [
        'You’ve played the 10 hours of your free trial, so your servers have stopped. Nothing is charged. Your worlds are kept, and you can still download them.',
        ...(offer === null ? [] : ['Forest starts them again, with 53 hours a month.']),
        reply,
      ],
      gauge: meter(0, 10, 'left'),
      action,
    })
  }
  installUnsoldPlans([])
})

test('a friend’s notice escapes names and links directly back to the affected server', () => {
  installUnsoldPlans([])
  const plan = planOnSaleHere()
  expect(plan).not.toBeNull()
  for (const sold of [true, false])
    for (const paid of [{ name: 'Forest', hours: 53 }, null]) {
      installUnsoldPlans(sold ? [] : PAID_PLANS)
      const lines = [
        'Alex <&> tried to join Moss <&>, but it’s resting: you’ve played the 17 hours of your free trial. Cubepals told them it’s resting for now. Your world is kept, and nothing is charged.',
        ...(paid === null ? [] : ['Forest starts it again, with 53 hours a month.']),
        'Anyone else who comes while it rests is on your server’s page.',
        reply,
      ]
      const action =
        sold && paid !== null
          ? {
              label: 'Keep playing',
              url: `${origin}/checkout?${new URLSearchParams({ plan: String(plan), reason: 'trial_over', next: '/servers/moss-7' })}`,
            }
          : { label: 'Open your server', url: `${origin}/servers/moss-7` }
      expect(
        friendTurnedAway({
          player: 'Alex <&>',
          server: { id: 'moss-7', name: 'Moss <&>' },
          trialHours: 17,
          paid,
          origin,
        }),
      ).toEqual({
        subject: 'Alex <&> tried to join Moss <&>',
        preheader: 'Your world is kept.',
        text: [...lines, '', action.url, '', 'Cubepals'].join('\n'),
        html: layout({
          origin,
          preheader: 'Your world is kept.',
          heading: 'Alex &lt;&amp;&gt; tried to join Moss &lt;&amp;&gt;',
          chip: { label: 'Free trial over', tone: 'quiet' },
          body: [
            `<strong style="color:${INK}">Alex &lt;&amp;&gt;</strong> tried to join <strong style="color:${INK}">Moss &lt;&amp;&gt;</strong>, but it’s resting: you’ve played the 17 hours of your free trial. Cubepals told them it’s resting for now. Your world is kept, and nothing is charged.`,
            ...lines.slice(1),
          ]
            .map(p)
            .join(''),
          action,
          why: OWNER,
        }),
      })
    }
  installUnsoldPlans([])
})
