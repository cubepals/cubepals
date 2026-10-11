// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs'
import { TEMPLATE_CARDS, type TemplateCard, type TemplateKey } from '@blockly/contracts'
import type { ServerSetup } from '../../domain/setup/setup.ts'
import { DUELS_FILES } from '../../minecraft/duels.ts'
import { VOID_LEVEL } from '../../minecraft/worlds.ts'

/**
 * What Blockly offers when it asks "what do you want to play?" (§15.6). Each one is a setup with
 * a name people recognise; none of them mentions a loader, a build or a mod list, and the ones
 * that need them say so in their own words ("brings the Create mod along").
 *
 * How each is shown, its name, line and picture, is the same for everyone and lives in
 * `@blockly/contracts` (`TEMPLATE_CARDS`), so the create page draws it without asking. This file
 * gives each card its setup, and the types hold the two to one key each.
 *
 * A template names no Minecraft version: the version is picked when a server is made, as the
 * newest release where everything in the template runs.
 */
export interface Template extends Omit<TemplateCard, 'advanced' | 'forADay'> {
  /** As on its card; a template made elsewhere, as a test's, may leave it out. */
  advanced?: boolean
  forADay?: boolean
  /**
   * No template is a modpack: a pack is chosen by name. One that stands for a way to play says so
   * in its review (`CuratedPack.way` in `curation/packs.ts`), and its card shows only while the
   * pack is offered.
   */
  setup: Omit<ServerSetup, 'gameVersion' | 'loaderVersion' | 'party' | 'modpack'>
}

const WORLD = { levelType: 'minecraft:normal', hardcore: false }
const BENTOBOX_ADDONS = 'plugins/BentoBox/addons'
const AONEBLOCK_CONFIG = readFileSync(new URL('./aoneblock-config.yml', import.meta.url), 'utf8')
const BSKYBLOCK_CONFIG = readFileSync(new URL('./bskyblock-config.yml', import.meta.url), 'utf8')

const SETUPS: Record<TemplateKey, Template['setup']> = {
  survival: {
    loader: 'vanilla',
    mods: [],
    settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
    world: WORLD,
  },
  creative: {
    loader: 'vanilla',
    mods: [],
    settings: { defaultGameMode: 'creative', difficulty: 'peaceful', pvp: false },
    world: WORLD,
  },
  hardcore: {
    loader: 'vanilla',
    mods: [],
    settings: { defaultGameMode: 'survival', difficulty: 'hard', pvp: true },
    world: { ...WORLD, hardcore: true },
  },
  smooth: {
    loader: 'paper',
    mods: [],
    settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
    world: WORLD,
  },
  create: {
    loader: 'neoforge',
    mods: [{ catalog: 'modrinth', projectId: 'create' }],
    settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
    world: WORLD,
  },
  lifesteal: {
    loader: 'paper',
    // LifeStealZ (GPL-3.0). Its own defaults play well, so nothing is configured.
    mods: [{ catalog: 'modrinth', projectId: 'l8Uv7FzS' }],
    settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
    world: WORLD,
  },
  manhunt: {
    loader: 'paper',
    // Manhunt+ (MIT), whose hunters' compasses point at the runner.
    mods: [{ catalog: 'modrinth', projectId: 'V67rIXws' }],
    settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
    world: WORLD,
  },
  skyblock: {
    loader: 'paper',
    // BentoBox with BSkyBlock, Level and Warps (all EPL-2.0).
    // BentoBox loads its addons only from its own folder, never from plugins/.
    mods: [
      { catalog: 'modrinth', projectId: 'aBVLHiAW' },
      { catalog: 'modrinth', projectId: 'ASGn77Qd', dir: BENTOBOX_ADDONS },
      { catalog: 'modrinth', projectId: 'OWzL9XSJ', dir: BENTOBOX_ADDONS },
      { catalog: 'modrinth', projectId: 'P08aFayx', dir: BENTOBOX_ADDONS },
    ],
    // BSkyBlock's own settings with an island made for each player as they first join; without
    // it, a friend lands in a plain world and has to know to type /island.
    files: [{ path: `${BENTOBOX_ADDONS}/BSkyBlock/config.yml`, content: BSKYBLOCK_CONFIG }],
    settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: false },
    world: WORLD,
  },
  oneblock: {
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
  rpg: {
    loader: 'paper',
    // AuraSkills (GPL-3.0). Its own defaults play well, so nothing is configured.
    mods: [{ catalog: 'modrinth', projectId: 'uDdZAVls' }],
    settings: { defaultGameMode: 'survival', difficulty: 'normal', pvp: true },
    world: WORLD,
  },
  duels: {
    loader: 'paper',
    mods: [
      // Duels by Dartanman (MIT), whose arena and kit Cubepals writes. It stops at 1.21.11.
      { catalog: 'modrinth', projectId: 'pZyHIvCK' },
      // OldCombatMechanics from Hangar (MPL-2.0): the fast, cooldown-free combat of Minecraft 1.8.
      // Its own defaults put everyone on its "old" modeset in every world, so nothing is configured.
      { catalog: 'hangar', projectId: 'hangar:2087' },
    ],
    files: DUELS_FILES,
    // Adventure, so nobody breaks the platform; Easy, since there is nothing to eat between fights.
    settings: { defaultGameMode: 'adventure', difficulty: 'easy', pvp: true },
    world: { levelType: VOID_LEVEL, hardcore: false },
  },
  fabric: { loader: 'fabric', mods: [], settings: { defaultGameMode: 'survival' }, world: WORLD },
  neoforge: { loader: 'neoforge', mods: [], settings: { defaultGameMode: 'survival' }, world: WORLD },
  forge: { loader: 'forge', mods: [], settings: { defaultGameMode: 'survival' }, world: WORLD },
}

export const TEMPLATES: readonly Template[] = TEMPLATE_CARDS.map((card) => ({
  ...card,
  setup: SETUPS[card.key],
}))

export const templateOf = (key: string): Template | null =>
  TEMPLATES.find((template) => template.key === key) ?? null
