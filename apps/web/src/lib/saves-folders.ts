// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a launcher keeps single-player worlds, by system, for the drop that takes one
 * (`app/(app)/world-drop.tsx`). The Minecraft Launcher keeps them in one saves folder; a launcher
 * with instances keeps each instance's worlds in its own folder, so it names where its instances
 * are and the path to the worlds inside one. Each is the launcher's default, which a player can
 * move: the drop says how to find one that isn't here.
 *
 * Each path is the launcher's own, from where it says it:
 * - Minecraft Launcher: the game's default game directory on each system.
 * - CurseForge: its "Getting started" article's default modding folder, and the Instances folder
 *   in it that holds each profile.
 * - Modrinth App: its source (`packages/app-lib/src/state/dirs.rs`): the system's data folder,
 *   `ModrinthApp`, then `profiles`.
 * - Prism Launcher: its "Data Location" wiki page, then `instances`; an instance's game folder is
 *   `minecraft` (`MinecraftInstance::gameRoot` in its source).
 */

export type System = 'Windows' | 'macOS' | 'Linux'

export interface Launcher {
  id: string
  name: string
  /** Its name inside a sentence: "the Minecraft Launcher keeps…". */
  said: string
  /** Where it keeps worlds, or where it keeps its instances, on each system. */
  folders: Record<System, string>
  /** For a launcher with instances: where an instance keeps its worlds, from the instance's folder. */
  inInstance: readonly string[] | null
}

export const LAUNCHERS: readonly Launcher[] = [
  {
    id: 'minecraft',
    name: 'Minecraft Launcher',
    said: 'the Minecraft Launcher',
    folders: {
      Windows: '%APPDATA%\\.minecraft\\saves',
      macOS: '~/Library/Application Support/minecraft/saves',
      Linux: '~/.minecraft/saves',
    },
    inInstance: null,
  },
  {
    id: 'curseforge',
    name: 'CurseForge',
    said: 'CurseForge',
    folders: {
      Windows: '%USERPROFILE%\\curseforge\\minecraft\\Instances',
      macOS: '~/Documents/curseforge/minecraft/Instances',
      Linux: '~/Documents/curseforge/minecraft/Instances',
    },
    inInstance: ['saves'],
  },
  {
    id: 'modrinth',
    name: 'Modrinth App',
    said: 'the Modrinth App',
    folders: {
      Windows: '%APPDATA%\\ModrinthApp\\profiles',
      macOS: '~/Library/Application Support/ModrinthApp/profiles',
      Linux: '~/.local/share/ModrinthApp/profiles',
    },
    inInstance: ['saves'],
  },
  {
    id: 'prism',
    name: 'Prism Launcher',
    said: 'Prism Launcher',
    folders: {
      Windows: '%APPDATA%\\PrismLauncher\\instances',
      macOS: '~/Library/Application Support/PrismLauncher/instances',
      Linux: '~/.local/share/PrismLauncher/instances',
    },
    inInstance: ['minecraft', 'saves'],
  },
]

/** The launcher a player is taken to use until they say otherwise: the game's own. */
export const DEFAULT_LAUNCHER = 'minecraft'

/** The system a browser runs on, by its user agent; null for a phone, a tablet or one it can't tell. */
export function systemOf(userAgent: string): System | null {
  if (/Windows/.test(userAgent)) return 'Windows'
  if (/Mac OS X/.test(userAgent) && !/iPhone|iPad/.test(userAgent)) return 'macOS'
  if (/Linux/.test(userAgent) && !/Android/.test(userAgent)) return 'Linux'
  return null
}

/** The path inside an instance to its worlds, written as the system writes paths. */
export const inInstanceOn = (launcher: Launcher, system: System): string | null =>
  launcher.inInstance === null ? null : launcher.inInstance.join(system === 'Windows' ? '\\' : '/')
