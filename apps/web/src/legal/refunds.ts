// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refunds and cancellation: how to cancel, the refund within 14 days of buying, what happens
 * when a plan ends, gifts, and chipping in to a friend's server. Within 14 days, a full refund
 * below `FULL_REFUND_UNDER_HOURS` of play (a
 * policy choice); at or past it, the UK/EU right to cancel still holds, and the refund is the part
 * not played, counted in hours (Consumer Contracts Regulations 2013 reg. 36(4); Directive
 * 2011/83/EU Art. 14(3)). That right can't be agreed away, so the page never says "no refund".
 * Polar is the merchant of record and pays refunds out; we decide them. A year of Plus, paid at
 * once, never renews; the same 14 days apply to its first month, and after them stopping early
 * refunds each whole month left, a twelfth of what was paid each (`billing/years.ts` ends the year
 * where what was refunded says). A gift of Plus is refunded in full before it is redeemed, and as
 * Plus after. A chip-in's hours not yet played are refunded within 14 days of it.
 */
import {
  dollars,
  EXTRA_HOUR_CENTS,
  FREE,
  FULL_REFUND_UNDER_HOURS,
  PAST_DUE_GRACE_DAYS,
  PLUS,
  YEAR_REMINDER_DAYS,
} from './figures'
import type { Policy } from './policy'

/** What a year of Plus costs, and the twelfth of it each of its months is worth. */
const YEAR = PLUS.yearPriceCents ?? 0
const MONTH_OF_YEAR = YEAR / 12

