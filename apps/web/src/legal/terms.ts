// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Terms of Service: the agreement between a player and Cubepals. Every
 * promise in it is one the product keeps today; plan facts come from `figures.ts`. Payment terms
 * in detail are the Refunds page's, and what may be run or published is the Acceptable Use page's.
 */
import { CHIP_IN_CENTS } from '@blockly/contracts'
import {
  AFK_KICK_MINUTES,
  CORE,
  DELETION_WARNINGS_DAYS,
  dollars,
  EXTRA_HOUR_CENTS,
  FREE,
  FULL_REFUND_UNDER_HOURS,
  PAID,
  PAST_DUE_GRACE_DAYS,
  PLUS,
  YEAR_REMINDER_DAYS,
} from './figures'
import type { Policy } from './policy'

export const TERMS: Policy = {
  slug: 'terms',
  title: 'Terms of Service',
  description: 'The agreement between you and {brand}.',
  summary: [
    'You must be 18 or over to have an account.',
    `The free trial costs nothing and includes ${FREE.totalHours} hours of play in all, to play on any day. ${CORE.name} (plain Minecraft) and ${PLUS.name} (with mods, plugins and modpacks) are paid by the month, VAT included where it applies, and include hours of play each month; ${PLUS.name} is also sold for a year, paid once, where it is offered. Their prices and hours are the ones shown on the [Pricing](/pricing) page and on the checkout page before you pay.`,
    'Servers sleep when nobody is playing. Worlds nobody plays rest in storage, and a world on the free trial nobody plays for a year can be deleted after two emails.',
    'We take backups, but we can’t promise a world can never be lost. Download anything you can’t lose.',
    '{brand} is not an official Minecraft service and is not approved by or associated with Mojang or Microsoft.',
    `You can cancel any time. Cancel within 14 days of buying a paid plan having played less than ${FULL_REFUND_UNDER_HOURS} hours, and you get a full refund the first time; past ${FULL_REFUND_UNDER_HOURS} hours, or if you’ve had a full refund before, you pay for the hours you played.`,
  ],
  sections: [
    {
      id: 'who',
      heading: 'Who we are',
      blocks: [
        '{brand} hosts Minecraft servers. They run Minecraft: Java Edition’s server software, and where a server lets them in, friends on Bedrock Edition join it too. You create a server, pick what to play, share its address, and your friends join. {brand} is run by {name}, based in {country} (“we”, “us”), not by a company. We have no office or company in the UK or the EU. We take notices by email, at {legal}.',
        'You can reach us at {support}. Write to {legal} for legal notices and to {privacy} about your personal data.',
        'These Terms are an agreement between you and us. They apply when you create an account or use {brand}. Our [Privacy Policy](/legal/privacy), [Refunds and cancellation](/legal/refunds), [Acceptable Use Policy](/legal/acceptable-use), [Content and copyright](/legal/takedown) and [Cookies](/legal/cookies) pages are part of them.',
      ],
    },
    {
      id: 'service',
      heading: 'The service',
      blocks: [
        'With {brand} you can run Minecraft servers, on Minecraft: Java Edition’s server software. Each server gets an address like yourserver.{playDomain} that your friends type into Minecraft, on Java Edition, or on Bedrock Edition where the server lets them in. A server starts when someone joins and sleeps when nobody is playing.',
        'We pick most things for you: where a server runs, how big it is, and how it is set up. You can change many of these later. We may change how the service works behind the scenes, as long as what you pay for stays the same or gets better. If we ever remove something you pay for, we tell you first, as {§changes} says, and if you don’t agree you can cancel and get back what you paid for the time after it, as our [Refunds](/legal/refunds#refunds) page says.',
        'We may look into how the service and a server are used, as far as we need to run it, fix it, keep it safe and improve it, and act on what we find as these Terms allow.',
        'We run the service with reasonable care and skill, but it is not guaranteed to be available at every moment. Servers depend on hosting providers, on Mojang’s services and on the internet, and sometimes we need to stop things for maintenance. We don’t promise any particular uptime.',
      ],
    },
    {
      id: 'accounts',
      heading: 'Your account, and the 18+ rule',
      blocks: [
        '**You must be 18 or over to create or use a {brand} account.** By creating one, you confirm that you are. We record which version of these Terms you agreed to, and when.',
        'People who only join someone’s server to play don’t need a {brand} account. The account holder who runs a server is responsible for who they invite to it.',
        'If we learn that an account belongs to someone under 18, we will suspend it and email the address on the account. If it was a mistake, reply within 14 days and show us. Otherwise we close the account, offer a download of its worlds where we can, and delete it as our [Privacy Policy](/legal/privacy#retention) says. If the account paid for a plan, we refund the payment for the period it was in.',
        'Keep your password safe and don’t share your account. You are responsible for what happens under your account unless it was used without your permission and you couldn’t reasonably have stopped it. Tell us at {support} straight away if you think someone else has access.',
        'Use a real email address you read. We use it for things you need to know: confirming your account, resetting your password, warnings about your play time, and warnings before a world is deleted. Now and then we may also write to you personally, to ask how it’s going. We don’t send marketing.',
        'One account per person. Don’t create extra accounts to get more free hours or servers.',
      ],
    },
    {
      id: 'plans',
      heading: 'Plans and hours',
      blocks: [
        `**The free trial** costs nothing. It includes ${FREE.totalHours} hours of play once, not every month, with no daily limit, on ${FREE.maxServers} server for up to ${FREE.maxPlayers} players at once, plain Minecraft (vanilla, or Paper without plugins), and the limits shown on the [Pricing](/pricing) page.`,
        `**${CORE.name}** is plain Minecraft for a group of friends: ${CORE.maxServers} server, for up to ${CORE.maxPlayers} players at once, with hours of play each month and the other things the [Pricing](/pricing) page lists.`,
        `**${PLUS.name}** adds mods, plugins, modpacks and datapacks, larger servers for bigger groups, and up to ${PLUS.maxServers} servers, with hours of play each month and the other things the [Pricing](/pricing) page lists.`,
        `**Paid plans by the month.** ${CORE.name} and ${PLUS.name} each cost the price a month shown on the [Pricing](/pricing) page and on the checkout page before you pay, VAT included where it applies, and include the hours of play each month shown there. A paid plan renews every month until you cancel.`,
        `**A year of ${PLUS.name}**, where it is offered, costs the price shown on the [Pricing](/pricing) page and on the checkout page before you pay, VAT included where it applies, paid once. It includes what ${PLUS.name} by the month does, with its hours starting again on the 1st of each month, except extra hours, which come with a paid plan by the month. It doesn’t renew on its own: we email you ${YEAR_REMINDER_DAYS[0]} and ${YEAR_REMINDER_DAYS[1]} days before it ends, and you can renew it from your account. Bought while you still have ${PLUS.name}, it starts when the time you already paid for ends, and a monthly subscription then stops renewing.`,
        `**Moving between paid plans.** You can move from your account. ${CORE.name} to ${PLUS.name} starts at once: you pay the difference for the rest of the month, and your subscription stays one. ${PLUS.name} to ${CORE.name} starts when the month you paid for ends, and you keep ${PLUS.name} until then; a year or a gift of ${PLUS.name} isn’t moved, and ${CORE.name} can be bought once it ends. Your worlds stay as they are: a server ${CORE.name} doesn’t run (mods, plugins, modpacks, datapacks, a larger size, or more servers than it allows) waits, whole, until you have ${PLUS.name} again or you change it to fit.`,
        'An hour of play is an hour a server is running. A large server (for big modpacks and big groups) uses two hours for each hour it runs, and the largest (for up to 100 players) uses four. A start that fails doesn’t use your hours.',
        `The free trial’s ${FREE.totalHours} hours come once: only play on the free trial counts toward them, and once they are used, your servers and worlds are kept, you can still download them, and they start again only with a paid plan. On a paid plan, hours start again on the 1st of each month, at midnight in your time zone, as your browser reports it (UTC until it has). On ${PLUS.name}, what’s left of a month’s hours, up to ${PLUS.carryHours}, carries into the next month only, and is used first there; the month you subscribe in carries nothing. On ${CORE.name} and on the free trial, nothing carries over. When an account has used its hours, its servers stop and can’t start again until its hours start again, unless you allow extra hours. Players on a server are told in game before the free trial’s hours run out, and we email you as you get close to the month’s.`,
        `**Extra hours.** On a paid plan by the month you can allow extra hours at ${dollars(EXTRA_HOUR_CENTS)} each, up to a limit you set, within the most your plan allows, and they are added to your next payment. We never charge you for play beyond your plan unless you allow it, and never past the limit you set.`,
        'Prices are in US dollars. Where we have to show a price including VAT (in the UK and the EU, for example), the price we show includes it. What you pay is always shown on the payment page before you pay.',
        `**Gifts.** You can buy time on a paid plan for someone else as a code, paid once, where the gift page offers it. It doesn’t renew. Whoever redeems it gets the plan on their own account for the time the gift gives, from when they redeem it, or from when the paid time they already have ends. A gift gives the plan as it is on the day it is redeemed, with its hours and what it includes then, not as it was on the day it was bought; a later change reaches it as {§changes} says. A code works once and doesn’t expire. It is emailed to the account that bought it, and anyone who has it can redeem it, so keep it as you would cash. We limit how many gifts one account can buy in a day. How a gift is refunded is on the [Refunds](/legal/refunds#gifts) page.`,
        '**Your price stays while you stay subscribed.** Your monthly price and hours stay the same at every renewal, even if the price for new subscribers changes. If we ever need to change them, it’s only from a later renewal, and we’ll email you first so you can decide. You can cancel before that renewal, and time you’ve already paid for keeps the price and hours you paid for it with. If your subscription ends and you subscribe again, that day’s price applies. Moving to another plan takes its price that day, shown before you confirm. A year you have paid for keeps the price you paid.',
      ],
    },
    {
      id: 'payment',
      heading: 'Paying, and who takes the payment',
      blocks: [
        'Payments are handled by Polar (polar.sh), which acts as our reseller and merchant of record. That means Polar sells you the plan on our behalf, charges your card, works out and pays the VAT or sales tax, and sends your receipts. Polar’s buyer terms apply to the payment itself. We never see or store your card details.',
        'Before your plan starts, the checkout page asks you to agree to these Terms and to ask for your plan to start straight away. We record that you did.',
        `If a renewal payment fails, you keep your plan for ${PAST_DUE_GRACE_DAYS} days while you update your card under Manage billing on your account page. After that your account moves to the free trial ({§idle} says what that means for your servers). If that payment included extra hours and is still unpaid, your servers can’t start until it is paid; you can still download your worlds.`,
        `You can also chip in to a friend’s server from its page or an invitation, from ${dollars(CHIP_IN_CENTS.min)}. It is a single payment to us, not a subscription and not a payment to the server’s owner. What you pay becomes hours of play on that server at ${dollars(EXTRA_HOUR_CENTS)} an hour, played once its owner has used their hours for that month, carried ones included, before any extra hours they would pay for. The owner sees your name and the hours you chipped in.`,
        '[Refunds and cancellation](/legal/refunds) explains how to cancel, refunds in the first 14 days, stopping a year early, gifts, chip-ins, and when we give other refunds.',
      ],
    },
    {
      id: 'idle',
      heading: 'Sleep, idle time and when a plan ends',
      blocks: [
        `To keep your hours for real play, a server stops a set time after the last player leaves: ${FREE.sleepsAfterMinutes} minutes on the free trial and ${PAID.sleepsAfterMinutes} on a paid plan. Before it stops, it saves the world and then shuts Minecraft down. A player who stands still for ${AFK_KICK_MINUTES} minutes is removed from the game, so one idle player doesn’t keep a server awake. On a paid plan the account holder can change that.`,
        'Saving before a stop is something we always try to do, but it can’t be guaranteed in every case. For example, if a server crashes, if the machine it runs on fails, or if Minecraft doesn’t answer, it may stop without saving, and whatever was played since its last save can be lost.',
        `When a paid plan ends (because you cancelled, a payment failed and wasn’t fixed, or a year or a gift ran out), your account moves to the free trial. Nothing is deleted at that moment. Servers the free trial doesn’t run (mods, plugins, modpacks, datapacks, larger sizes, or more servers than it allows) stop and wait, whole, until you have a plan that runs them again or you change them to fit. Your account then has what is left of the free trial’s ${FREE.totalHours} hours, and from then on the free trial’s rules apply to your worlds, including the one-year rule in {§worlds}.`,
      ],
    },
    {
      id: 'worlds',
      heading: 'What happens to worlds over time',
      blocks: [
        {
          list: [
            `**Resting.** A world nobody has played for ${FREE.restsAfterDays} days on the free trial (${PAID.restsAfterDays} on a paid plan) is moved into storage, and its server stops using a disk. It is still yours: joining it, or starting it from your account, brings it back. That takes longer than a normal start.`,
            `**Deleting unplayed worlds on the free trial.** On the free trial, a world nobody has played for a year can be deleted. We email you ${DELETION_WARNINGS_DAYS[0]} days and ${DELETION_WARNINGS_DAYS[1]} days before, with a way to keep it and a download. Playing it, or pressing Keep it, starts the year again. A deleted world goes to the trash first, like any deleted server.`,
            '**Worlds on a paid plan** are kept for as long as you have a paid plan.',
            '**Servers made “for a day”.** If you choose this when you create a server, it is deleted a day after it was made unless you press Keep on its page. The create page shows the exact time.',
            `**Deleting a server yourself.** A server you delete waits in the trash for ${FREE.trashDays} days on the free trial and ${PAID.trashDays} days on a paid plan, and you can bring it back until then. After that it is deleted for good, with its backups.`,
          ],
        },
        `Your worlds are yours. You can download a world from its server’s Backups page: once a day on the free trial, as often as you like on a paid plan. A download is kept for you to fetch for ${FREE.downloadDays} days on the free trial and ${PAID.downloadDays} on a paid plan.`,
      ],
    },
    {
      id: 'backups',
      heading: 'Backups (and what we can’t promise)',
      blocks: [
        `Each time a server goes to sleep after people played on it, we take a backup of it as they left it; a server that plays on without sleeping is backed up about once a day. We take another before changes like a version change, a restore or a move. The free trial keeps the latest ${FREE.backupsKept} backups taken after play, and a paid plan the latest ${PAID.backupsKept}, with a weekly download as well. A backup is a copy of the server at one moment, so restoring one loses whatever was played after it.`,
        '**Backups are there to help, not a guarantee.** We use reasonable care to keep your worlds safe, but storage and hosting can fail, and a backup can be missing or damaged. If a world matters to you, download a copy regularly and keep it somewhere of your own.',
        'If we lose or damage your world because we didn’t use reasonable care and skill, we will restore the most recent good backup we have, and you keep your legal rights described in {§liability}.',
      ],
    },
    {
      id: 'acceptable-use',
      heading: 'Using {brand} fairly',
      blocks: [
        'You agree to follow our [Acceptable Use Policy](/legal/acceptable-use). In short: only run Minecraft on {brand}, don’t break the law, don’t attack anyone or anything, don’t try to get around your plan’s limits, and keep anything you list publicly suitable for everyone.',
        'You are responsible for your servers and what happens on them, including what you upload, the mods and plugins you install, and the people you let in.',
      ],
    },
    {
      id: 'minecraft',
      heading: 'Minecraft, Mojang and Microsoft',
      blocks: [
        '**{brand} is not an official Minecraft service. It is not approved by or associated with Mojang or Microsoft.** “Minecraft” is a trademark of Mojang. We use it only to say what {brand} runs.',
        'Every server runs Minecraft’s server software under [Mojang’s End User License Agreement](https://www.minecraft.net/eula) (EULA). We download that software from Mojang for each server. By creating a server, you accept the EULA for it, and you agree to follow it and [Mojang’s Usage Guidelines](https://www.minecraft.net/usage-guidelines). Among other things these mean:',
        {
          list: [
            'everyone who plays needs their own genuine copy of Minecraft, Java Edition or Bedrock Edition. Keep your server checking players’ accounts with Minecraft (it does unless you turn it off in advanced settings) unless you have a good reason not to;',
            'if you charge players for anything on your server, you must follow Mojang’s rules about what you may sell and how, including treating every player the same;',
            'you may not sell or give away Mojang’s server software, or present your server as an official Minecraft product.',
          ],
        },
        'If Mojang or Microsoft changes its terms, its services or its account system, that may change what {brand} can offer. We’ll tell you if it affects what you pay for.',
      ],
    },
    {
      id: 'content',
      heading: 'Your content, mods and other people’s work',
      blocks: [
        'Your worlds, builds, server names, descriptions, icons and uploads belong to you (or to whoever made them). You give us permission to store, copy, run, back up and display them only as needed to run {brand} for you: for example to host your world, take backups, and show your listing to others if you publish it. That permission ends when the content is deleted from {brand}, except for backups and copies that are deleted on their normal schedule.',
        'Mods, plugins and modpacks belong to their authors and are used under their own licences. When you install one, {brand} downloads it for your server from where its author published it (such as Modrinth). We don’t own them, we don’t check every licence for you, and we don’t promise that any mod works, keeps working, or stays available. If you upload files yourself, you must have the right to use them.',
        'If you think something on {brand} breaks your copyright or another right, see [Content and copyright](/legal/takedown).',
      ],
    },
    {
      id: 'listings',
      heading: 'Public listings and moderation',
      blocks: [
        'Servers are private until you choose to publish one. A published server gets a public page and may appear in the server directory. Its page shows its name, description, icon, version and mods, how many players are on, and, if it checks accounts, the Minecraft names of the players on right now. People signed in to {brand} can star a server and leave a short note on it.',
        'A server with Stop cheaters on can remove a player automatically when its cheat check sees moves or data the game can’t make. Where the server’s owner uses the moderation tools, it can also ban that player from the server for a while if it keeps happening. The owner can lift the ban.',
        'Anyone signed in can report a listing. We review reports and may remove a listing, with a note to its owner saying why. We may also remove listings or notes on our own if they break these Terms or the law. If you disagree with a decision, reply to our email or write to {support} and we will look at it again.',
      ],
    },
    {
      id: 'suspension',
      heading: 'Suspending or closing accounts',
      blocks: [
        'You can stop using {brand} at any time. To close your account and delete your data, email {support} from the address on your account. Cancel any paid plan first (see [Refunds and cancellation](/legal/refunds)).',
        'We may limit, suspend or close an account, or stop a server, if we reasonably believe that:',
        {
          list: [
            'it breaks these Terms or the Acceptable Use Policy in a serious way, or keeps breaking them after we have asked you to stop;',
            'it puts other players, the service or our providers at risk (for example an attack, malware or a server that harms our machines);',
            'we have to because of the law, a court, the police, or a valid notice from a rights holder;',
            'the account holder is under 18 ({§accounts});',
            'a payment to us is reversed or disputed with your bank without your writing to us first, or an amount you owe is left unpaid.',
          ],
        },
        'For an amount you owe, we limit the account rather than close it: until it is paid, your servers can’t start and you can’t make new ones, but you can still download your worlds, and the limit lifts once it is paid. For a payment reversed or disputed, we may limit or suspend the account until it is settled.',
        'Where we can, we tell you first, say why, and give you a chance to fix it. In urgent cases we act first and explain afterwards. When we restrict something we will tell you which rule it was and how to ask us to look again.',
        'If we close an account for a serious breach, we don’t refund the current month. If we close it for any other reason, or stop offering {brand} altogether, we refund the unused part of what you paid and, wherever we can, give you at least 30 days’ notice and a way to download your worlds first.',
      ],
    },
    {
      id: 'liability',
      heading: 'Our responsibility to you',
      blocks: [
        '**Nothing in these Terms takes away rights you have by law.** If you are a consumer in the UK or the EU, you have legal rights in relation to services and digital services that are not provided as described or with reasonable care and skill: for example to have the problem put right, to a price reduction, or to end the contract. Your local consumer advice service can tell you more.',
        'If we break these Terms or are negligent, we are responsible for loss or damage you suffer that was a foreseeable result of that. Loss is foreseeable if it was obvious it would happen, or if we both knew it might happen when you agreed to these Terms. We are not responsible for loss that wasn’t foreseeable.',
        '{brand} is made for playing with friends. You may use it in the course of a business (a server that charges its players, for example), but the rights the law gives only to consumers, such as the 14-day right to cancel, consumers’ legal remedies and the right to bring a claim in the courts of the country where you live, don’t apply to that use. The refunds our [Refunds](/legal/refunds) page offers still apply as it says. We are not responsible for business losses, such as lost profit, lost revenue or business interruption.',
        'Unless the law says otherwise, our total responsibility to you for everything arising in any 12 months is limited to the larger of (a) what you paid us in those 12 months and (b) 100 US dollars.',
        'Nothing in these Terms limits or excludes our responsibility for death or personal injury caused by our negligence, for fraud or fraudulent misrepresentation, or for anything else that the law doesn’t allow us to limit or exclude.',
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to these Terms',
      blocks: [
        'We update these Terms from time to time: when {brand} changes, when the law changes, or to make something clearer. The date at the top of each page says when it last changed.',
        'Updates apply from the day we post them, and if one affects you, we’ll email you so nothing catches you by surprise. If you’re paying for a plan, anything that would cost you more or take away something you pay for only starts at your next renewal after that email, never partway through time you’ve already paid for ({§plans}). You’re never locked in: you can cancel your plan before that renewal, or close your account whenever you like. Carrying on with {brand} after an update means the new Terms apply.',
      ],
    },
    {
      id: 'law',
      heading: 'Law and disputes',
      blocks: [
        'If you have a problem, please write to {support} first. Most things can be sorted out quickly.',
        'These Terms are governed by {law}. If you are a consumer, you also keep the protection of the mandatory laws of the country where you live, and you can bring a claim in the courts of that country.',
        'If any part of these Terms can’t be enforced, the rest still applies. If we don’t enforce a right straight away, we can still enforce it later. These Terms are between you and us; nobody else can enforce them. You can’t transfer your account or these Terms to someone else. We can transfer our rights and duties to someone who takes over running {brand}, and we will tell you if we do; this won’t reduce your rights.',
      ],
    },
  ],
}
