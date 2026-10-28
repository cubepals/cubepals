// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every email the application sends: its subject, its shape, and an HTML part with the same links
 * as its text. A `layout` one's lockup, figure and font stylesheet load from the web origin it was
 * given; a `plain` one loads nothing. The account's own emails carry nothing read as marketing.
 */
import { describe, expect, test } from 'bun:test'
import { passwordChanged, resetPassword, verifyEmail, welcome } from './emails/account.ts'
import { adminAlert, spendLimit } from './emails/admins.ts'
import { paymentFailed, paymentOwed } from './emails/billing.ts'
import { giftPreviews } from './emails/gift-previews.ts'
import { giftReminder, giftWords } from './emails/gifts.ts'
import { addressChanged, unlisted } from './emails/notices.ts'
import { extraWarning, friendTurnedAway, playWarning } from './emails/play.ts'
import { keepingWorld, listingRemoved, serverRebuilt } from './emails/servers.ts'
import { type Email, esc, INK, meter } from './emails.ts'

const ORIGIN = 'https://staging.blockly.test'
/** What emails about Plus say of its extra hours (a quarter each, billed on Plus), and where their links start. */
const ON_PLUS = { plan: 'Plus', unitCents: 25, origin: ORIGIN }
const bay = { id: 'srv_7Kq2', name: 'Sunrise <Bay>' }

