// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the platform tells every admin by email: an alert it raised (platform/alerts.ts), a day
 * whose spend passed the daily limit (operations/schedules/spend.ts), the signals just raised
 * of the kinds `SIGNALS` emails (joins/signal-mail.ts), and a purchase cancelled within its 14 days,
 * whose refund a person pays at the provider (billing/withdrawals.ts).
 */
import { dollars } from '../../domain/policy/spend.ts'
import { ADMIN, box, type Email, esc, INK, layout, MONO, MUTED, p, SANS, small } from '../emails.ts'

export function adminAlert(input: { summary: string; path: string; origin: string }): Email {
  const url = `${input.origin}${input.path}`
  return {
    subject: `Cubepals needs an admin: ${input.summary}`,
    preheader: 'This is the only email about it.',
    text: `${input.summary}\n\nDeal with it here: ${url}\n\nThis is the only email about it. The alert clears itself once the condition passes, and a new email goes out if it comes back.`,
    html: layout({
      origin: input.origin,
      preheader: 'This is the only email about it.',
      chip: { label: 'Needs an admin', tone: 'danger' },
      heading: esc(input.summary),
      body: '',
      action: { label: 'Deal with it', url },
      after: small(
        'This is the only email about it. The alert clears itself once the condition passes, and a new email goes out if it comes back.',
      ),
      why: ADMIN,
    }),
  }
}

export function spendLimit(input: {
  cents: number
  limitCents: number
  day: string
  computeCents: number
  strayCents: number
  strayMachines: number
  storageCents: number
  origin: string
}): Email {
  const summary = `Cubepals spent ${dollars(input.cents)} today (${input.day}, UTC), past its ${dollars(input.limitCents)} daily limit.`
  const url = `${input.origin}/admin/platform`
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 0;font:400 15px/1.4 ${SANS};color:${MUTED}">${label}</td><td align="right" style="padding:4px 0;font:700 15px/1.4 ${MONO};color:${INK}">${value}</td></tr>`
  return {
    subject: summary,
    preheader: 'Starting and creating servers are now off.',
    text: [
      summary,
      '',
      'Starting and creating servers are now off. Servers already running keep running until they idle out.',
      `Compute ${dollars(input.computeCents)}, compute no server accounts for ${dollars(input.strayCents)} (${input.strayMachines} machines), disks ${dollars(input.storageCents)}.`,
      '',
      `Turn them back on, or raise the limit, here: ${url}`,
      "Check Fly's own figure on the organization's billing page before you do.",
    ].join('\n'),
    html: layout({
      origin: input.origin,
      preheader: 'Starting and creating servers are now off.',
      chip: { label: 'Spend limit', tone: 'danger' },
      heading: `Spent ${dollars(input.cents)} today, past the ${dollars(input.limitCents)} limit`,
      body:
        p(
          `Starting and creating servers are now off. Servers already running keep running until they idle out. (${esc(input.day)}, UTC)`,
        ) +
        box(
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row('Compute', dollars(input.computeCents))}${row(`Machines no server accounts for (${input.strayMachines})`, dollars(input.strayCents))}${row('Disks', dollars(input.storageCents))}<tr><td colspan="2" style="border-top:2px solid ${INK};padding:0"></td></tr>${row(`<strong style="color:${INK}">Today</strong>`, dollars(input.cents))}</table>`,
        ),
      action: { label: 'Turn back on or raise the limit', url },
      after: small("Check Fly's own figure on the organization's billing page before you do."),
      why: ADMIN,
    }),
  }
}

/** One signal as the digest lists it: its kind, its server, and what it found, in a line. */
export interface SignalLine {
  kind: string
  server: string | null
  said: string
}

/** The signals one pass raised that the setting emails, as one email. */
export function signalDigest(input: { lines: readonly SignalLine[]; origin: string }): Email {
  const count = input.lines.length
  const subject = `Cubepals: ${count} new ${count === 1 ? 'signal' : 'signals'}${count === 1 ? `, ${input.lines[0]?.kind}` : ''}`
  const text = input.lines.map((l) => `- ${l.kind} on ${l.server ?? 'the platform'}: ${l.said}`).join('\n')
  const after = 'Each signal is emailed once, as it is raised. `ops.ts signals` lists the open ones.'
  return {
    subject,
    preheader: after,
    text: `${text}\n\n${after}`,
    html: layout({
      origin: input.origin,
      preheader: after,
      chip: { label: 'Signals', tone: 'danger' },
      heading: esc(`${count} new ${count === 1 ? 'signal' : 'signals'}`),
      body: input.lines
        .map((l) =>
          p(`<strong>${esc(l.kind)}</strong> on ${esc(l.server ?? 'the platform')}: ${esc(l.said)}`),
        )
        .join(''),
      after: small(esc(after)),
      why: ADMIN,
    }),
  }
}

/**
 * A purchase cancelled within its 14 days from the account page (`billing/withdrawals.ts`), for
 * whoever pays refunds at the provider by hand, or refuses one that is abuse. Nothing was paid out.
 */
export function withdrawalToRefund(input: {
  userId: string
  order: string
  kind: string
  title: string
  /** The subscription's other orders cancelled with it, each to refund too; `paid` counts them. */
  also: { order: string; title: string; paid: string }[]
  receivedAt: string
  hoursPlayed: number | null
  paid: string
  refund: string
  rule: string
  earlierFull: boolean
  origin: string
}): Email {
  const summary = `A purchase was cancelled within 14 days: ${input.refund} to refund by hand.`
  const lines = [
    `Account: ${input.userId}`,
    `Order: ${input.order} (${input.kind}, ${input.title.replace(/^your /, '')})`,
    ...input.also.map((other) => `Also its order: ${other.order} (${other.title}, ${other.paid})`),
    `Received: ${input.receivedAt}`,
    `Hours played: ${input.hoursPlayed === null ? 'none count' : input.hoursPlayed}`,
    `Paid: ${input.paid}${input.also.length === 0 ? '' : ' across these orders'}. The Refunds page's rule (${input.rule}) gives back ${input.refund}${input.also.length === 0 ? '' : ' of it in all'}.`,
    `A full refund on an earlier purchase: ${input.earlierFull ? 'yes' : 'no'}.`,
    'The purchase has stopped. Nothing was paid out: refund it at the provider, to the payment method used, within 14 days, or refuse it there if it is abuse.',
  ]
  const url = `${input.origin}/admin/accounts/${encodeURIComponent(input.userId)}`
  return {
    subject: `Cubepals: refund to pay by hand, ${input.refund}`,
    preheader: summary,
    text: [summary, '', ...lines, '', url].join('\n'),
    html: layout({
      origin: input.origin,
      preheader: summary,
      chip: { label: 'Refund by hand', tone: 'danger' },
      heading: esc(summary),
      body: lines.map((line) => p(esc(line))).join(''),
      action: { label: 'Open the account', url },
      why: ADMIN,
    }),
  }
}
