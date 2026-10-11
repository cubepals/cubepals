// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What the visitor answered on the landing page's own create form: what to play, what to call it,
 * and, under the grass, how many play. One small store outside React, in the manner of stage.ts, so
 * the questions on the surface and the ledger under them are always about the same server.
 *
 * Beside it are the product's facts both of them say: the ways to play as the create page offers
 * them, the group sizes, how a name becomes an address, and what a plan runs. Each is copied from
 * the code named beside it, because the web app can't import the control plane's.
 */
import type { PublicPlan } from '@blockly/contracts'
import { useSyncExternalStore } from 'react'

export type PlayKey = 'survival' | 'creative' | 'hardcore' | 'smooth' | 'create'
export type PartyKey = '5' | '10' | '20' | 'more'

/** A way to play: the row a person presses, and the setup it is underneath. */
export interface Play {
  key: PlayKey
  title: string
  blurb: string
  loader: 'vanilla' | 'paper' | 'neoforge'
  /** The Modrinth projects it brings along. */
  mods: readonly string[]
  gameMode: 'survival' | 'creative'
  difficulty: 'peaceful' | 'normal' | 'hard'
  pvp: boolean
  hardcore: boolean
  /** The Minecraft release a new server of this kind lands on today. */
  release: string
}

/**
 * Five of the ways on "What to play", with the create page's titles and blurbs and what each one
 * sets (apps/control/src/app/setups/templates.ts): Minecraft's own three, which the create page
 * shows first, then Smoother survival and Create from its "More ways to play".
 *
 * A template names no release: a new server gets the newest one Blockly offers that its server
 * type runs on and its mods have a build for (apps/control/src/app/setups/service.ts).
 * 26.3 is offered with Vanilla and Fabric only, so Paper lands on 26.2
 * (apps/control/src/minecraft/versions.ts). The Create mod's newest NeoForge build on
 * Modrinth is 6.0.10+mc1.21.1 (read from Modrinth's API), and 1.21.1 is a release
 * Blockly offers NeoForge on, so Create lands there.
 */
export const PLAYS: readonly Play[] = [
  {
    key: 'survival',
    title: 'Survival',
    blurb: 'Gather, build and stay alive together.',
    loader: 'vanilla',
    mods: [],
    gameMode: 'survival',
    difficulty: 'normal',
    pvp: true,
    hardcore: false,
    release: '26.3',
  },
  {
    key: 'creative',
    title: 'Creative',
    blurb: 'Unlimited blocks. Build whatever you imagine.',
    loader: 'vanilla',
    mods: [],
    gameMode: 'creative',
    difficulty: 'peaceful',
    pvp: false,
    hardcore: false,
    release: '26.3',
  },
  {
    key: 'hardcore',
    title: 'Hardcore',
    blurb: 'One life each, the world at its hardest.',
    loader: 'vanilla',
    mods: [],
    gameMode: 'survival',
    difficulty: 'hard',
    pvp: true,
    hardcore: true,
    release: '26.3',
  },
  {
    key: 'smooth',
    title: 'Smoother survival',
    blurb: 'The same game, tuned to keep up with more people.',
    loader: 'paper',
    mods: [],
    gameMode: 'survival',
    difficulty: 'normal',
    pvp: true,
    hardcore: false,
    release: '26.2',
  },
  {
    key: 'create',
    title: 'Create',
    blurb: 'Machines, gears and contraptions, with the Create mod ready to go.',
    loader: 'neoforge',
    mods: ['create'],
    gameMode: 'survival',
    difficulty: 'normal',
    pvp: true,
    hardcore: false,
    release: '1.21.1',
  },
]

/** How many play: the chip's own words, the players it holds and the memory that group is given. */
export interface Party {
  key: PartyKey
  label: string
  maxPlayers: number
  memoryMb: number
}

/**
 * The group sizes, as the create page's chips say them (apps/control/src/app/servers/queries.ts)
 * and as they are sized (apps/control/src/domain/server/size.ts). None of the five ways to
 * play above needs more than its group does: Create is one 19 MB mod, which sizes as plain
 * Minecraft (apps/control/src/app/setups/service.ts).
 */
export const PARTIES: readonly Party[] = [
  { key: '5', label: 'Up to 5', maxPlayers: 5, memoryMb: 3072 },
  { key: '10', label: 'Up to 10', maxPlayers: 10, memoryMb: 4096 },
  { key: '20', label: 'Up to 20', maxPlayers: 20, memoryMb: 8192 },
  { key: 'more', label: 'More', maxPlayers: 40, memoryMb: 8192 },
]

/** The row the create page starts on, and the one a demonstration playing itself goes back to. */
export const FIRST_PLAY = PLAYS[0] as Play
/** The group the free plan holds, and the one a choice is judged at until somebody says more. */
export const SMALLEST = PARTIES[0] as Party

export const playOf = (key: PlayKey): Play => PLAYS.find((play) => play.key === key) ?? FIRST_PLAY
export const partyOf = (key: PartyKey): Party => PARTIES.find((party) => party.key === key) ?? SMALLEST

// ─── The name becomes the address ──────────────────────────────────────────────────────────────

/** The name the create page's field suggests (apps/web/src/app/(app)/servers/new/page.tsx). */
export const EXAMPLE_NAME = 'Sunset Valley'

