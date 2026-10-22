// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The warnings as a month's included play runs out, at four fifths and all of it
 * (`AccountService.warnAboutPlay`), the same for Free's hours in all, and as extra play the owner allowed is used: when it starts,
 * at four fifths of their limit and at all of it (`warnAboutExtra`). Hours here are hours on the
 * smallest server, which is what a unit is, and the email says so rather than teaching anyone the
 * word "unit". Included play is said as what is left, the way the account page says it.
 */
import { dollars } from '../../domain/policy/spend.ts'
import { ACCOUNT, type Email, layout, meter, p } from '../emails.ts'

/** Hours left as people say them: "less than an hour", "about an hour", "about 12 hours". */
function leftSaid(left: number): string {
  const hours = Math.round(left)
  if (hours < 1) return 'less than an hour'
  return hours === 1 ? 'about an hour' : `about ${hours} hours`
}

/**
 * What the email says the month's play has come to, in the words the account page uses. `carried`
 * is what was left of last month's hours and came into this one.
 */
/** What extra hours cost, and when the larger plan costs less: "Extra hours are $0.25 each. Past 60 extra hours a month, Plus costs less." */
const largerSaid = (larger: { name: string; extraHoursCheaper: number }, unitCents: number): string =>
  `Extra hours are ${dollars(unitCents)} each. Past ${larger.extraHoursCheaper} extra hours a month, ${larger.name} costs less, and has more hours.`

function playLines(input: {
  mark: number
  included: number
  carried: number
  used: number
  extraAllowed: number
  mayBuyMore: boolean
  unitCents: number
  /** The plan with more, where there is one: its name, and the extra hours a month after which it costs less. */
  larger?: { name: string; extraHoursCheaper: number }
}): string[] {
  if (input.mark >= 100) {
    const lines = [
      input.carried > 0
        ? `This month’s ${input.included} hours of play, and the ${input.carried} left from last month, are used up.`
        : `This month’s ${input.included} hours of play are used up.`,
      input.extraAllowed > 0
        ? `You allowed up to ${input.extraAllowed} hours past them, so your servers keep running until those are used too.`
        : 'Your servers are asleep until the 1st. Nothing was charged: Cubepals only spends what you allow.',
    ]
    if (input.mayBuyMore && input.extraAllowed === 0)
      lines.push('If you want them back before then, allow some extra play on your account.')
    if (input.larger) lines.push(largerSaid(input.larger, input.unitCents))
    return lines
  }
  const left = leftSaid(input.included + input.carried - input.used)
  return [
    input.carried > 0
      ? `You have ${left} left of your ${input.included + input.carried} hours of play this month: ${input.included} from your plan and ${input.carried} left from last month. A large server uses them twice as fast.`
      : `You have ${left} left of the ${input.included} hours of play your plan includes this month. A large server uses them twice as fast.`,
    `When they run out, your servers sleep until the 1st${input.mayBuyMore ? ', unless you allow some extra play' : ''}. Nothing is charged unless you allow it.`,
    ...(input.larger && input.mayBuyMore ? [largerSaid(input.larger, input.unitCents)] : []),
  ]
}

