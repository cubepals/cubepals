/**
 * Every email the application sends: its subject, and an HTML part whose lockup, figure and font
 * stylesheet all load from the web origin it was given, with the same links as its text.
 */
import { describe, expect, test } from 'bun:test'
import { passwordChanged, resetPassword, verifyEmail, welcome } from './emails/account.ts'
import { adminAlert, spendLimit } from './emails/admins.ts'
import { paymentFailed, paymentOwed } from './emails/billing.ts'
import { extraWarning, playWarning } from './emails/play.ts'
import { keepingWorld, listingRemoved, serverRebuilt } from './emails/servers.ts'
import type { Email } from './emails.ts'

const ORIGIN = 'https://staging.blockly.test'
const bay = { id: 'srv_7Kq2', name: 'Sunrise <Bay>' }

/** Every email, with what it should say and the figure it carries, if any. */
const EMAILS: Array<{ name: string; email: Email; subject: string; figure?: string; link: string }> = [
  {
    name: 'welcome',
    email: welcome(ORIGIN),
    subject: 'Welcome to Cubepals',
    figure: 'moss-waving.gif',
    link: `${ORIGIN}/servers/new`,
  },
  {
    name: 'confirm',
    email: verifyEmail(`${ORIGIN}/api/auth/verify-email?token=t&callbackURL=%2Fservers`, ORIGIN),
    subject: 'Confirm your email for Cubepals',
    figure: 'worker-clipboard.png',
    link: `${ORIGIN}/api/auth/verify-email?token=t&amp;callbackURL=%2Fservers`,
  },
  {
    name: 'reset',
    email: resetPassword(`${ORIGIN}/api/auth/reset-password/x`, ORIGIN),
    subject: 'Reset your Cubepals password',
    link: `${ORIGIN}/api/auth/reset-password/x`,
  },
  {
    name: 'changed',
    email: passwordChanged(ORIGIN),
    subject: 'Your Cubepals password was changed',
    link: `${ORIGIN}/forgot-password`,
  },
  {
    name: 'play',
    email: playWarning({
      mark: 80,
      included: 60,
      used: 48.3,
      extraAllowed: 0,
      mayBuyMore: true,
      origin: ORIGIN,
    }),
    subject: 'You have used 80% of this month’s play',
    link: `${ORIGIN}/account`,
  },
  ...[0, 80, 100].map((mark) => ({
    name: `extra ${mark}`,
    email: extraWarning({
      mark,
      included: 60,
      allowed: 20,
      used: mark === 0 ? 0.4 : (20 * mark) / 100,
      unitCents: 25,
      origin: ORIGIN,
    }),
    subject: [
      'You’re on extra hours now',
      'You’ve used 80% of the extra hours you allowed',
      'Your Cubepals servers are asleep until the 1st',
    ][[0, 80, 100].indexOf(mark)] as string,
    link: `${ORIGIN}/account`,
  })),
  {
    name: 'payment failed',
    email: paymentFailed({
      totalCents: 1750,
      extraCents: 250,
      by: new Date('2026-11-08T00:00:00Z'),
      origin: ORIGIN,
    }),
    subject: 'Your Cubepals payment didn’t go through',
    link: `${ORIGIN}/account`,
  },
  {
    name: 'payment owed',
    email: paymentOwed({ owedCents: 1750, extraCents: 250, origin: ORIGIN }),
    subject: 'Your Cubepals servers can’t start until a payment is made',
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
    figure: 'kai-hanging.png',
    link: `${ORIGIN}/servers/srv_7Kq2`,
  },
  {
    name: 'rebuilt',
    email: serverRebuilt({ server: bay, backupAt: 'Fri, 10 Oct 2026 06:13:00 GMT', origin: ORIGIN }),
    subject: '“Sunrise <Bay>” was moved after the computer it ran on failed',
    link: `${ORIGIN}/servers/srv_7Kq2`,
  },
  {
    name: 'alert',
    email: adminAlert({ summary: '2 operations are stuck.', path: '/admin/operations', origin: ORIGIN }),
    subject: 'Cubepals needs an admin: 2 operations are stuck.',
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
    link: `${ORIGIN}/admin/platform`,
  },
]

describe('emails', () => {
  test.each(EMAILS)('$name: its subject, and an HTML part whose pictures load from the web origin', (e) => {
    expect(e.email.subject).toBe(e.subject)
    const { html } = e.email
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain(`<img src="${ORIGIN}/email/lockup.png" width="160" height="44"`)
    expect(html).toContain(`<link href="${ORIGIN}/email/fonts.css" rel="stylesheet">`)
    expect(html).toContain(`href="${e.link}"`)
    // The line an inbox shows under the subject, hidden in the body.
    expect(html).toContain(e.email.preheader.replace(/&/g, '&amp;'))
    const pictures = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1])
    expect(pictures).toEqual([
      `${ORIGIN}/email/lockup.png`,
      ...(e.figure ? [`${ORIGIN}/email/${e.figure}`] : []),
    ])
    // Nothing reaches the page unescaped, and nothing is left to fill in.
    expect(html).not.toContain('<Bay>')
    expect(html).not.toContain('{{')
  })

  test('each figure is drawn at its size in CSS pixels, half the image it loads', () => {
    expect(welcome(ORIGIN).html).toContain(`src="${ORIGIN}/email/moss-waving.gif" width="66" height="105"`)
    expect(verifyEmail('https://x.test/v', ORIGIN).html).toContain(
      `src="${ORIGIN}/email/worker-clipboard.png" width="54" height="99"`,
    )
    expect(keepingWorld({ server: bay, lastPlayed: 'then', goes: 'later', origin: ORIGIN }).html).toContain(
      `src="${ORIGIN}/email/kai-hanging.png" width="54" height="111"`,
    )
  })

  test('extra play says what it costs and where it is billed, in the words of the voice', () => {
    const started = extraWarning({
      mark: 0,
      included: 60,
      allowed: 20,
      used: 0.4,
      unitCents: 25,
      origin: ORIGIN,
    })
    expect(started.text).toContain(
      'You’ve played the 60 hours your plan includes this month, so your servers are on extra hours now: $0.25 an hour, up to the 20 you allowed ($5.00).',
    )
    expect(started.text).toContain('They’re added to your next Plus payment.')
    expect(
      paymentFailed({
        totalCents: 1750,
        extraCents: 250,
        by: new Date('2026-11-08T00:00:00Z'),
        origin: ORIGIN,
      }).text,
    ).toContain('If it still isn’t paid by 8 November, your servers can’t start until it is.')
    expect(paymentOwed({ owedCents: 1750, extraCents: 250, origin: ORIGIN }).text).toContain(
      'Your worlds are safe, and you can still download them.',
    )
    for (const email of [started, paymentOwed({ owedCents: 1, extraCents: 1, origin: ORIGIN })])
      expect(email.text).not.toMatch(/seamless|effortless|powerful|turn on|handled|GB|RAM/i)
  })

  test('the text part has every link the button has, for a mail app that shows no HTML', () => {
    for (const e of EMAILS) expect(e.email.text).toContain(e.link.replace(/&amp;/g, '&'))
  })
})
