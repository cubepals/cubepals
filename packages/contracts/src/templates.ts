// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What to play, as the create page shows it before it knows who is looking: each template's name,
 * line and picture. Whether a plan runs one is the account's own answer (`TemplateView`), and what
 * each one sets up is the control plane's (`app/setups/templates.ts`).
 */
import type { PlayIcon } from './server.ts'

/**
 * A template as the create page shows it: its name, its line and its picture. These are the same
 * for everyone, so the page draws them the moment it opens and asks the control plane only what
 * depends on the account, such as whether the plan runs each one (`TemplateView`). The control
 * plane gives each card its setup in `app/setups/templates.ts`, by key.
 */
export interface TemplateCard {
  key: string
  title: string
  /** One line, in the words of what you would be playing. */
  blurb: string
  /** Its picture on the create page; the server types, shown by name alone, go without. */
  icon: PlayIcon | null
  /** Shown under "Picking mods yourself?", for people who came looking for a server type. */
  advanced: boolean
  /** Played in an evening: a server of it starts out as one that lasts a day, which its owner can undo. */
  forADay: boolean
}

/**
 * What Blockly offers when it asks "what do you want to play?", in the order the page lists them:
 * what runs on every plan before what needs mods, so the list doesn't reorder once a plan is known.
 * None of them mentions a loader, a build or a mod list, and the ones that need them say so in
 * their own words.
 */
export const TEMPLATE_CARDS = [
  {
    key: 'survival',
    title: 'Survival',
    blurb: 'Gather, build and stay alive together.',
    icon: 'survival',
    advanced: false,
    forADay: false,
  },
  {
    key: 'creative',
    title: 'Creative',
    blurb: 'Unlimited blocks. Build whatever you imagine.',
    icon: 'creative',
    advanced: false,
    forADay: false,
  },
  {
    key: 'hardcore',
    title: 'Hardcore',
    blurb: 'One life each, the world at its hardest.',
    icon: 'hardcore',
    advanced: false,
    forADay: false,
  },
  {
    key: 'smooth',
    title: 'Smoother survival',
    blurb: 'The same game, tuned to keep up with more people.',
    icon: 'smooth',
    advanced: false,
    forADay: false,
  },
  {
    key: 'lifesteal',
    title: 'Lifesteal',
    blurb: 'Win a heart from everyone you beat. Lose them all and you’re out.',
    icon: 'lifesteal',
    advanced: false,
    forADay: false,
  },
  {
    key: 'manhunt',
    title: 'Manhunt',
    blurb: 'One runs for the dragon. Everyone else hunts them down.',
    icon: 'manhunt',
    advanced: false,
    forADay: true,
  },
  {
    key: 'oneblock',
    title: 'OneBlock',
    blurb: 'One block under your feet. Break it and it comes back as something new.',
    icon: 'oneblock',
    advanced: false,
    forADay: false,
  },
  {
    key: 'rpg',
    title: 'RPG survival',
    blurb: 'Every skill levels up as you play: mining, fighting, farming and more.',
    icon: 'rpg',
    advanced: false,
    forADay: false,
  },
  {
    key: 'duels',
    title: 'Duels',
    blurb: 'One on one in an arena that’s already built. Type /duel join to fight.',
    icon: 'duels',
    advanced: false,
    forADay: false,
  },
  {
    key: 'create',
    title: 'Create',
    blurb: 'Machines, gears and contraptions, with the Create mod ready to go.',
    icon: 'create',
    advanced: false,
    forADay: false,
  },
  {
    key: 'fabric',
    title: 'Fabric',
    blurb: 'An empty world ready for the mods you pick.',
    icon: null,
    advanced: true,
    forADay: false,
  },
  {
    key: 'neoforge',
    title: 'NeoForge',
    blurb: 'An empty world for NeoForge mods.',
    icon: null,
    advanced: true,
    forADay: false,
  },
  {
    key: 'forge',
    title: 'Forge',
    blurb: 'An empty world for Forge mods.',
    icon: null,
    advanced: true,
    forADay: false,
  },
] as const satisfies readonly TemplateCard[]

export type TemplateKey = (typeof TEMPLATE_CARDS)[number]['key']
