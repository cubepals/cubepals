/**
 * The Terms of Service: the agreement between a player and the person who runs Cubepals. Every
 * promise in it is one the product keeps today; plan facts come from `figures.ts`. Payment terms
 * in detail are the Refunds page's, and what may be run or published is the Acceptable Use page's.
 */
import {
  AFK_KICK_MINUTES,
  DELETION_WARNINGS_DAYS,
  dollars,
  FREE,
  FULL_REFUND_UNDER_HOURS,
  PAST_DUE_GRACE_DAYS,
  PLUS,
} from './figures'
import type { Policy } from './policy'

export const TERMS: Policy = {
  slug: 'terms',
  title: 'Terms of Service',
  description: 'The agreement between you and the person who runs {brand}.',
  summary: [
    'You must be 18 or over to have an account.',
    `Free costs nothing and includes ${FREE.hours} hours of play a month. ${PLUS.name} is ${dollars(PLUS.priceCents)} a month, VAT included where it applies, and includes ${PLUS.hours}.`,
    'Servers sleep when nobody is playing. Worlds nobody plays rest in storage, and a free world nobody plays for a year can be deleted after two emails.',
    'We take backups, but we can’t promise a world can never be lost. Download anything you can’t lose.',
    '{brand} is not an official Minecraft service and is not approved by or associated with Mojang or Microsoft.',
    `You can cancel any time. Cancel within 14 days of buying ${PLUS.name} having played less than ${FULL_REFUND_UNDER_HOURS} hours and you get a full refund; past that, you pay for the hours you played.`,
  ],
  sections: [
    {
      id: 'who',
      heading: '1. Who we are',
      blocks: [
        '{brand} is a Minecraft: Java Edition server host. You create a server, pick what to play, share its address, and your friends join. {brand} is run by one person, {name}, an individual based in {country} (“we”, “us”), not by a company. We have no office or company in the UK or the EU. Our postal address for notices is {address}.',
        'You can reach us at {support}. Write to {legal} for legal notices and to {privacy} about your personal data.',
        'These Terms are an agreement between you and us. They apply when you create an account or use {brand}. Our [Privacy Policy](/legal/privacy), [Refunds and cancellation](/legal/refunds), [Acceptable Use Policy](/legal/acceptable-use), [Content and copyright](/legal/takedown) and [Cookies](/legal/cookies) pages are part of them.',
      ],
    },
    {
      id: 'service',
      heading: '2. The service',
      blocks: [
        'With {brand} you can run Minecraft: Java Edition servers. Each server gets an address like yourserver.{playDomain} that your friends type into Minecraft. A server starts when someone joins and sleeps when nobody is playing.',
        'We pick most things for you: where a server runs, how big it is, and how it is set up. You can change many of these later. We may change how the service works behind the scenes, as long as what you pay for stays the same or gets better. If we ever remove something you pay for, section 13 says what happens.',
        'We run the service with reasonable care and skill, but it is not guaranteed to be available at every moment. Servers depend on hosting providers, on Mojang’s services and on the internet, and sometimes we need to stop things for maintenance. We don’t promise any particular uptime.',
      ],
    },
    {
      id: 'accounts',
      heading: '3. Your account, and the 18+ rule',
      blocks: [
        '**You must be 18 or over to create or use a {brand} account.** By creating one, you confirm that you are. We record which version of these Terms you agreed to, and when.',
        'People who only join someone’s server to play don’t need a {brand} account. The account holder who runs a server is responsible for who they invite to it.',
        'If we learn that an account belongs to someone under 18, we will suspend it and email the address on the account. If it was a mistake, reply within 14 days and show us. Otherwise we close the account, offer a download of its worlds where we can, and delete it as our [Privacy Policy](/legal/privacy#retention) says. If the account paid for a plan, we refund the payment for the period it was in.',
        'Keep your password safe and don’t share your account. You are responsible for what happens under your account unless it was used without your permission and you couldn’t reasonably have stopped it. Tell us at {support} straight away if you think someone else has access.',
        'Use a real email address you read. We use it for things you need to know: confirming your account, resetting your password, warnings about your play time, and warnings before a world is deleted.',
        'One account per person. Don’t create extra accounts to get more free hours or servers.',
      ],
    },
    {
      id: 'plans',
      heading: '4. Plans and hours',
      blocks: [
        `**Free** costs nothing. It includes ${FREE.hours} hours of play each calendar month on ${FREE.maxServers} server, plain Minecraft (vanilla or Paper without plugins), and the limits shown on the [Pricing](/pricing) page.`,
        `**${PLUS.name}** costs ${dollars(PLUS.priceCents)} a month, VAT included where it applies. It includes ${PLUS.hours} hours of play each calendar month on up to ${PLUS.maxServers} servers, mods, plugins and modpacks, and the other things the [Pricing](/pricing) page lists. It renews every month until you cancel.`,
        'An hour of play is an hour a server is running. A large server (for big modpacks and big groups) uses two hours for each hour it runs. A start that fails doesn’t use your hours.',
        'Hours start again on the 1st of each month (UTC). Unused hours don’t carry over. When an account has used its hours, its servers stop and can’t start again until the 1st. We email you as you get close. We never charge you for play beyond your plan.',
        'Prices are in US dollars. Where we have to show a price including VAT (in the UK and the EU, for example), the price we show includes it. What you pay is always shown on the payment page before you pay.',
        'If we change the price of a plan you pay for, we will email you at least 30 days before the change applies to you. The new price applies from your next renewal after that. If you don’t want to pay it, cancel before then.',
      ],
    },
    {
      id: 'payment',
      heading: '5. Paying, and who takes the payment',
      blocks: [
        'Payments are handled by Polar (polar.sh), which acts as our reseller and merchant of record. That means Polar sells you the subscription on our behalf, charges your card, works out and pays the VAT or sales tax, and sends your receipts. Polar’s buyer terms apply to the payment itself. We never see or store your card details.',
        'Before your plan starts, the checkout page asks you to agree to these Terms and to ask for your plan to start straight away. We record that you did.',
        `If a renewal payment fails, you keep ${PLUS.name} for ${PAST_DUE_GRACE_DAYS} days while you update your card under Manage billing on your account page. After that your account moves to Free (section 6 says what that means for your servers).`,
        '[Refunds and cancellation](/legal/refunds) explains how to cancel, refunds in the first 14 days, and when we give other refunds.',
      ],
    },
    {
      id: 'idle',
      heading: '6. Sleep, idle time and when a plan ends',
      blocks: [
        `To keep your hours for real play, a server stops a set time after the last player leaves: ${FREE.sleepsAfterMinutes} minutes on Free and ${PLUS.sleepsAfterMinutes} on ${PLUS.name}. Before it stops, it saves the world and then shuts Minecraft down. A player who stands still for ${AFK_KICK_MINUTES} minutes is removed from the game, so one idle player doesn’t keep a server awake. On ${PLUS.name} the account holder can change that.`,
        'Saving before a stop is something we always try to do, but it can’t be guaranteed in every case. For example, if a server crashes, if the machine it runs on fails, or if Minecraft doesn’t answer, it may stop without saving, and whatever was played since its last save can be lost.',
        `When ${PLUS.name} ends (because you cancelled, or a payment failed and wasn’t fixed), your account moves to Free. Nothing is deleted at that moment. Servers that need ${PLUS.name} (mods, plugins, modpacks, larger sizes, or more servers than Free allows) stop and wait, whole, until you have ${PLUS.name} again or you change them to fit Free. From then on Free’s rules apply to your worlds, including the one-year rule in section 7.`,
      ],
    },
    {
      id: 'worlds',
      heading: '7. What happens to worlds over time',
      blocks: [
        {
          list: [
            `**Resting.** A world nobody has played for ${FREE.restsAfterDays} days on Free (${PLUS.restsAfterDays} on ${PLUS.name}) is moved into storage, and its server stops using a disk. It is still yours: joining it, or starting it from your account, brings it back. That takes longer than a normal start.`,
            `**Deleting unplayed free worlds.** On Free, a world nobody has played for a year can be deleted. We email you ${DELETION_WARNINGS_DAYS[0]} days and ${DELETION_WARNINGS_DAYS[1]} days before, with a way to keep it and a download. Playing it, or pressing Keep it, starts the year again. A deleted world goes to the trash first, like any deleted server.`,
            `**${PLUS.name} worlds** are kept for as long as you have ${PLUS.name}.`,
            '**Servers made “for a day”.** If you choose this when you create a server, it is deleted a day after it was made unless you press Keep on its page. The create page shows the exact time.',
            `**Deleting a server yourself.** A server you delete waits in the trash for ${FREE.trashDays} days on Free and ${PLUS.trashDays} days on ${PLUS.name}, and you can bring it back until then. After that it is deleted for good, with its backups.`,
          ],
        },
        `Your worlds are yours. You can download a world from its server’s Backups page: once a day on Free, as often as you like on ${PLUS.name}. A download is kept for you to fetch for ${FREE.downloadDays} days on Free and ${PLUS.downloadDays} on ${PLUS.name}.`,
      ],
    },
    {
      id: 'backups',
      heading: '8. Backups (and what we can’t promise)',
      blocks: [
        `While a server is being played, we take a backup of it about once a day, and another before changes like a version change, a restore or a move. Free keeps the latest ${FREE.backupsKept} daily backups, ${PLUS.name} the latest ${PLUS.backupsKept}, and ${PLUS.name} also keeps a weekly download. A backup is a copy of the server at one moment, so restoring one loses whatever was played after it.`,
        '**Backups are there to help, not a guarantee.** We use reasonable care to keep your worlds safe, but storage and hosting can fail, and a backup can be missing or damaged. If a world matters to you, download a copy regularly and keep it somewhere of your own.',
        'If we lose or damage your world because we didn’t use reasonable care and skill, we will restore the most recent good backup we have, and you keep your legal rights described in section 14.',
      ],
    },
    {
      id: 'acceptable-use',
      heading: '9. Using {brand} fairly',
      blocks: [
        'You agree to follow our [Acceptable Use Policy](/legal/acceptable-use). In short: only run Minecraft on {brand}, don’t break the law, don’t attack anyone or anything, don’t try to get around your plan’s limits, and keep anything you list publicly suitable for everyone.',
        'You are responsible for your servers and what happens on them, including what you upload, the mods and plugins you install, and the people you let in.',
      ],
    },
    {
      id: 'minecraft',
      heading: '10. Minecraft, Mojang and Microsoft',
      blocks: [
        '**{brand} is not an official Minecraft service. It is not approved by or associated with Mojang or Microsoft.** “Minecraft” is a trademark of Mojang. We use it only to say what {brand} runs.',
        'Every server runs Minecraft’s server software under [Mojang’s End User License Agreement](https://www.minecraft.net/eula) (EULA). We download that software from Mojang for each server. By creating a server, you accept the EULA for it, and you agree to follow it and [Mojang’s Usage Guidelines](https://www.minecraft.net/usage-guidelines). Among other things these mean:',
        {
          list: [
            'everyone who plays needs their own copy of Minecraft: Java Edition. Keep your server checking players’ accounts with Minecraft (it does unless you turn it off in advanced settings) unless you have a good reason not to;',
            'if you charge players for anything on your server, you must follow Mojang’s rules about what you may sell and how, including treating every player the same;',
            'you may not sell or give away Mojang’s server software, or present your server as an official Minecraft product.',
          ],
        },
        'If Mojang or Microsoft changes its terms, its services or its account system, that may change what {brand} can offer. We’ll tell you if it affects what you pay for.',
      ],
    },
    {
      id: 'content',
      heading: '11. Your content, mods and other people’s work',
      blocks: [
        'Your worlds, builds, server names, descriptions, icons and uploads belong to you (or to whoever made them). You give us permission to store, copy, run, back up and display them only as needed to run {brand} for you: for example to host your world, take backups, and show your listing to others if you publish it. That permission ends when the content is deleted from {brand}, except for backups and copies that are deleted on their normal schedule.',
        'Mods, plugins and modpacks belong to their authors and are used under their own licences. When you install one, {brand} downloads it for your server from where its author published it (such as Modrinth). We don’t own them, we don’t check every licence for you, and we don’t promise that any mod works, keeps working, or stays available. If you upload files yourself, you must have the right to use them.',
        'If you think something on {brand} breaks your copyright or another right, see [Content and copyright](/legal/takedown).',
      ],
    },
    {
      id: 'listings',
      heading: '12. Public listings and moderation',
      blocks: [
        'Servers are private until you choose to publish one. A published server gets a public page and may appear in the server directory. Its page shows its name, description, icon, version and mods, how many players are on, and, if it checks accounts, the Minecraft names of the players on right now. People signed in to {brand} can star a server and leave a short note on it.',
        'Anyone signed in can report a listing. We review reports and may remove a listing, with a note to its owner saying why. We may also remove listings or notes on our own if they break these Terms or the law. If you disagree with a decision, reply to our email or write to {support} and we will look at it again.',
      ],
    },
    {
      id: 'suspension',
      heading: '13. Suspending or closing accounts',
      blocks: [
        'You can stop using {brand} at any time. To close your account and delete your data, email {support} from the address on your account. Cancel any paid plan first (see [Refunds and cancellation](/legal/refunds)).',
        'We may limit, suspend or close an account, or stop a server, if we reasonably believe that:',
        {
          list: [
            'it breaks these Terms or the Acceptable Use Policy in a serious way, or keeps breaking them after we have asked you to stop;',
            'it puts other players, the service or our providers at risk (for example an attack, malware or a server that harms our machines);',
            'we have to because of the law, a court, the police, or a valid notice from a rights holder;',
            'the account holder is under 18 (section 3).',
          ],
        },
        'Where we can, we tell you first, say why, and give you a chance to fix it. In urgent cases we act first and explain afterwards. When we restrict something we will tell you which rule it was and how to ask us to look again.',
        'If we close an account for a serious breach, we don’t refund the current month. If we close it for any other reason, or stop offering {brand} altogether, we refund the unused part of what you paid and, wherever we can, give you at least 30 days’ notice and a way to download your worlds first.',
      ],
    },
    {
      id: 'liability',
      heading: '14. Our responsibility to you',
      blocks: [
        '**Nothing in these Terms takes away rights you have by law.** If you are a consumer in the UK or the EU, you have legal rights in relation to services and digital services that are not provided as described or with reasonable care and skill: for example to have the problem put right, to a price reduction, or to end the contract. Your local consumer advice service can tell you more.',
        'If we break these Terms or are negligent, we are responsible for loss or damage you suffer that was a foreseeable result of that. Loss is foreseeable if it was obvious it would happen, or if we both knew it might happen when you agreed to these Terms. We are not responsible for loss that wasn’t foreseeable.',
        '{brand} is for personal, non-commercial use. We are not responsible for business losses, such as lost profit, lost revenue or business interruption.',
        'For a paid plan, unless the law says otherwise, our total responsibility to you for everything arising in any 12 months is limited to the larger of (a) what you paid us in those 12 months and (b) 100 US dollars.',
        'Nothing in these Terms limits or excludes our responsibility for death or personal injury caused by our negligence, for fraud or fraudulent misrepresentation, or for anything else that the law doesn’t allow us to limit or exclude.',
      ],
    },
    {
      id: 'changes',
      heading: '15. Changes to these Terms',
      blocks: [
        'We may change these Terms, for example when the service changes, when the law changes, or to make them clearer. The date at the top of each page says when it last changed.',
        'If a change matters to you, we will email you at least 30 days before it takes effect, unless the law or a security risk makes us change something sooner. If you don’t agree with the change, you can stop using {brand} and close your account before it takes effect, and if you pay for a plan, cancel it and get a refund for any time you paid for after the change. If you keep using {brand} after the change takes effect, the new Terms apply.',
      ],
    },
    {
      id: 'law',
      heading: '16. Law and disputes',
      blocks: [
        'If you have a problem, please write to {support} first. Most things can be sorted out quickly.',
        'These Terms are governed by {law}. If you are a consumer, you also keep the protection of the mandatory laws of the country where you live, and you can bring a claim in the courts of that country.',
        'If any part of these Terms can’t be enforced, the rest still applies. If we don’t enforce a right straight away, we can still enforce it later. These Terms are between you and us; nobody else can enforce them. You can’t transfer your account or these Terms to someone else. We can transfer our rights and duties to someone who takes over running {brand}, and we will tell you if we do; this won’t reduce your rights.',
      ],
    },
  ],
}
