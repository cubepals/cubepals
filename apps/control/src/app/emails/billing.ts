/**
 * What an owner is told when a payment carrying extra play fails: once while the card is tried
 * again, and once if it is still unpaid after that, when their servers can't start until it is
 * (`BillingService.tellAboutPayments`). Both say what to do: fix the card in Manage billing while
 * it is still tried, and once it is owed, pay it on the account page.
 */
import { dollars } from '../../domain/policy/spend.ts'
import { ACCOUNT, type Email, layout, p } from '../emails.ts'

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
  const preheader = 'Update your card in Manage billing on your account.'
  return {
    subject: 'Your Cubepals payment didn’t go through',
    preheader,
    text: [...lines, '', account].join('\n'),
    html: layout({
      origin: input.origin,
      preheader,
      chip: { label: 'Payment failed', tone: 'danger' },
      heading: 'Your payment didn’t go through',
      body: lines.map(p).join(''),
      action: { label: 'Open your account', url: account },
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
  const preheader = 'Your worlds are safe. Pay it on your account to play again.'
  return {
    subject: 'Your Cubepals servers can’t start until a payment is made',
    preheader,
    text: [...lines, '', account].join('\n'),
    html: layout({
      origin: input.origin,
      preheader,
      chip: { label: 'Payment due', tone: 'danger' },
      heading: 'A payment is due',
      body: lines.map(p).join(''),
      action: { label: 'Open your account', url: account },
      why: ACCOUNT,
    }),
  }
}