export const REFUNDS: Policy = {
  slug: 'refunds',
  title: 'Refunds and cancellation',
  description:
    'How to cancel a paid plan, refunds in the first 14 days, stopping a year early, gifts, chipping in to a friend’s server, and how refunds work.',
  summary: [
    `You can cancel ${PLUS.name} any time from your account. You keep it until the end of the month you paid for, and you aren’t charged again, except for any extra hours you allowed and played.`,
    `Cancel within 14 days of buying ${PLUS.name} having played less than ${FULL_REFUND_UNDER_HOURS} hours, and you get everything back.`,
    `Played ${FULL_REFUND_UNDER_HOURS} hours or more? You pay for the hours you played, and get back only the part you didn’t use.`,
    `A year of ${PLUS.name} is paid once and doesn’t renew. After its first 14 days you can stop it early, and we refund each whole month left.`,
    `A gift code nobody has redeemed can be refunded in full within 14 days of buying it. Once it’s redeemed, it is refunded the way ${PLUS.name} is.`,
    'Chipped in to a friend’s server? Within 14 days, you can get back what you paid for the hours nobody has played yet.',
    'Payments and refunds go through Polar, our merchant of record.',
  ],
  sections: [
    {
      id: 'cancel',
      heading: '1. Cancelling your plan',
      blocks: [
        `You can cancel ${PLUS.name} at any time, with no notice period. Go to your [account](/account), choose **Manage billing**, and cancel there. You can also email {support} from the address on your account and we’ll do it for you.`,
        `When you cancel, you keep ${PLUS.name} until the end of the month you have already paid for, and you won’t be charged again, except once at the end of it for any extra hours you allowed and played. You can change your mind and keep the subscription going any time before that date.`,
        `A year of ${PLUS.name} (${dollars(YEAR)}) is paid once and doesn’t renew, so there is nothing to cancel: it ends on the day your [account](/account) shows, and we email you ${YEAR_REMINDER_DAYS[0]} and ${YEAR_REMINDER_DAYS[1]} days before. You can renew it from your account whenever you like, and the new year starts the day the old one ends. To stop a year early, see section 4.`,
        'Cancelling doesn’t delete your account or your worlds. To delete those as well, see our [Terms](/legal/terms#suspension).',
      ],
    },
    {
      id: 'withdrawal',
      heading: '2. Refunds in the first 14 days',
      blocks: [
        `If you cancel within 14 days of the day you bought ${PLUS.name}, what you get back depends on how much you played. Hours are counted as your [account](/account) shows them: a large server counts two hours for each hour it runs, and the largest counts four.`,
        {
          list: [
            `**Less than ${FULL_REFUND_UNDER_HOURS} hours played: a full refund.** You don’t have to give a reason.`,
            `**${FULL_REFUND_UNDER_HOURS} hours or more: you pay for what you played.** We keep the share of the price for the hours you used, out of the ${PLUS.hours} ${PLUS.name} includes, and refund the rest. For example, if you played 60 hours, we keep 60/${PLUS.hours} of the price and refund ${PLUS.hours - 60}/${PLUS.hours}. Once you have played all ${PLUS.hours}, there is nothing left to refund.`,
          ],
        },
        `**If you bought a year,** the same applies to its first month, a twelfth of what you paid (${dollars(MONTH_OF_YEAR)} of ${dollars(YEAR)}), and the other eleven months are refunded in full. For example, if you played 60 hours, we keep 60/${PLUS.hours} of ${dollars(MONTH_OF_YEAR)}, which is ${dollars((MONTH_OF_YEAR * 60) / PLUS.hours)}, and refund ${dollars(YEAR - (MONTH_OF_YEAR * 60) / PLUS.hours)}.`,
        `${PLUS.name} is a service. Before you pay, the checkout page asks you to agree that it starts straight away, inside those 14 days, so you can play at once, and that if you cancel you pay for the hours you played as this section says.`,
        `If you are a consumer in the UK, the EU, Norway or Iceland, the law gives you the right to cancel a contract made online within 14 days, paying only for what you have already had. This section is how we apply that right, and it never gives you less.`,
        `The 14 days start on the day you buy ${PLUS.name}. Monthly renewals after that are not new purchases, so they don’t start a new 14 days, but you can still cancel any time as section 1 says. Renewing a year is a new purchase, with 14 days of its own; one that hasn’t started yet is refunded in full.`,
        `**How to cancel within the 14 days:** email {support} from the address on your account, saying that you are cancelling (withdrawing from) your contract. You can use the form below, but you don’t have to. You only need to send it before the 14 days end. We will confirm by email that we received it. ${PLUS.name} then ends straight away, and your account moves to Free (section 7).`,
        'We will refund you without undue delay, and no later than 14 days after you tell us, to the payment method you used. You won’t pay any fee for the refund.',
      ],
    },
    {
      id: 'form',
      heading: '3. Model cancellation form',
      blocks: [
        'Copy, fill in and email this to {support} if you’d like to use it:',
        {
          list: [
            'To: {name}, {support}',
            `I hereby give notice that I withdraw from my contract for the provision of the following service: ${PLUS.name} on {brand} (by the month, or for a year).`,
            'Ordered on: [date]',
            'Name: [your name]',
            'Email address on the account: [your email]',
            'Address: [your address]',
            'Date: [today’s date]',
          ],
        },
      ],
    },
    {
      id: 'year',
      heading: '4. Stopping a year early',
      blocks: [
        `After the first 14 days, you can stop a year of ${PLUS.name} at any time: email {support} from the address on your account. You keep ${PLUS.name} until the end of the month of your year you are in, counted from the day the year started, and we refund each whole month after it, at a twelfth of what you paid for the year.`,
        `For example, stop a ${dollars(YEAR)} year 4 months and 10 days after it started: you keep ${PLUS.name} until the end of its fifth month, and we refund the 7 months left, ${dollars(MONTH_OF_YEAR * 7)}.`,
      ],
    },
    {
      id: 'refunds',
      heading: '5. Other refunds',
      blocks: [
        'After the first 14 days, a month you have already started isn’t refunded when you cancel: you keep it until its end (section 1). We will refund you, in full or in part, when:',
        {
          list: [
            'the law gives you the right to one, for example because the service wasn’t provided as described or with reasonable care and skill;',
            'you were charged by mistake, or charged twice;',
            'we close your account or stop offering {brand} for a reason that isn’t your fault (see our [Terms](/legal/terms#suspension));',
            'a price change or a change to these Terms you didn’t agree to takes effect while you have time paid for.',
          ],
        },
        'To ask for a refund, email {support} from the address on your account. Please write to us before disputing a payment with your bank: we can usually sort it out faster.',
      ],
    },
    {
      id: 'polar',
      heading: '6. Who pays the refund',
      blocks: [
        `Paid plans are sold through Polar (Polar Software, Inc.), which acts as our reseller and merchant of record. Your payment, receipts and any refund come from Polar, and your statement shows Polar. Prices are in US dollars and include VAT where it applies; ${PLUS.name} is ${dollars(PLUS.priceCents)} a month, or ${dollars(YEAR)} for a year. Refunds include the VAT you paid on the refunded amount.`,
        'Polar’s own buyer terms apply to the payment. They don’t reduce the rights on this page, which we honour for {brand}.',
      ],
    },
    {
      id: 'lapse',
      heading: '7. When a paid plan ends',
      blocks: [
        `If a renewal payment fails, you keep ${PLUS.name} for ${PAST_DUE_GRACE_DAYS} days while you update your card under Manage billing. We show you the date on your account page.`,
        `When ${PLUS.name} ends (because you cancelled, a payment wasn’t fixed in time, or a year you paid for ran out), your account moves to Free. Nothing is deleted at that moment:`,
        {
          list: [
            `servers that need ${PLUS.name} (mods, plugins or modpacks, larger sizes, or more servers than Free allows) stop and wait, whole, until you have ${PLUS.name} again or change them to fit Free;`,
            `your account then has what is left of Free’s ${FREE.totalHours} hours, and Free’s other limits;`,
            `your worlds follow Free’s rules from then on: a world nobody plays rests in storage after ${FREE.restsAfterDays} days, and one nobody has played for a year can be deleted, after two emails. Download anything you want to keep.`,
          ],
        },
      ],
    },
    {
      id: 'gifts',
      heading: '8. Gifts',
      blocks: [
        `A gift of ${PLUS.name} is paid once by the person who buys it, and the refund goes back to them, to the payment method they used.`,
        `**Not redeemed yet: a full refund within 14 days of buying it.** Reply to the email the code came in, or email {support} from the address on the account that bought it. The code stops working straight away.`,
        `**Redeemed: as ${PLUS.name}.** Within 14 days of buying the gift, section 2 applies to the hours played on the account that redeemed it: a full refund below ${FULL_REFUND_UNDER_HOURS} hours, otherwise the part not played. The gifted ${PLUS.name} then ends straight away, and that account moves to Free (section 7).`,
        'After the 14 days, a gift is refunded only for the reasons in section 5.',
        'A gift doesn’t renew, so there is nothing to cancel. When its time runs out, the account that redeemed it moves to Free, as section 7 says, unless it has another gift or a plan of its own.',
      ],
    },
    {
      id: 'chip-in',
      heading: '9. Chipping in to a friend’s server',
      blocks: [
        `When you chip in to a server, you pay once, and what you pay becomes hours of play on that server at ${dollars(EXTRA_HOUR_CENTS)} an hour, VAT included where it applies. A large server uses two hours for each hour it runs, and the largest uses four. The hours stay with the server until they are played. They are played once its owner has used their own hours for that month, carried ones included, and while the owner doesn’t have ${PLUS.name}, they wait.`,
        '**Within 14 days of chipping in,** you can ask for a refund of the hours that haven’t been played yet: email {support} from the address on your account. We refund that share of what you paid. You don’t have to give a reason.',
        '**After 14 days,** a chip-in isn’t refunded, except in the cases section 5 lists. If the server is deleted for good while hours you chipped in are still on it, we refund those hours when you ask.',
        'Your chip-in is a payment to {brand}, not to the server’s owner. The owner sees your name and the hours you chipped in.',
      ],
    },
  ],
}
