/**
 * The Privacy Policy, for the UK GDPR and the EU GDPR: who is responsible, what is collected and
 * why, who else handles it, how long it is kept and how to use your rights. Every line matches
 * what the code does; nothing here is aspiration.
 */
import { DELETION_WARNINGS_DAYS, FREE, PLUS } from './figures'
import type { Policy } from './policy'

export const PRIVACY: Policy = {
  slug: 'privacy',
  title: 'Privacy Policy',
  description: 'What personal data {brand} collects, why, who else handles it, and your rights.',
  summary: [
    'We collect what we need to run your account and your servers: your email, how you sign in, your servers and worlds, and the Minecraft names of the people who play on them.',
    'We don’t sell your data, show ads, or use tracking cookies. We count how {brand} is used without cookies or anything stored on your device.',
    '{brand} is run by one person in {country}. Your servers and our database are in Frankfurt, Germany, unless you move a server. Some of the companies that help us run {brand} are in the US.',
    'You can ask us for a copy of your data, to correct it, or to delete it, by emailing {privacy}.',
  ],
  sections: [
    {
      id: 'controller',
      heading: '1. Who is responsible for your data',
      blocks: [
        '{brand} is run by {name}, based in {country} (“we”, “us”). We are the controller of the personal data described here. We take notices by email, at {legal}.',
        'We have no office or company in the UK or the EU. Because we offer {brand} to people there, the UK GDPR and the EU GDPR apply to us all the same.',
        'For anything about your personal data, email {privacy}. We don’t have a data protection officer; the person who runs {brand} answers these emails.',
      ],
    },
    {
      id: 'what',
      heading: '2. What we collect, why, and on what legal basis',
      blocks: [
        'The law asks us to say which “legal basis” lets us use each kind of data. The ones we rely on are: **contract** (we need it to provide the service you signed up for), **legitimate interests** (we need it to keep {brand} safe and working, and we’ve checked this doesn’t override your interests), and **legal obligation** (the law requires it).',
        {
          table: {
            head: ['What', 'Why', 'Legal basis'],
            rows: [
              [
                '**Your account:** email address, password (stored only as a secure hash), whether you’ve confirmed your email, and when you joined. If you sign in with Google or GitHub: your name and profile picture address from that account, its account ID, and the sign-in tokens it gives us.',
                'To create your account, sign you in, and email you things about your account and servers.',
                'Contract',
              ],
              [
                '**Your agreement:** which version of the Terms you agreed to when you made your account, and when; and, before a paid plan starts, that you asked for it to start straight away.',
                'To show who agreed to what.',
                'Legal obligation and legitimate interests',
              ],
              [
                '**Sign-in sessions:** a session token, the IP address and browser details the session was started from, and when it expires.',
                'To keep you signed in, let you sign out everywhere, and spot and stop account misuse. We also limit sign-in attempts by IP address, in memory only.',
                'Contract and legitimate interests',
              ],
              [
                '**Your servers:** names, descriptions, icons, tags, settings (such as the message of the day), the world and everything in it, mods and files you upload, backups and downloads, and a history of changes you make.',
                'To run, back up and restore your servers.',
                'Contract',
              ],
              [
                '**Players on your servers:** Minecraft usernames and player IDs (UUIDs) of people who join, when each was first and last seen, who is on right now, and your allow list, operator list and bans (with any reason you give). Minecraft also keeps its own files and logs inside the world, which include player names, positions and chat.',
                'To run the server you asked for, show who is on, and manage who may join.',
                'Contract (for you) and legitimate interests (for the players, who expect the server to work)',
              ],
              [
                '**Public listings:** if you publish a server, the details shown on its public page and in the directory, including the names of players on right now (only if the server checks accounts). Stars and short notes left by signed-in visitors.',
                'To show the servers people chose to publish.',
                'Contract',
              ],
              [
                '**Reports:** who reported a listing and what they wrote.',
                'To review reports and keep the directory safe.',
                'Legitimate interests',
              ],
              [
                '**Usage and billing:** how long your servers ran and on which sizes, your plan, your subscription status from Polar, and order records (amount, tax, currency, refunds). We never receive your card details.',
                'To count your hours, enforce your plan, and keep accounting records.',
                'Contract and legal obligation (tax and accounting)',
              ],
              [
                '**Where you came from:** if you followed a link with a source on it (such as ?ref= or utm_source=), that source, saved once with your account in your first week. No cookie is used for it.',
                'To know which places bring people to {brand}.',
                'Legitimate interests',
              ],
              [
                '**How {brand} is used:** the pages visited, how fast they loaded and errors the site hit, counted without cookies and with nothing stored on your device, without your name, email or IP address. Steps your account reaches (signing up, making a server, its first start, a friend’s first join, upgrading), recorded by your account’s ID, never your email. There are no screen recordings.',
                'To see where {brand} works and where people get stuck, and to fix what breaks.',
                'Legitimate interests',
              ],
              [
                '**Feedback:** what you write in Feedback, or your answer to “How’s it going?”, with your account’s ID, the page you were on and your plan. Feedback also carries your email, so we can write back.',
                'To hear from you and reply.',
                'Legitimate interests',
              ],
              [
                '**Activity log:** a record of important actions on your account and servers (for example plan changes, password resets, moderation decisions, commands typed into a server console, and IP bans the system removed).',
                'Security, fixing problems, and showing what happened if there is a dispute.',
                'Legitimate interests',
              ],
              [
                '**Messages:** what you send us by email and our replies.',
                'To answer you.',
                'Contract and legitimate interests',
              ],
            ],
          },
        },
        'We don’t use your data for advertising, we don’t sell it, and we don’t make decisions about you by automated means that have legal or similarly significant effects. Automatic limits (like servers sleeping when your hours run out) just apply your plan.',
        'You don’t have to give us any personal data, but we can’t give you an account without an email address.',
      ],
    },
    {
      id: 'google',
      heading: '3. Signing in with Google',
      blocks: [
        'You can make a {brand} account, or sign in to one, with your Google account instead of a password. When you do, Google asks you to let {brand} see your basic profile, and nothing more: we ask only for the openid, email and profile permissions. We never see your Google password, and we can’t read your Gmail, Drive, contacts or anything else in your Google account.',
        {
          list: [
            '**What we receive from Google:** your name, your email address, whether Google has confirmed that email address, the address of your profile picture, and your Google account ID, with the sign-in tokens Google gives us for it.',
            '**What we use it for:** only to create your {brand} account and sign you in to it, to keep your name and picture with your account, and to email you about your account and servers. Your Google account ID is how we know it’s you the next time you sign in with Google.',
            '**Who we share it with:** no one, except the providers that store our database and run {brand} for us (section 5), who keep it on our behalf. We don’t sell it, use it for advertising, or use it to train AI models, and no person reads it except to answer you or to keep {brand} safe.',
            '**How we keep it safe:** it is stored in our database in Frankfurt, Germany, encrypted in transit, and only the person who runs {brand} has access to it (section 8).',
            '**How long we keep it, and how to remove it:** for as long as you have your account. Delete your account, or email {privacy}, and we delete what Google gave us with it within 30 days. You can also remove {brand}’s access at any time from your Google account, at myaccount.google.com/permissions; you then can’t sign in with Google until you allow it again.',
          ],
        },
        '{brand}’s use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.',
      ],
    },
    {
      id: 'players',
      heading: '4. If you play on someone’s server',
      blocks: [
        'You don’t need a {brand} account to join a server. When you join one, we process your Minecraft username and player ID, when you were on, and anything the server’s owner adds about you (for example a ban reason). The server’s own files and logs keep what Minecraft records, such as your position and chat. If the server is published, its public page shows your Minecraft name while you are on it, if the server checks accounts.',
        'If you join with an invite link, we check the name you type with Mojang so the owner can add you.',
        'You can use the rights in section 9 for this data too: email {privacy} with your Minecraft name. The server’s owner controls who plays and what happens on their server, so we may pass your request on to them.',
      ],
    },
    {
      id: 'sharing',
      heading: '5. Who else handles your data',
      blocks: [
        'We use a small number of providers to run {brand}. They handle personal data on our behalf, under contracts that require them to keep it safe and use it only to provide their service to us. We don’t share your data with anyone else unless the law requires it (for example a valid court order), or to protect people’s safety.',
        {
          table: {
            head: ['Who', 'What for', 'Where'],
            rows: [
              [
                'Fly.io, Inc.',
                'Runs our servers and your game servers.',
                'Frankfurt, Germany; Ashburn, US for game servers moved to North America. Fly.io is a US company.',
              ],
              [
                'Supabase, Inc.',
                'Hosts our database: your account and everything in section 2 that we store.',
                'Frankfurt, Germany. Supabase is a US company.',
              ],
              [
                'Cloudflare, Inc.',
                'Hosts the {brand} website, stores copies of worlds (resting worlds, downloads and uploads) and runs our domain names.',
                'US company; serves the site from its global network, and chooses where copies of worlds are stored automatically.',
              ],
              [
                'PostHog, Inc.',
                'Counts how {brand} is used, keeps errors, and receives Feedback (section 2).',
                'Its EU cloud in Frankfurt, Germany. PostHog is a US company.',
              ],
              [
                'Polar Software, Inc. (Polar)',
                'Our merchant of record for paid plans: it takes payments, handles tax and refunds, and sends receipts. Polar uses Stripe to process cards. For the payment itself, Polar is responsible for your data under its own privacy policy.',
                'US company.',
              ],
              [
                'Our email provider ({emailProvider})',
                'Sends account and server emails.',
                '{emailProviderWhere}',
              ],
              [
                'Google or GitHub',
                'Only if you choose to sign in with them. They tell us your email, name and profile picture.',
                'US companies.',
              ],
              [
                'Mojang (Microsoft)',
                'We look up Minecraft names, player IDs and skins with Mojang, and Minecraft servers check players’ accounts with Mojang as they join.',
                'Mojang’s services.',
              ],
              [
                'Modrinth',
                'Mods and modpacks are downloaded from Modrinth. When you browse packs on {brand}, your browser loads their pictures from Modrinth, which sees your IP address.',
                'Modrinth’s services.',
              ],
            ],
          },
        },
        'Player faces shown on {brand} are fetched by our own servers, so Mojang doesn’t learn who plays on whose server.',
      ],
    },
    {
      id: 'transfers',
      heading: '6. Data sent outside the UK and EU',
      blocks: [
        '{brand} is run from {country}, so when we look after your account, fix a problem or answer you, your data is accessed from there. Neither the UK nor the EU has recognised Saudi Arabia as protecting personal data to their standard. The UK GDPR and the EU GDPR still apply to everything we do with your data, wherever we are, and we follow them: your rights in section 9 are the same.',
        'Some of the providers above are in the US, so your data may be handled there. When it is, we rely on the provider being certified under the EU–US Data Privacy Framework (and its UK Extension), or on the European Commission’s standard contractual clauses (with the UK Addendum), which require the provider to protect your data to EU and UK standards. Email {privacy} for a copy of the safeguards that apply.',
      ],
    },
    {
      id: 'retention',
      heading: '7. How long we keep it',
      blocks: [
        {
          list: [
            '**Your account** is kept until you ask us to delete it, or until we close it. We then delete your account, servers, worlds and backups within 30 days, except for what we must keep by law (below).',
            `**Worlds you don’t play:** a world rests in storage after ${FREE.restsAfterDays} days without play on Free (${PLUS.restsAfterDays} on ${PLUS.name}). On Free, a world nobody has played for a year can be deleted, after we email you ${DELETION_WARNINGS_DAYS[0]} and ${DELETION_WARNINGS_DAYS[1]} days before. ${PLUS.name} worlds are kept while you have ${PLUS.name}.`,
            `**Deleted servers** wait in the trash for ${FREE.trashDays} days on Free and ${PLUS.trashDays} on ${PLUS.name}, then are deleted with their backups and their player lists. A world download you already made is kept until it expires (${FREE.downloadDays} days on Free, ${PLUS.downloadDays} on ${PLUS.name}).`,
            `**Backups:** Free keeps the latest ${FREE.backupsKept} daily backups and ${PLUS.name} the latest ${PLUS.backupsKept}; older ones are deleted. Our hosting provider removes old backup copies after at most 60 days.`,
            '**Sign-in sessions** last 7 days from when you last used {brand}. Session records, with the IP address and browser they came from, are kept with your account.',
            '**Server console output** is streamed from our hosting provider’s logs, which keep it for a short time; we don’t store it. The game’s own log files stay inside the world until you delete them or the server.',
            '**Usage counts, errors and feedback** sent to PostHog are kept for one year.',
            '**Billing and order records** are kept for as long as tax and accounting law requires, which can be up to 10 years under the law where we are, even after an account is deleted.',
            '**The activity log and reports** are kept while {brand} runs, so we can look into problems and disputes, unless you ask us to delete entries we no longer need.',
          ],
        },
      ],
    },
    {
      id: 'security',
      heading: '8. Keeping it safe',
      blocks: [
        'Passwords are stored only as secure hashes. Everything between your browser and {brand} is encrypted. Sign-in cookies can’t be read by scripts on the page. Access to our systems is limited to the person who runs {brand}. If a breach puts your data at risk, we will tell you and the regulator as the law requires.',
      ],
    },
    {
      id: 'rights',
      heading: '9. Your rights',
      blocks: [
        'You have the right to:',
        {
          list: [
            'get a copy of the personal data we hold about you (access);',
            'have it corrected if it’s wrong (rectification);',
            'have it deleted (erasure), unless we have to keep it;',
            'ask us to stop using it for a while (restriction);',
            'get the data you gave us in a format you can take elsewhere (portability). Your worlds you can already download yourself;',
            'object to our using it on the basis of legitimate interests;',
            'complain to a data protection regulator.',
          ],
        },
        'To use any of these, email {privacy} from the address on your account (or, if you don’t have an account, tell us your Minecraft name). We may ask you to confirm who you are. We answer within one month, and it’s free.',
        'You can complain to the regulator where you live or work: in the UK the Information Commissioner’s Office (ico.org.uk); in Ireland the Data Protection Commission; in the Netherlands the Autoriteit Persoonsgegevens; in Denmark and Norway the Datatilsynet; in Sweden IMY; in Finland the Data Protection Ombudsman; in Iceland Persónuvernd. We’d appreciate the chance to put things right first.',
      ],
    },
    {
      id: 'age',
      heading: '10. Children',
      blocks: [
        '{brand} accounts are for people aged 18 and over, and we don’t knowingly collect data from children to create accounts. If you think a child has made an account, email {privacy} and we will act as our [Terms](/legal/terms#accounts) describe. Players who join a server without an account may be younger; we only process the Minecraft details described in section 3 about them.',
      ],
    },
    {
      id: 'cookies',
      heading: '11. Cookies',
      blocks: [
        'We only use cookies and browser storage that are needed for {brand} to work, such as keeping you signed in. We don’t use advertising or tracking cookies, and the way we count how {brand} is used stores nothing on your device. Our [Cookies](/legal/cookies) page lists each one.',
      ],
    },
    {
      id: 'changes',
      heading: '12. Changes to this policy',
      blocks: [
        'If we change how we use your data, we will update this page and its date. If the change matters, we will email you before it takes effect.',
      ],
    },
  ],
}
