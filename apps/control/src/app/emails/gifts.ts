// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A gift's emails. Today `Gifts.issue` sends the first, `giftCode`: the code, to whoever bought it,
 * the only place it is ever written, since only its hash is kept.
 *
 * The rest are for a gift sent by email, to someone who may not have an account yet. Nothing sends
 * them yet. To the buyer, from the address people reply to (MAIL_FROM): it is paid (`giftPaid`),
 * the code to hand over themselves (`giftToHand`), and the recipient's address bounced
 * (`giftBounced`); from the address nobody reads (MAIL_NOTICE_FROM), it was refunded or cancelled
 * (`giftEnded`). To the recipient: a gift is waiting (`giftWaiting`, MAIL_FROM), then from the
 * address nobody reads, the one reminder a week on (`giftReminder`) and that it has started
 * (`giftStarted`).
 *
 * All are `plain` but the one saying a gift started, which is news about an account: an email about
 * a payment must reach the inbox, and so must one to a stranger. The From name and note a buyer
 * writes reach the recipient as words only (`giftWords`), escaped.
 *
 * Not here: when each is sent, and the pages their links open.
 */
import { planName } from '../../domain/account/entitlements.ts'
import { dollars } from '../../domain/policy/spend.ts'
import { ACCOUNT, type Email, esc, INK, layout, link, MONO, p, plain, SANS } from '../emails.ts'

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })

const UNREAD = 'This mailbox isn’t read.'
const BUYER = 'You get this because you bought a gift on Cubepals.'
const RECIPIENT =
  'You get this because someone sent you a gift on Cubepals. We keep your address only for the gift.'

/** "a month of Plus", "12 months of Plus". */
const giftName = (planKey: string, months: number): string =>
  `${months === 1 ? 'a month' : `${months} months`} of ${planName(planKey)}`

type Gift = { planKey: string; months: number }

/**
 * What a buyer wrote for the recipient to read, the From name or the note, as words only: no web
 * or email address survives, nor anything that reorders or hides text, and it is one line.
 * Empty when nothing is left.
 */
export const giftWords = (written: string): string =>
  written
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\S*@\S*?(?=[,.!?;:]*(?:\s|$))/g, '')
    .replace(/\S*(?:https?:\/\/|www\.)\S*?(?=[,.!?;:]*(?:\s|$))/giu, '')
    .replace(/\S*[\p{L}\p{N}-]\.\p{L}{2,}\b\S*?(?=[,.!?;:]*(?:\s|$))/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/ (?=[,.!?;:])/g, '')
    .replace(/^[,.!?;:]+ ?/, '')
    .trim()

/** Who sent it, as the recipient reads it. */
const sender = (from: string | undefined) => giftWords(from ?? '') || 'Someone'

/** A gift's code, large enough to copy by hand. */
const codeLine = (code: string) =>
  `<p style="margin:0 0 16px;font:700 20px/1.4 ${MONO};letter-spacing:.04em;color:${INK}">${esc(code)}</p>`

/** The buyer's note, set apart from Cubepals' own words. */
const quoted = (note: string) =>
  `<p style="margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid ${INK};font:400 16px/1.55 ${SANS};color:${INK}">“${esc(note)}”</p>`

/** A letter to the buyer: its lines, then the page that manages their gift. */
const toBuyer = (subject: string, lines: string[], manage: string): Email => ({
  subject,
  text: [...lines, '', manage].join('\n'),
  html: plain({
    subject,
    body: lines.map((line) => p(esc(line))).join('') + p(link({ label: 'Manage your gift', url: manage })),
    why: BUYER,
  }),
})

export function giftCode(input: { code: string; planKey: string; months: number; origin: string }): Email {
  const redeem = `${input.origin}/redeem?code=${encodeURIComponent(input.code)}`
  const what = giftName(input.planKey, input.months)
  const lines = [
    `Here’s your gift: ${what}. Pass the code on to whoever it’s for.`,
    'They redeem it on Cubepals, signed in to their own account, and it starts then. It works once, and it doesn’t run out.',
    'Not given it yet and changed your mind? Reply within 14 days of buying it for a full refund.',
  ]
  const subject = `Your Cubepals gift code: ${what}`
  return {
    subject,
    text: [lines[0], '', input.code, '', ...lines.slice(1), '', redeem].join('\n'),
    html: plain({
      subject,
      body:
        p(esc(lines[0] ?? '')) +
        codeLine(input.code) +
        lines
          .slice(1)
          .map((line) => p(esc(line)))
          .join('') +
        p(link({ label: 'The page to redeem it', url: redeem })),
      why: ACCOUNT,
    }),
  }
}

/** E1: the gift is paid, and the recipient has been emailed. `manage` changes its address or refunds it. */
export function giftPaid(input: Gift & { to: string; paidCents: number; manage: string }): Email {
  const what = giftName(input.planKey, input.months)
  const lines = [
    `Thank you. You paid ${dollars(input.paidCents)} for ${what}, and we’ve emailed ${input.to} to say it’s waiting for them.`,
    'It starts when they claim it, and it doesn’t expire. If they haven’t claimed it after a week, we remind them once.',
    'Until it starts, you can change the address it goes to, or get a full refund within 14 days of buying it.',
  ]
  const subject = 'Your Cubepals gift is on its way'
  return toBuyer(subject, lines, input.manage)
}

