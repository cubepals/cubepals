import { readFileSync } from 'node:fs'
import type { PlayIcon } from '@blockly/contracts'
import type { ServerSetup } from '../../domain/setup/setup.ts'
import { DUELS_FILES } from '../../minecraft/duels.ts'
import { VOID_LEVEL } from '../../minecraft/worlds.ts'

/**
 * What Blockly offers when it asks "what do you want to play?" (§15.6). Each one is a setup with
 * a name people recognise; none of them mentions a loader, a build or a mod list, and the ones
 * that need them say so in their own words ("brings the Create mod along").
 *
 * A template names no Minecraft version: the version is picked when a server is made, as the
 * newest release where everything in the template runs.
 */
export interface Template {
  key: string
  title: string
  /** One line, in the words of what you would be playing. */
  blurb: string
  /** Its picture on the create page; the server types, shown by name alone, go without. */
  icon: PlayIcon | null
  /** Shown under "more ways to play", for people who came looking for a server type. */
  advanced?: boolean
  /** Played in an evening: a server of it starts out as one that lasts a day, which its owner can undo. */
  forADay?: boolean
  /**
   * No template is a modpack: a pack is chosen by name. One that stands for a way to play, as
   * SkyBlock Plus does for Skyblock, says so in its review (`curation/packs.ts`), and its card
   * shows only while the pack is offered.
   */
  setup: Omit<ServerSetup, 'gameVersion' | 'loaderVersion' | 'party' | 'modpack'>
}

const WORLD = { levelType: 'minecraft:normal', hardcore: false }
const BENTOBOX_ADDONS = 'plugins/BentoBox/addons'
const AONEBLOCK_CONFIG = readFileSync(new URL('./aoneblock-config.yml', import.meta.url), 'utf8')

export const TEMPLATES: readonly Template[] = [
  {
    key: 'survival',
    title: 'Survival',
    blurb: 'Gather, build and stay alive together.',
    icon: 'survival',
    setup: {
      loader: 'vanilla',
      mods: [],
      settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
      world: WORLD,
    },
  },
  {
    key: 'creative',
    title: 'Creative',
    blurb: 'Unlimited blocks. Build whatever you imagine.',
    icon: 'creative',
    setup: {
      loader: 'vanilla',
      mods: [],
      settings: { defaultGameMode: 'creative', difficulty: 'peaceful', pvp: false },
      world: WORLD,
    },
  },
  {
    key: 'hardcore',
    title: 'Hardcore',
    blurb: 'One life each, the world at its hardest.',
    icon: 'hardcore',
    setup: {
      loader: 'vanilla',
      mods: [],
      settings: { defaultGameMode: 'survival', difficulty: 'hard', pvp: true },
      world: { ...WORLD, hardcore: true },
    },
  },
  {
    key: 'smooth',
    title: 'Smoother survival',
    blurb: 'The same game, tuned to keep up with more people.',
    icon: 'smooth',
    setup: {
      loader: 'paper',
      mods: [],
      settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
      world: WORLD,
    },
  },
  {
    key: 'create',
    title: 'Create',
    blurb: 'Machines, gears and contraptions, with the Create mod ready to go.',
    icon: 'create',
    setup: {
      loader: 'neoforge',
      mods: [{ catalog: 'modrinth', projectId: 'create' }],
      settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
      world: WORLD,
    },
  },
  {
    key: 'lifesteal',
    title: 'Lifesteal',
    blurb: 'Win a heart from everyone you beat. Lose them all and you’re out.',
    icon: 'lifesteal',
    setup: {
      loader: 'paper',
      // LifeStealZ (GPL-3.0). Its own defaults play well, so nothing is configured.
      mods: [{ catalog: 'modrinth', projectId: 'l8Uv7FzS' }],
      settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
      world: WORLD,
    },
  },
  {
    key: 'manhunt',
    title: 'Manhunt',
    blurb: 'One runs for the dragon. Everyone else hunts them down.',
    icon: 'manhunt',
    forADay: true,
    setup: {
      loader: 'paper',
      // Manhunt+ (MIT), whose hunters' compasses point at the runner.
      mods: [{ catalog: 'modrinth', projectId: 'V67rIXws' }],
      settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
      world: WORLD,
    },
  },
  {
    key: 'oneblock',
    title: 'OneBlock',
    blurb: 'One block under your feet. Break it and it comes back as something new.',
    icon: 'oneblock',
    setup: {
      loader: 'paper',
      // BentoBox with AOneBlock, Level and Warps (all EPL-2.0).
      // BentoBox loads its addons only from its own folder, never from plugins/.
      mods: [
        { catalog: 'modrinth', projectId: 'aBVLHiAW' },
        { catalog: 'modrinth', projectId: 'qq7CK8U4', dir: BENTOBOX_ADDONS },
        { catalog: 'modrinth', projectId: 'OWzL9XSJ', dir: BENTOBOX_ADDONS },
        { catalog: 'modrinth', projectId: 'P08aFayx', dir: BENTOBOX_ADDONS },
      ],
      // AOneBlock's own settings with a block made for each player as they first join; without
      // it, a friend lands in a plain world and has to know to type /ob.
      files: [{ path: `${BENTOBOX_ADDONS}/AOneBlock/config.yml`, content: AONEBLOCK_CONFIG }],
      settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: false },
      world: WORLD,
    },
  },
  {
    key: 'rpg',
    title: 'RPG survival',
    blurb: 'Every skill levels up as you play: mining, fighting, farming and more.',
    icon: 'rpg',
    setup: {
      loader: 'paper',
      // AuraSkills (GPL-3.0). Its own defaults play well, so nothing is configured.
      mods: [{ catalog: 'modrinth', projectId: 'uDdZAVls' }],
      settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
      world: WORLD,
    },
  },
  {
    key: 'duels',
    title: 'Duels',
    blurb: 'One on one in an arena that’s already built. Type /duel join to fight.',
    icon: 'duels',
    setup: {
      loader: 'paper',
      mods: [
        // Duels by Dartanman (MIT), whose arena and kit Cubepals writes. It stops at 1.21.11.
        { catalog: 'modrinth', projectId: 'pZyHIvCK' },
        // PVPOneDotEight (GPL-3.0): the fast, cooldown-free combat of Minecraft 1.8, in every world.
        { catalog: 'modrinth', projectId: 'Tz6dxwG9' },
      ],
      files: DUELS_FILES,
      // Adventure, so nobody breaks the platform; Easy, since there is nothing to eat between fights.
      settings: { defaultGameMode: 'adventure', difficulty: 'easy', pvp: true },
      world: { levelType: VOID_LEVEL, hardcore: false },
    },
  },
  {
    key: 'fabric',
    title: 'Fabric',
    blurb: 'An empty world ready for the mods you pick.',
    icon: null,
    advanced: true,
    setup: { loader: 'fabric', mods: [], settings: { defaultGameMode: 'survival' }, world: WORLD },
  },
  {
    key: 'neoforge',
    title: 'NeoForge',
    blurb: 'An empty world for NeoForge mods.',
    icon: null,
    advanced: true,
    setup: { loader: 'neoforge', mods: [], settings: { defaultGameMode: 'survival' }, world: WORLD },
  },
  {
    key: 'forge',
    title: 'Forge',
    blurb: 'An empty world for Forge mods.',
    icon: null,
    advanced: true,
    setup: { loader: 'forge', mods: [], settings: { defaultGameMode: 'survival' }, world: WORLD },
  },
]

export const templateOf = (key: string): Template | null =>
  TEMPLATES.find((template) => template.key === key) ?? null