/** Every email, with what it should say, its shape, and the figure it carries, if any. */
const EMAILS: Array<{
  name: string
  email: Email
  subject: string
  shape: 'layout' | 'plain'
  figure?: string
  link: string
}> = [
  {
    name: 'welcome',
    email: welcome(ORIGIN),
    subject: 'Welcome to Cubepals',
    shape: 'layout',
    figure: 'moss-waving.gif',
    link: `${ORIGIN}/servers/new`,
  },
  {
    name: 'confirm',
    email: verifyEmail(`${ORIGIN}/api/auth/verify-email?token=t&callbackURL=%2Fservers`, ORIGIN),
    subject: 'Confirm your email for Cubepals',
    shape: 'layout',
    link: `${ORIGIN}/api/auth/verify-email?token=t&amp;callbackURL=%2Fservers`,
  },
  {
    name: 'reset',
    email: resetPassword(`${ORIGIN}/api/auth/reset-password/x`, ORIGIN),
    subject: 'Reset your Cubepals password',
    shape: 'layout',
    link: `${ORIGIN}/api/auth/reset-password/x`,
  },
  {
    name: 'changed',
    email: passwordChanged(ORIGIN),
    subject: 'Your Cubepals password was changed',
    shape: 'layout',
    link: `${ORIGIN}/forgot-password`,
  },
  {
    name: 'play',
    email: playWarning({
      mark: 80,
      included: 60,
      carried: 0,
      used: 48.3,
      extraAllowed: 0,
      mayBuyMore: true,
      ...ON_PLUS,
    }),
    subject: 'About 12 hours of play left this month',
    shape: 'layout',
    link: `${ORIGIN}/account`,
  },
  ...[0, 80, 100].map((mark) => ({
    name: `extra ${mark}`,
    email: extraWarning({
      mark,
      included: 60,
      allowed: 20,
      ceiling: 50,
      used: mark === 0 ? 0.4 : (20 * mark) / 100,
      ...ON_PLUS,
    }),
    subject: [
      'You’re on extra hours now',
      'You’ve used 80% of the extra hours you allowed',
      'Your Cubepals servers are asleep until the 1st',
    ][[0, 80, 100].indexOf(mark)] as string,
    shape: 'layout' as const,
    link: `${ORIGIN}/account`,
  })),
  {
    name: 'payment failed',
    email: paymentFailed({
      plan: 'Plus',
      totalCents: 1750,
      extraCents: 250,
      by: new Date('2026-11-08T00:00:00Z'),
      origin: ORIGIN,
    }),
    subject: 'Your Cubepals payment didn’t go through',
    shape: 'plain',
    link: `${ORIGIN}/account`,
  },
  {
    name: 'payment owed',
    email: paymentOwed({ plan: 'Plus', owedCents: 1750, extraCents: 250, origin: ORIGIN }),
    subject: 'Your Cubepals servers can’t start until a payment is made',
    shape: 'plain',
    link: `${ORIGIN}/account`,
  },
  {
    name: 'listing',
    email: listingRemoved({
      server: bay,
      mods: [{ name: 'tweaks.jar', why: 'uploaded by hand' }],
      origin: ORIGIN,
    }),
    subject: '“Sunrise <Bay>” left the Cubepals directory',
    shape: 'layout',
    link: `${ORIGIN}/servers/srv_7Kq2/mods`,
  },
  {
    name: 'keeping',
    email: keepingWorld({
      server: bay,
      lastPlayed: '9 November 2025',
      goes: '9 November 2026',
      origin: ORIGIN,
    }),
    subject: 'We’re keeping Sunrise <Bay> until 9 November 2026',
    shape: 'plain',
    link: `${ORIGIN}/servers/srv_7Kq2`,
  },
  {
    name: 'rebuilt',
    email: serverRebuilt({ server: bay, backupAt: 'Fri, 10 Oct 2026 06:13:00 GMT', origin: ORIGIN }),
    subject: '“Sunrise <Bay>” was moved after the computer it ran on failed',
    shape: 'layout',
    link: `${ORIGIN}/servers/srv_7Kq2`,
  },
  {
    name: 'new address',
    email: addressChanged({
      server: bay,
      slug: 'beta',
      from: 'beta.play.cubepals.com',
      to: 'sunrise-bay.play.cubepals.com',
      origin: ORIGIN,
    }),
    subject: 'Your server has a new address',
    shape: 'layout',
    link: `${ORIGIN}/servers/srv_7Kq2`,
  },
  {
    name: 'unlisted',
    email: unlisted({ server: bay, join: 'sunrise-bay.play.cubepals.com', origin: ORIGIN }),
    subject: 'Your server is no longer listed in Browse',
    shape: 'layout',
    link: `${ORIGIN}/servers/srv_7Kq2`,
  },
  {
    name: 'came by after the trial',
    email: friendTurnedAway({
      player: 'Alex',
      server: bay,
      trialHours: 20,
      paid: { name: 'Plus', hours: 40 },
      origin: ORIGIN,
    }),
    subject: 'Alex tried to join Sunrise <Bay>',
    shape: 'layout',
    link: `${ORIGIN}/servers/srv_7Kq2`,
  },
  {
    name: 'alert',
    email: adminAlert({ summary: '2 operations are stuck.', path: '/admin/operations', origin: ORIGIN }),
    subject: 'Cubepals needs an admin: 2 operations are stuck.',
    shape: 'layout',
    link: `${ORIGIN}/admin/operations`,
  },
  {
    name: 'spend',
    email: spendLimit({
      cents: 2140,
      limitCents: 2000,
      day: '2026-10-10',
      computeCents: 1630,
      strayCents: 210,
      strayMachines: 3,
      storageCents: 300,
      origin: ORIGIN,
    }),
    subject: 'Cubepals spent $21.40 today (2026-10-10, UTC), past its $20.00 daily limit.',
    shape: 'layout',
    link: `${ORIGIN}/admin/platform`,
  },
  ...giftPreviews(ORIGIN),
]