/** E1b: the buyer gives it themselves, so this carries the code to hand over. */
export function giftToHand(input: Gift & { code: string; manage: string; origin: string }): Email {
  const what = giftName(input.planKey, input.months)
  const redeem = `${new URL(input.origin).host}/redeem`
  const lines = [
    `They enter it at ${redeem}, and it starts then. It works once, and it doesn’t expire.`,
    'Not given it yet? You can get a full refund within 14 days of buying it.',
  ]
  const subject = `Your Cubepals gift code: ${what}`
  return {
    subject,
    text: [
      `Thank you. Here’s ${what}, to give to whoever it’s for:`,
      '',
      input.code,
      '',
      ...lines,
      '',
      input.manage,
    ].join('\n'),
    html: plain({
      subject,
      body:
        p(esc(`Thank you. Here’s ${what}, to give to whoever it’s for:`)) +
        codeLine(input.code) +
        lines.map((line) => p(esc(line))).join('') +
        p(link({ label: 'Manage your gift', url: input.manage })),
      why: BUYER,
    }),
  }
}

/**
 * E2: to the recipient, a gift is waiting. `account` is whether their address already has one: then
 * the gift is on it and starts on their next visit; otherwise the link makes one.
 */
export function giftWaiting(
  input: Gift & { from?: string; note?: string; account: boolean; claim: string },
): Email {
  const from = sender(input.from)
  const note = giftWords(input.note ?? '')
  const what = giftName(input.planKey, input.months)
  const sent = `${from} sent you ${what} on Cubepals, where you make a Minecraft server and play on it with your friends.`
  const how = input.account
    ? 'It’s on your Cubepals account, and starts the next time you open Cubepals, unless you save it for later.'
    : 'Open the link to make your account and claim it. It starts then, and it doesn’t expire.'
  const ignore = 'Not expecting this? You can ignore this email.'
  const label = input.account ? 'Open Cubepals' : 'Claim your gift'
  const subject = `${from} sent you ${what} on Cubepals`
  return {
    subject,
    text: [sent, ...(note ? ['', `“${note}”`, ''] : []), how, '', input.claim, '', ignore].join('\n'),
    html: plain({
      subject,
      body:
        p(esc(sent)) +
        (note ? quoted(note) : '') +
        p(esc(how)) +
        p(link({ label, url: input.claim })) +
        p(esc(ignore)),
      why: RECIPIENT,
    }),
  }
}

/** E3: to the recipient, the gift has started. `endsAt` is when its time runs out. */
export function giftStarted(input: Gift & { from?: string; endsAt: Date; origin: string }): Email {
  const plan = planName(input.planKey)
  const servers = `${input.origin}/servers`
  const lines = [
    `You have ${plan} until ${DAY.format(input.endsAt)}${input.from ? `, from ${sender(input.from)}’s gift` : ''}.`,
    'It doesn’t renew, so nothing is charged when it ends.',
  ]
  const subject = `Your gift of ${plan} has started`
  return {
    subject,
    text: [...lines, '', servers, '', UNREAD].join('\n'),
    html: layout({
      origin: input.origin,
      figure: { name: 'moss-waving' },
      heading: esc(subject),
      body: lines.map((line) => p(esc(line))).join(''),
      action: { label: 'Open Cubepals', url: servers },
      why: ACCOUNT,
      unread: true,
    }),
  }
}

/** E4: the recipient's address bounced, so the buyer changes it or takes a refund. */
export function giftBounced(input: Gift & { to: string; manage: string }): Email {
  const lines = [
    `We couldn’t deliver your gift of ${giftName(input.planKey, input.months)} to ${input.to}: the email came back.`,
    'Check the address and change it, and we’ll send the gift again. Or get a full refund, within 14 days of buying it.',
  ]
  const subject = 'Your Cubepals gift couldn’t be delivered'
  return toBuyer(subject, lines, input.manage)
}

/** E5: the one reminder, a week after `giftWaiting`, while the gift is still unclaimed. */
export function giftReminder(input: Gift & { from?: string; account: boolean; claim: string }): Email {
  const from = sender(input.from)
  const lines = [
    `${from} sent you ${giftName(input.planKey, input.months)} on Cubepals a week ago, and it’s still waiting for you.`,
    input.account
      ? 'It doesn’t expire. It starts the next time you open Cubepals.'
      : 'It doesn’t expire. Open the link whenever you’re ready, and it starts then.',
    'This is the only reminder we’ll send.',
  ]
  const subject = `Your gift from ${from} is still waiting`
  return {
    subject,
    text: [...lines, '', input.claim, '', UNREAD].join('\n'),
    html: plain({
      subject,
      body:
        lines.map((line) => p(esc(line))).join('') +
        p(link({ label: input.account ? 'Open Cubepals' : 'Claim your gift', url: input.claim })),
      why: RECIPIENT,
      unread: true,
    }),
  }
}

/**
 * E6: the gift is over before it started. `refunded` is the buyer's refund going through;
 * `voided` is any other end. Either way its link and code no longer work.
 */
export function giftEnded(
  input: Gift & { to?: string; origin: string } & (
      | { how: 'refunded'; refundedCents: number }
      | { how: 'voided' }
    ),
): Email {
  const contact = `${input.origin}/contact`
  const what = `your gift of ${giftName(input.planKey, input.months)}${input.to ? ` for ${input.to}` : ''}`
  const lines = [
    input.how === 'refunded'
      ? `Your refund of ${dollars(input.refundedCents)} for ${what} went through, back to the way you paid.`
      : `We’ve cancelled ${what}.`,
    'Its link and code no longer work, so it can’t be claimed.',
  ]
  const subject =
    input.how === 'refunded' ? 'Your Cubepals gift was refunded' : 'Your Cubepals gift was cancelled'
  return {
    subject,
    text: [...lines, '', `Questions? Write to us: ${contact}`, '', UNREAD].join('\n'),
    html: plain({
      subject,
      body:
        lines.map((line) => p(esc(line))).join('') +
        p(`Questions? ${link({ label: 'Write to us', url: contact })}.`),
      why: BUYER,
      unread: true,
    }),
  }
}
