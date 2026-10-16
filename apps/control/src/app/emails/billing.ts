// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an owner is told when a payment carrying extra play fails: once while the card is tried
 * again, and once if it is still unpaid after that, when their servers can't start until it is
 * (`BillingService.tellAboutPayments`). Both say what to do: fix the card in Manage billing while
 * it is still tried, and once it is owed, pay it on the account page. And, since nothing renews a
 * year paid at once, that it is about to end, 14 and 3 days before (`BillingService.remindYears`).
 * All are `plain`: money is mail a person must see, not mail Gmail may file under Promotions.
 */
import { dollars } from '../../domain/policy/spend.ts'
import { ACCOUNT, type Email, link, p, plain } from '../emails.ts'

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })

export function paymentFailed(input: {
  totalCents: number
  extraCents: number
  by: Date
  origin: string
}): Email {
  const account = `${input.origin}/account`
  const lines = [
    `Your Plus payment of ${dollars(input.totalCents)}, with ${dollars(input.extraCents)} of extra hours in it, didn’t go through.`,
    'Extra hours are off until it does. Update your card in Manage billing on your account, and the payment is tried again.',
    `If it still isn’t paid by ${DAY.format(input.by)}, your servers can’t start until it is.`,
  ]
  const subject = 'Your Cubepals payment didn’t go through'
  return {
    subject,
    text: [...lines, '', account].join('\n'),
    html: plain({
      subject,
      body: lines.map(p).join('') + p(link({ label: 'Open your account', url: account })),
      why: ACCOUNT,
    }),
  }
}

export function paymentOwed(input: { owedCents: number; extraCents: number; origin: string }): Email {
  const account = `${input.origin}/account`
  const lines = [
    `You owe ${dollars(input.owedCents)} from a Plus payment that didn’t go through, ${dollars(input.extraCents)} of it for extra hours.`,
    'Until it’s paid, your servers can’t start and you can’t make new ones. Your worlds are safe, and you can still download them.',
    'Pay it on your account, and your servers can start again straight away.',
  ]
  const subject = 'Your Cubepals servers can’t start until a payment is made'
  return {
    subject,
    text: [...lines, '', account].join('\n'),
    html: plain({
      subject,
      body: lines.map(p).join('') + p(link({ label: 'Open your account', url: account })),
      why: ACCOUNT,
    }),
  }
}

export function yearEnding(input: {
  plan: string
  endsAt: Date
  days: number
  yearlyCents: number
  origin: string
}): Email {
  const account = `${input.origin}/account`
  const lines = [
    `Your year of ${input.plan} ends on ${DAY.format(input.endsAt)}, in ${input.days} days. It doesn’t renew on its own, so nothing will be charged.`,
    `To keep ${input.plan}, renew it on your account: another year is ${dollars(input.yearlyCents)}, and it starts the day this one ends.`,
    `If you let it end, your account moves to the free trial. Your worlds stay, and anything that needs ${input.plan} waits until you have it again.`,
  ]
  const subject = `Your year of Cubepals ${input.plan} ends in ${input.days} days`
  return {
    subject,
    text: [...lines, '', account].join('\n'),
    html: plain({
      subject,
      body: lines.map(p).join('') + p(link({ label: 'Renew on your account', url: account })),
      why: ACCOUNT,
    }),
  }
}