describe('emails', () => {
  test.each(EMAILS.filter((e) => e.shape === 'layout'))(
    '$name: its subject, and an HTML part whose pictures load from the web origin',
    (e) => {
      expect(e.email.subject).toBe(e.subject)
      const { html } = e.email
      expect(html.startsWith('<!doctype html>')).toBe(true)
      expect(html).toContain(`<img src="${ORIGIN}/email/lockup.png" width="160" height="44"`)
      expect(html).toContain(`<link href="${ORIGIN}/email/fonts.css" rel="stylesheet">`)
      expect(html).toContain(`href="${e.link}"`)
      // The line an inbox shows under the subject, hidden in the body (the account's have none).
      if (e.email.preheader) expect(html).toContain(e.email.preheader.replace(/&/g, '&amp;'))
      const pictures = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1])
      expect(pictures).toEqual([
        `${ORIGIN}/email/lockup.png`,
        ...(e.figure ? [`${ORIGIN}/email/${e.figure}`] : []),
      ])
      // Nothing reaches the page unescaped, and nothing is left to fill in.
      expect(html).not.toContain('<Bay>')
      expect(html).not.toContain('{{')
    },
  )

  test.each(EMAILS.filter((e) => e.shape === 'plain'))(
    '$name: a short letter, with nothing Gmail reads as marketing',
    (e) => {
      expect(e.email.subject).toBe(e.subject)
      const { html } = e.email
      expect(html.startsWith('<!doctype html>')).toBe(true)
      // The wordmark in words, and the link among the words, underlined like any other.
      expect(html).toContain('>cubepals</p>')
      expect(html).toMatch(
        new RegExp(
          `<a href="${e.link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" style="[^"]*text-decoration:underline`,
        ),
      )
      expect(html).toContain(`<title>${esc(e.subject)}</title>`)
      // No picture, button, card, font stylesheet, heading or hidden preheader.
      expect(e.email.preheader).toBeUndefined()
      expect(html).not.toContain('<img')
      expect(html).not.toContain('<link')
      expect(html).not.toContain('<h1')
      expect(html).not.toContain('display:none')
      expect(html).not.toContain(`background:${INK}`)
      expect(html).not.toContain('border:2px')
      expect(html.match(/<a /g)).toHaveLength(1)
      expect(html).not.toContain('{{')
    },
  )

  test('each figure is drawn at its size in CSS pixels, half the image it loads', () => {
    expect(welcome(ORIGIN).html).toContain(`src="${ORIGIN}/email/moss-waving.gif" width="66" height="105"`)
  })

  test('the month’s play counts the hours left from last month with the plan’s', () => {
    const warned = (mark: number) =>
      playWarning({
        mark,
        included: 100,
        carried: 40,
        used: mark === 100 ? 140 : 120,
        extraAllowed: 0,
        mayBuyMore: true,
        ...ON_PLUS,
      })
    expect(warned(80).subject).toBe('About 20 hours of play left this month')
    expect(warned(80).text).toContain(
      'You have about 20 hours left of your 140 hours of play this month: 100 from your plan and 40 left from last month.',
    )
    expect(warned(100).text).toContain(
      'This month’s 100 hours of play, and the 40 left from last month, are used up.',
    )
  })

  test('extra play says what it costs and where it is billed, in the words of the voice', () => {
    const started = extraWarning({
      mark: 0,
      included: 60,
      allowed: 20,
      ceiling: 20,
      used: 0.4,
      ...ON_PLUS,
    })
    // At the ceiling, the limit can't be raised, so it isn't offered.
    const atCeiling = (mark: number) =>
      extraWarning({ mark, included: 60, allowed: 20, ceiling: 20, used: 20, ...ON_PLUS })
    expect(atCeiling(100).text).toContain('Your servers sleep until the 1st.\n')
    for (const mark of [80, 100]) expect(atCeiling(mark).text).not.toContain('raise')
    expect(started.text).toContain(
      'You’ve played all 60 of this month’s hours, so your servers are on extra hours now: $0.25 an hour, up to the 20 you allowed ($5.00).',
    )
    expect(started.text).toContain('They’re added to your next Plus payment.')
    expect(
      paymentFailed({
        plan: 'Plus',
        totalCents: 1750,
        extraCents: 250,
        by: new Date('2026-11-08T00:00:00Z'),
        origin: ORIGIN,
      }).text,
    ).toContain('If it still isn’t paid by 8 November, your servers can’t start until it is.')
    expect(paymentOwed({ plan: 'Plus', owedCents: 1750, extraCents: 250, origin: ORIGIN }).text).toContain(
      'Your worlds are safe, and you can still download them.',
    )
    for (const email of [started, paymentOwed({ plan: 'Plus', owedCents: 1, extraCents: 1, origin: ORIGIN })])
      expect(email.text).not.toMatch(/seamless|effortless|powerful|turn on|handled|GB|RAM/i)
  })

  test('the text part has every link the button has, for a mail app that shows no HTML', () => {
    for (const e of EMAILS) expect(e.email.text).toContain(e.link.replace(/&amp;/g, '&'))
  })

  test('the meter fills a block for each tenth, to the nearest, and says the hours to a tenth', () => {
    const filled = (html: string) => html.split(`background:${INK}`).length - 1
    expect(filled(meter(120, 120, 'left'))).toBe(10)
    expect(filled(meter(96, 120, 'left'))).toBe(8)
    expect(filled(meter(5, 120, 'left'))).toBe(0)
    expect(filled(meter(0, 120, 'left'))).toBe(0)
    expect(filled(meter(150, 120))).toBe(10)
    expect(meter(96, 120, 'left')).toContain('96 of 120 hours left')
    expect(meter(12.34, 20)).toContain('12.3 of 20 hours</p>')
  })
})