export function playWarning(input: {
  mark: number
  included: number
  carried: number
  used: number
  extraAllowed: number
  mayBuyMore: boolean
  unitCents: number
  larger?: { name: string; extraHoursCheaper: number }
  origin: string
}): Email {
  const account = `${input.origin}/account`
  const lines = playLines(input)
  const asleep = input.mark >= 100 && input.extraAllowed === 0
  const month = input.included + input.carried
  const left = Math.max(0, month - input.used)
  const leftWords = leftSaid(left)
  const subject =
    input.mark >= 100
      ? 'Your Cubepals servers are asleep until the 1st'
      : `${leftWords.slice(0, 1).toUpperCase()}${leftWords.slice(1)} of play left this month`
  const preheader = input.mark >= 100 ? 'Nothing was charged.' : 'Just so the 1st is never a surprise.'
  return {
    subject,
    preheader,
    text: [...lines, '', account].join('\n'),
    html: layout({
      origin: input.origin,
      preheader,
      chip: asleep ? { label: 'Asleep until the 1st', tone: 'sleeping' } : undefined,
      heading: input.mark >= 100 ? 'This month’s play is used up' : 'This month’s play is running low',
      body: meter(Math.round(left * 10) / 10, month, 'left') + lines.map(p).join(''),
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
 * of the limit the owner allowed. `included` is the month's hours, with any left from last month;
 * `used` is extra hours so far, and `unitCents` what one costs.
 */
export function extraWarning(input: {
  mark: number
  included: number
  allowed: number
  /** The most the owner may allow now: once `allowed` is that, raising it isn't offered. */
  ceiling: number
  used: number
  unitCents: number
  /** The plan's name, whose payment the extra hours are added to: "Core", "Plus". */
  plan: string
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
          preheader: `${soFar} of extra hours, on your next ${input.plan} payment.`,
          lines: [
            `You’ve played the ${input.allowed} extra hours you allowed this month: ${soFar}, added to your next ${input.plan} payment.`,
            mayRaise
              ? 'Your servers sleep until the 1st, or until you raise your limit on your account.'
              : 'Your servers sleep until the 1st.',
          ],
        }
      : input.mark >= 80
        ? {
            subject: `You’ve used ${input.mark}% of the extra hours you allowed`,
            heading: `${input.mark}% of your extra hours are used`,
            preheader: `${soFar} so far, on your next ${input.plan} payment.`,
            lines: [
              `You’ve played ${input.used} of the ${input.allowed} extra hours you allowed this month: ${soFar} so far, added to your next ${input.plan} payment.`,
              mayRaise
                ? 'When they’re used up your servers sleep until the 1st, unless you raise your limit.'
                : 'When they’re used up your servers sleep until the 1st.',
            ],
          }
        : {
            subject: 'You’re on extra hours now',
            heading: 'You’re past your included hours',
            preheader: `${each} an hour, up to the limit you set, on your next ${input.plan} payment.`,
            lines: [
              `You’ve played all ${input.included} of this month’s hours, so your servers are on extra hours now: ${each} an hour, up to the ${input.allowed} you allowed (${upTo}).`,
              `They’re added to your next ${input.plan} payment. You can change your limit on your account whenever you like.`,
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

/**
 * The warnings as a plan's hours in all run out (Free's 20), at four fifths and all of them
 * (`AccountService.warnAboutPlay`). They never come back, so the email says what does: the plan
 * by the month, `paid`, with its own hours.
 */
export function freeHoursWarning(input: {
  mark: number
  included: number
  used: number
  paid: { name: string; hours: number } | null
  origin: string
}): Email {
  const account = `${input.origin}/account`
  const left = Math.max(0, input.included - input.used)
  const done = input.mark >= 100
  const again =
    input.paid === null ? '' : `${input.paid.name} starts them again, with ${input.paid.hours} hours a month.`
  const lines = done
    ? [
        `You’ve played the ${input.included} hours of your free trial, so your servers have stopped. Nothing is charged. Your worlds are kept, and you can still download them.`,
        again,
      ]
    : [
        `You have ${leftSaid(left)} left of your free trial. Its ${input.included} hours come once, not every month.`,
        `When they’re played, your worlds are kept and you can still download them. ${again}`,
      ]
  const leftWords = leftSaid(left)
  const subject = done
    ? 'Your Cubepals free trial is over'
    : `${leftWords.slice(0, 1).toUpperCase()}${leftWords.slice(1)} of your free trial left`
  const preheader = done ? 'Your worlds are kept.' : 'Just so the end is never a surprise.'
  const said = lines.filter((line) => line !== '')
  return {
    subject,
    preheader,
    text: [...said, '', account].join('\n'),
    html: layout({
      origin: input.origin,
      preheader,
      heading: done ? 'Your free trial is over' : 'Your free trial is running low',
      body: meter(Math.round(left * 10) / 10, input.included, 'left') + said.map(p).join(''),
      action: { label: 'Open your account', url: account },
      why: ACCOUNT,
    }),
  }
}
