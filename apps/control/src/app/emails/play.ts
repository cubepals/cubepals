// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The warnings as a month's included play runs out, at half, four fifths and all of it
 * (`AccountService.warnAboutPlay`), and as extra play the owner allowed is used: when it starts,
 * at four fifths of their limit and at all of it (`warnAboutExtra`). Hours here are hours on the
 * smallest server, which is what a unit is, and the email says so rather than teaching anyone the
 * word "unit".
 */
import { dollars } from '../../domain/policy/spend.ts'
import { ACCOUNT, type Email, layout, meter, p } from '../emails.ts'

/** What the email says the month's play has come to, in the words the account page uses. */
function playLines(input: {
  mark: number
  included: number
  used: number
  extraAllowed: number
  mayBuyMore: boolean
}): string[] {
  const left = Math.max(0, input.included - input.used)
  if (input.mark >= 100) {
    const lines = [
      `Your plan includes ${input.included} hours of play a month, on a 3 GB server, and this month’s are used up.`,
      input.extraAllowed > 0
        ? `You allowed up to ${input.extraAllowed} hours past them, so your servers keep running until those are used too.`
        : 'Your servers are asleep until the 1st. Nothing was charged: Cubepals only spends what you allow.',
    ]
    if (input.mayBuyMore && input.extraAllowed === 0)
      lines.push('If you want them back before then, allow some extra play on your account.')
    return lines
  }
  return [
    `You have used ${input.used} of the ${input.included} hours your plan includes this month, on a 3 GB server — bigger ones use them faster.`,
    input.mark >= 80
      ? `About ${Math.round(left)} hours are left. When they run out your servers sleep until the 1st${input.mayBuyMore ? ', unless you allow some extra play' : ''}.`
      : 'Nothing to do; this is just so the end of the month is never a surprise.',
  ]
}

/** The line an inbox shows under the subject. */
function playPreheader(mark: number, left: number): string {
  if (mark >= 100) return 'Nothing was charged.'
  if (mark >= 80) return `About ${Math.round(left)} hours are left this month.`
  return 'Nothing to do. Just so the end of the month is never a surprise.'
}

export function playWarning(input: {
  mark: number
  included: number
  used: number
  extraAllowed: number
  mayBuyMore: boolean
  origin: string
}): Email {
  const account = `${input.origin}/account`
  const lines = playLines(input)
  const asleep = input.mark >= 100 && input.extraAllowed === 0
  const subject =
    input.mark >= 100
      ? 'Your Cubepals servers are asleep until the 1st'
      : `You have used ${input.mark}% of this month’s play`
  const preheader = playPreheader(input.mark, Math.max(0, input.included - input.used))
  return {
    subject,
    preheader,
    text: [...lines, '', account].join('\n'),
    html: layout({
      origin: input.origin,
      preheader,
      chip: asleep ? { label: 'Asleep until the 1st', tone: 'sleeping' } : undefined,
      heading:
        input.mark >= 100 ? 'This month’s play is used up' : `${input.mark}% of this month’s play is used`,
      body: meter(Math.min(input.used, input.included), input.included) + lines.map(p).join(''),
      action: {
        label: asleep && input.mayBuyMore ? 'Allow extra play' : 'Open your account',
        url: account,
      },
      why: ACCOUNT,
    }),
  }
}

/**
 * Extra play, as it is used: `mark` 0 the first time a month that it is, then 80 and 100 per cent
 * of the limit the owner allowed. `used` is extra hours so far, and `unitCents` what one costs.
 */
export function extraWarning(input: {
  mark: number
  included: number
  allowed: number
  /** The most the owner may allow now: once `allowed` is that, raising it isn't offered. */
  ceiling: number
  used: number
  unitCents: number
  origin: string
}): Email {
  const account = `${input.origin}/account`
  const each = dollars(input.unitCents)
  const soFar = dollars(Math.round(input.used * input.unitCents))
  const upTo = dollars(input.allowed * input.unitCents)
  const mayRaise = input.allowed < input.ceiling
  const said =
    input.mark >= 100
      ? {
          subject: 'Your Cubepals servers are asleep until the 1st',
          heading: 'The extra hours you allowed are used up',
          preheader: `${soFar} of extra hours, on your next Plus payment.`,
          lines: [
            `You’ve played the ${input.allowed} extra hours you allowed this month: ${soFar}, added to your next Plus payment.`,
            mayRaise
              ? 'Your servers sleep until the 1st, or until you raise your limit on your account.'
              : 'Your servers sleep until the 1st.',
          ],
        }
      : input.mark >= 80
        ? {
            subject: `You’ve used ${input.mark}% of the extra hours you allowed`,
            heading: `${input.mark}% of your extra hours are used`,
            preheader: `${soFar} so far, on your next Plus payment.`,
            lines: [
              `You’ve played ${input.used} of the ${input.allowed} extra hours you allowed this month: ${soFar} so far, added to your next Plus payment.`,
              mayRaise
                ? 'When they’re used up your servers sleep until the 1st, unless you raise your limit.'
                : 'When they’re used up your servers sleep until the 1st.',
            ],
          }
        : {
            subject: 'You’re on extra hours now',
            heading: 'You’re past your included hours',
            preheader: `${each} an hour, up to the limit you set, on your next Plus payment.`,
            lines: [
              `You’ve played the ${input.included} hours your plan includes this month, so your servers are on extra hours now: ${each} an hour, up to the ${input.allowed} you allowed (${upTo}).`,
              'They’re added to your next Plus payment. You can change your limit on your account whenever you like.',
            ],
          }
  return {
    subject: said.subject,
    preheader: said.preheader,
    text: [...said.lines, '', account].join('\n'),
    html: layout({
      origin: input.origin,
      preheader: said.preheader,
      chip: input.mark >= 100 ? { label: 'Asleep until the 1st', tone: 'sleeping' } : undefined,
      heading: said.heading,
      body: meter(Math.min(input.used, input.allowed), input.allowed) + said.lines.map(p).join(''),
      action: { label: input.mark >= 100 ? 'Raise your limit' : 'Open your account', url: account },
      why: ACCOUNT,
    }),
  }
}
