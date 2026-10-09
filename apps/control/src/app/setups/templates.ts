import type { PlayIcon } from '@blockly/contracts'
import type { ServerSetup } from '../../domain/setup/setup.ts'

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
  /** No template is a modpack: a pack is chosen by name, not offered as a way to play. */
  setup: Omit<ServerSetup, 'gameVersion' | 'loaderVersion' | 'party' | 'modpack'>
}

const WORLD = { levelType: 'minecraft:normal', hardcore: false }

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