describe('notices', () => {
  test.each(EMAILS.filter((e) => ['new address', 'unlisted'].includes(e.name)))(
    '$name: says nobody reads replies instead of offering one, and keeps each address on one line',
    (e) => {
      const { html, text } = e.email
      expect(text).toContain('\n\nThis mailbox isn’t read.\n\nCubepals')
      expect(html).toContain('You get this because you own this server on Cubepals. This mailbox isn’t read.')
      expect(html).not.toContain('Reply to this email')
      expect(html).toContain('white-space:nowrap">sunrise-bay.play.cubepals.com</strong>')
      expect(html).toContain('>Open your server</a>')
    },
  )

  test.each(EMAILS.filter((e) => e.name.startsWith('came by')))(
    '$name: who came, to which server, why it rests and what brings it back, from the unread address',
    (e) => {
      const { html, text } = e.email
      expect(text).toContain('\n\nThis mailbox isn’t read.\n\nCubepals')
      expect(html).toContain('You get this because you own this server on Cubepals. This mailbox isn’t read.')
      expect(html).not.toContain('Reply to this email')
      expect(html).toContain('>Open your server</a>')
      expect(html).toContain(`<strong style="color:${INK}">Sunrise &lt;Bay&gt;</strong>`)
      expect(text).toContain('Anyone else who comes while it rests is on your server’s page.')
    },
  )

  test('the owner hears the trial is played, that their world is kept, and what starts it again', () => {
    const [trial] = EMAILS.filter((e) => e.name.startsWith('came by')).map((e) => e.email.text)
    expect(trial).toContain(
      'Alex tried to join Sunrise <Bay>, but it’s resting: you’ve played the 20 hours of your free trial. Cubepals told them it’s resting for now. Your world is kept.',
    )
    expect(trial).toContain('Plus starts it again, with 40 hours a month.')
    // Where no plan by the month is on sale, nothing is offered.
    const unsold = friendTurnedAway({
      player: 'Alex',
      server: bay,
      trialHours: 20,
      paid: null,
      origin: ORIGIN,
    })
    expect(unsold.text).not.toContain('hours a month')
  })
})

