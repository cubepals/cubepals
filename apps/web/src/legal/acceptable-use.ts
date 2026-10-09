/**
 * The Acceptable Use Policy: what may run on {brand}, and what may be published through it. The
 * Terms make it binding; how a breach is handled is the Terms' section on suspension.
 */
import type { Policy } from './policy'

export const ACCEPTABLE_USE: Policy = {
  slug: 'acceptable-use',
  title: 'Acceptable Use Policy',
  description: 'What you can and can’t do with {brand}.',
  summary: [
    '{brand} is for running Minecraft: Java Edition servers. Nothing else.',
    'Don’t break the law, hurt people, or attack anyone or anything.',
    'Anything you publish in the directory must be suitable for everyone.',
    'Breaking these rules can get a listing removed, a server stopped, or an account closed.',
  ],
  sections: [
    {
      id: 'run',
      heading: '1. Only run Minecraft',
      blocks: [
        'A {brand} server is for playing Minecraft: Java Edition, with the mods, plugins and modpacks made for it. Don’t use it for anything else, including:',
        {
          list: [
            'mining cryptocurrency, or any other work that uses a server’s computing power for something other than the game;',
            'running a proxy, VPN, file host, website, bot network or any other service that isn’t part of the game;',
            'storing or sharing files that have nothing to do with your server.',
          ],
        },
      ],
    },
    {
      id: 'law',
      heading: '2. Stay within the law',
      blocks: [
        'Don’t use {brand} to do, store, or share anything illegal where you are, where we are, or where your players are. In particular, never:',
        {
          list: [
            'share sexual content involving anyone under 18, in any form. We report it to the authorities and close the account at once;',
            'threaten, harass, stalk or bully anyone, or encourage violence, terrorism or self-harm;',
            'share someone’s personal information without their permission (doxxing);',
            'share content that infringes someone else’s copyright or trademark, including mods, plugins or packs you don’t have the right to share;',
            'scam people, phish for their account details or payment information, or take their money in ways the law doesn’t allow, including gambling.',
          ],
        },
      ],
    },
    {
      id: 'attacks',
      heading: '3. Don’t attack anyone or anything',
      blocks: [
        {
          list: [
            'Don’t attack other servers, networks or people from {brand}, for example with denial-of-service attacks, scanning, or spam.',
            'Don’t upload malware, or mods and plugins built to harm players or the machines they run on.',
            'Don’t try to break into {brand}, other people’s servers or accounts, or our providers’ systems, or test their security without our written permission. If you find a security problem, tell us at {legal} and we will thank you.',
            'Don’t overload {brand} on purpose, or interfere with other people’s servers.',
          ],
        },
      ],
    },
    {
      id: 'limits',
      heading: '4. Play fair with the plans',
      blocks: [
        {
          list: [
            'One account per person. Don’t make extra accounts to get more free hours or servers.',
            'Don’t try to get around your plan’s limits, for example with tools that keep a server busy so it never sleeps, or AFK farms built to defeat the idle kick.',
            'Don’t resell, rent out or sublet {brand} servers or accounts as a hosting service of your own.',
          ],
        },
      ],
    },
    {
      id: 'minecraft',
      heading: '5. Follow Mojang’s rules',
      blocks: [
        'Every server must follow [Mojang’s EULA](https://www.minecraft.net/eula) and [Usage Guidelines](https://www.minecraft.net/usage-guidelines). Don’t let people play without their own copy of Minecraft, don’t give away or sell Mojang’s server software, and if you charge players for anything, follow Mojang’s rules about it.',
      ],
    },
    {
      id: 'public',
      heading: '6. Public listings and notes',
      blocks: [
        'If you publish a server, its name, description, icon, tags and everything visible from its public page must be suitable for players of all ages, and must describe the server honestly. Don’t use a listing to advertise something else, and don’t pretend to be Mojang, Microsoft, {brand} or anyone else.',
        'Notes you leave on other people’s servers must be friendly and lawful. No spam, hate or harassment.',
      ],
    },
    {
      id: 'servers',
      heading: '7. What happens on your server',
      blocks: [
        'You run your server, so you set its rules and decide who plays. You are responsible for what you and the people you let in do with it, as far as it’s within your control. Please moderate your own server, and if a player breaks the law, report it to the police.',
      ],
    },
    {
      id: 'enforcement',
      heading: '8. If these rules are broken',
      blocks: [
        'Depending on how serious it is, we may remove a listing or a note, stop a server, limit what an account can do, suspend it, or close it, as the [Terms](/legal/terms#suspension) describe. Where we can, we tell you first and give you a chance to fix it, and we always tell you which rule was broken and how to ask us to look again.',
        'To report something, use Report on a server’s public page, or email {legal}. For copyright, see [Content and copyright](/legal/takedown).',
      ],
    },
  ],
}