/**
 * The play domain production is configured with today
 * (infra/terraform/environments/production/config.auto.tfvars.json). It may change, so every
 * address on the page should come from here. Two
 * still type their own, in AddressDemo.tsx and BackupsDemo.tsx, and a change here has to reach
 * them by hand. The notes under the questions and the ledger say their address is an example.
 */
const PLAY_DOMAIN = 'play.cubepals.com'

/** Names Blockly keeps for its own hosts (apps/control/src/domain/server/slug.ts). */
const RESERVED: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'blockly',
  'cdn',
  'console',
  'cubepals',
  'dashboard',
  'docs',
  'edge',
  'help',
  'internal',
  'mail',
  'play',
  'realtime',
  'rt',
  'static',
  'status',
  'support',
  'www',
])

/**
 * A name as an address would spell it: accents off, lower case, every run of anything else one
 * dash, 40 characters at most (apps/control/src/domain/server/slug.ts, line for line).
 */
function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

/**
 * Whether an address can be one: 3 to 40 letters, numbers and dashes, no dash at either end and no
 * two together, and not a name Blockly keeps (apps/control/src/domain/server/slug.ts; the
 * web says the same rule in apps/web/src/lib/rules.ts).
 */
const usable = (slug: string): boolean =>
  /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) && !slug.includes('--') && !RESERVED.has(slug)

/**
 * The address a name gets, as the create page says it under the field. A name that can't be an
 * address, one too short or one Blockly keeps, gets "world" instead
 * (apps/control/src/domain/server/slug.ts). Whether somebody already has it is not known
 * here: the product then adds four digits.
 */
export function addressOf(name: string): string {
  const slug = slugFromName(name)
  return `${usable(slug) ? slug : 'world'}.${PLAY_DOMAIN}`
}

// ─── What a plan runs ──────────────────────────────────────────────────────────────────────────

/** Whether the free plan runs a choice; if not, the product's own line for why, and the plan that does. */
export interface Fit {
  free: boolean
  /** "Mods and plugins come with Plus.", as the create page says it in the row. */
  why: string | null
  /** The plan the server would be on; undefined when the plans couldn't be read, or none runs it. */
  plan: PublicPlan | undefined
}

/**
 * What a plan table without a paid plan would say, and what the real one says
 * (apps/control/src/domain/account/entitlements.ts).
 */
const comesWith = (what: string, paid: PublicPlan | undefined): string =>
  `${what} ${paid === undefined ? 'need a paid plan' : `come with ${paid.name}`}.`

/**
 * A choice against the plans, in the order the control plane judges it: mods first, then the size
 * of the group (apps/control/src/domain/account/entitlements.ts), worded as the create page
 * words it (apps/control/src/app/servers/queries.ts). Without the plans it falls back to what
 * the plan table says today, Free being plain Minecraft for the smallest group
 * (entitlements.ts), and says nothing.
 */
export function fitOf(plans: readonly PublicPlan[], play: Play, party: Party): Fit {
  const free = plans.find((plan) => plan.monthlyPriceCents === 0)
  const modded = play.mods.length > 0
  if (free === undefined) return { free: !modded && party.key === SMALLEST.key, why: null, plan: undefined }
  const paid = plans.filter((plan) => plan.monthlyPriceCents > 0)
  if (modded && !free.mods) {
    const plan = paid.find((one) => one.mods && one.maxPlayers >= party.maxPlayers)
    return { free: false, why: comesWith('Mods and plugins', plan), plan }
  }
  if (party.maxPlayers > free.maxPlayers) {
    const plan = paid.find((one) => one.maxPlayers >= party.maxPlayers)
    return { free: false, why: comesWith(`Groups over ${free.maxPlayers}`, plan), plan }
  }
  return { free: true, why: null, plan: free }
}

// ─── The store ─────────────────────────────────────────────────────────────────────────────────

export interface Choice {
  play: PlayKey
  /** As typed, untrimmed, so the field holds exactly what was typed. */
  name: string
  party: PartyKey
}

/** Where the page starts: the first way to play, the smallest group, nothing typed. */
const START: Choice = { play: FIRST_PLAY.key, name: '', party: SMALLEST.key }

let state: Choice = START
/** Whether the last change was a demonstration playing itself, and not a person. */
let toured = false
const listeners = new Set<() => void>()

export const choice = {
  get: (): Choice => state,
  /** `by` is 'tour' when a demonstration playing itself makes the change, so nothing reads it aloud. */
  set(change: Partial<Choice>, by: 'person' | 'tour' = 'person'): void {
    const next = { ...state, ...change }
    if (next.play === state.play && next.name === state.name && next.party === state.party) return
    state = next
    toured = by === 'tour'
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/**
 * True while the choice on show was last changed by a demonstration playing itself. Both sections
 * read the one choice, so the tour of either changes what the other says; whatever says the choice
 * aloud goes quiet for those changes, wherever they were made, and speaks again for a person's.
 */
export function useToured(): boolean {
  return useSyncExternalStore(
    choice.subscribe,
    () => toured,
    () => false,
  )
}

/** One value from the choice, re-rendering only when that value changes. */
export function useChoice<T>(pick: (choice: Choice) => T): T {
  return useSyncExternalStore(
    choice.subscribe,
    () => pick(state),
    () => pick(START),
  )
}