describe('account emails', () => {
  test.each(EMAILS.filter((e) => ['confirm', 'reset', 'changed'].includes(e.name)))(
    '$name: the account’s own email says only what the account needs',
    (e) => {
      const { html } = e.email
      // Nothing hidden, no figure, and one way on: the button, with its address under it.
      expect(e.email.preheader).toBeUndefined()
      expect(html).not.toContain('display:none')
      expect(html.match(/<img /g)).toHaveLength(1)
      expect(
        html.match(new RegExp(`href="${e.link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')),
      ).toHaveLength(1)
      expect(html.match(/<a /g)).toHaveLength(3)
      expect(html).not.toMatch(/unsubscribe|preferences|follow us|offer|discount/i)
    },
  )
})

describe('emails on Core', () => {
  test('on Core, running low says what extra hours cost and when Plus costs less', () => {
    const core = playWarning({
      mark: 80,
      included: 40,
      carried: 0,
      used: 33,
      extraAllowed: 0,
      mayBuyMore: true,
      unitCents: 25,
      larger: { name: 'Plus', extraHoursCheaper: 60 },
      origin: ORIGIN,
    })
    expect(core.text).toContain(
      'Extra hours are $0.25 each. Past 60 extra hours a month, Plus costs less, and has more hours.',
    )
    const usedUp = playWarning({
      mark: 100,
      included: 40,
      carried: 0,
      used: 40,
      extraAllowed: 0,
      mayBuyMore: true,
      unitCents: 25,
      larger: { name: 'Plus', extraHoursCheaper: 60 },
      origin: ORIGIN,
    })
    expect(usedUp.text).toContain('allow some extra play on your account')
    expect(usedUp.text).toContain('Past 60 extra hours a month, Plus costs less')
  })
})

describe('gift emails', () => {
  const gifts = giftPreviews(ORIGIN)
  const named = (name: string) => {
    const found = gifts.find((g) => g.name === name)
    if (!found) throw new Error(`no preview ${name}`)
    return found.email
  }

  test('what a buyer writes reaches the recipient escaped, with no web or email address left in it', () => {
    const { html, text } = named('gift waiting')
    const note = '“Happy birthday! Build us a castle on, or mail me at. See you on Saturday.”'
    expect(text).toContain(note)
    expect(html).toContain(esc(note))
    expect(html).toContain('Sam &lt;b&gt; sent you a month of Plus on Cubepals')
    for (const part of [html, text]) expect(part).not.toContain('example.com')
    expect(html).not.toContain('<b>')
  })

  test('a From name or note keeps its words and loses links, addresses and hidden marks', () => {
    expect(giftWords('see https://x.io/a now')).toBe('see now')
    expect(giftWords('go to evil.com/free, or EVIL.COM')).toBe('go to, or')
    expect(giftWords('sam@example.com')).toBe('')
    expect(giftWords('Sam\u202E moc.live\nSmith')).toBe('Sam Smith')
    expect(giftWords('Mr. Smith, e.g. 3.14 hours')).toBe('Mr. Smith, e.g. 3.14 hours')
  })

  test('with nothing left of the From name, the gift is from someone', () => {
    const reminder = giftReminder({
      planKey: 'plus',
      months: 1,
      from: 'www.example.com',
      account: true,
      claim: ORIGIN,
    })
    expect(reminder.subject).toBe('Your gift from Someone is still waiting')
  })

  test('from the address nobody reads, they say so and offer no reply', () => {
    for (const name of ['gift started', 'gift reminder', 'gift refunded', 'gift cancelled']) {
      const { html, text } = named(name)
      expect(text.endsWith('This mailbox isn’t read.')).toBe(true)
      expect(html).toContain('This mailbox isn’t read.')
      expect(html).not.toContain('Reply to this email')
    }
    for (const name of ['gift paid', 'gift to hand', 'gift waiting', 'gift bounced'])
      expect(named(name).html).toContain('Reply to this email to reach a person.')
  })

  test('they say each thing in the words of the voice', () => {
    for (const { email } of gifts)
      expect(`${email.subject}\n${email.text}`).not.toMatch(
        /seamless|effortless|powerful|turn on|handled|looked after|set up for you|without you|any device|GB|RAM/i,
      )
  })
})
