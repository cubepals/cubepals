/**
 * The warnings as a month's included play runs out, at half, four fifths and all of it
 * (`AccountService.warnAboutPlay`). Hours here are hours on the smallest server, which is what a
 * unit is, and the email says so rather than teaching anyone the word "unit".
 */
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
