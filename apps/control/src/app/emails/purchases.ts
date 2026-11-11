// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a buyer is sent about a purchase, to keep: once it is paid, what they bought, what they paid
 * and that they can cancel within 14 days (`purchaseConfirmed`); and once they cancel it from their
 * account, that it was received, when, and what follows (`withdrawalReceived`). Both are `plain`:
 * money is mail a person must see. Not here: when each is sent (`billing/purchase-confirmation.ts`,
 * `billing/withdrawals.ts`), or what the operator is told (`admins.ts`).
 */
import { ACCOUNT, type Email, esc, link, p, plain } from '../emails.ts'

/** A day and a time, in UTC, as a receipt says it: "11 November 2026 at 14:05 UTC". */
const WHEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
})
export const whenSaid = (at: Date): string => `${WHEN.format(at).replace(', ', ' at ')} UTC`

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })

/** Money as the order states it: "$15.00", or "EUR 12.00" in another currency. */
export function money(cents: number, currency: string): string {
  const code = currency.toUpperCase()
  return code === 'USD' ? `$${(cents / 100).toFixed(2)}` : `${code} ${(cents / 100).toFixed(2)}`
}

/** A letter's lines, then its links, in both parts. */
function letter(subject: string, lines: string[], links: Array<{ label: string; url: string }>): Email {
  return {
    subject,
    text: [...lines, '', ...links.map((l) => `${l.label}: ${l.url}`)].join('\n'),
    html: plain({
      subject,
      body: lines.map((line) => p(esc(line))).join('') + links.map((l) => p(link(l))).join(''),
      why: ACCOUNT,
    }),
  }
}

export function purchaseConfirmed(input: {
  /** What it is called: "your first month of Plus", "your chip-in to Maple Hollow". */
  title: string
  paidCents: number
  currency: string
  /** What it includes, said whole: "120 hours of play each month". Null where it says nothing. */
  includes: string | null
  /** How it started: "It started straight away, as you asked." Null where it doesn't start (a gift). */
  started: string | null
  until: Date
  /** The buyer has an account to cancel it from; a guest's gift is cancelled by email. */
  onAccount: boolean
  origin: string
}): Email {
  const refunds = `${input.origin}/legal/refunds`
  const lines = [
    `Thank you. This confirms ${input.title}, bought on Cubepals. You paid ${money(input.paidCents, input.currency)}, tax included where it applies, through Polar, our merchant of record.`,
    ...(input.includes === null ? [] : [`It includes ${input.includes}.`]),
    ...(input.started === null ? [] : [input.started]),
    input.onAccount
      ? `You can cancel it within 14 days, until ${DAY.format(input.until)}: on your account, where it says “Cancel within 14 days”, or by replying to this email. What you get back is set out on our Refunds page.`
      : `You can cancel it within 14 days, until ${DAY.format(input.until)}, by replying to this email. What you get back is set out on our Refunds page.`,
  ]
  return letter(`Your Cubepals purchase: ${input.title}`, lines, [
    ...(input.onAccount ? [{ label: 'Your account', url: `${input.origin}/account` }] : []),
    { label: 'Refunds and cancellation', url: refunds },
  ])
}

export function withdrawalReceived(input: {
  title: string
  /** A first month's other charges cancelled with it, as each is called: "the upgrade to Plus". */
  also: string[]
  receivedAt: Date
  paidCents: number
  refundCents: number
  currency: string
  /** What ends now, said whole: "Plus has ended, and your account is on the free trial." */
  ended: string
  origin: string
}): Email {
  const lines = [
    `We received your cancellation of ${input.title}${input.also.length === 0 ? '' : `, with ${input.also.join(' and ')},`} on ${whenSaid(input.receivedAt)}. This email is your confirmation of it.`,
    input.ended,
    `Under our Refunds page, ${input.refundCents === input.paidCents ? `that is a full refund of ${money(input.paidCents, input.currency)}` : `that is ${money(input.refundCents, input.currency)} of the ${money(input.paidCents, input.currency)} you paid`}. It goes back to the payment method you used, through Polar, within 14 days of the date above, with no fee.`,
  ]
  return letter(`We received your cancellation: ${input.title}`, lines, [
    { label: 'Refunds and cancellation', url: `${input.origin}/legal/refunds` },
  ])
}
