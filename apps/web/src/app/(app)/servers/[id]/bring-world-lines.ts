// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What "Bring a world" says, as the player's own world comes in and is played (docs/world-import.md
 * § What the player sees): the world by its name while it comes, then what playing it does to the
 * server. Words only; the dialog that shows them is `bring-world.tsx`.
 */
import type { BroughtWorld, ServerView } from '@blockly/contracts'

/** Where the dialog is: the file picked, going up and being read, asking, ready, or refused. */
export type Stage = 'picked' | 'coming' | 'ready' | 'refused'

/**
 * What the world is called while it comes in: the name its player gave, else the one it has in
 * Minecraft, which the server takes too. Null where neither says.
 */
export function comingName(typed: string, inMinecraft: string | null): string | null {
  return typed.trim() || inMinecraft?.trim() || null
}

/** The dialog's title: what is happening to the world, by its name where it has one. */
export function titleOf(stage: Stage, name: string | null): string {
  switch (stage) {
    case 'picked':
      return 'Bring a world'
    case 'coming':
      return `Bringing ${name ?? 'your world'} to your server`
    case 'ready':
      return `${atStart(name ?? 'Your world')} is ready`
    case 'refused':
      return `${atStart(name ?? 'Your world')} couldn’t come in`
  }
}

/** A name that starts a sentence, capitalised there: a server's world is often just "world". */
const atStart = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)

/** What the button that plays it says: the release too, where playing it moves the server up. */
export function playLabel(world: BroughtWorld): string {
  return world.newer?.movesServer ? `Play ${world.name} on ${world.newer.gameVersion}` : `Play ${world.name}`
}

/**
 * The one-way step playing it takes, in one line: a world from a newer release moves the server up
 * to it for good. Null where it opens as the server is, or where the server can't move with it.
 */
export function movesLine(world: BroughtWorld, serverVersion: string): string | null {
  const newer = world.newer
  if (newer === null || !newer.movesServer) return null
  return `Playing it moves this server from Minecraft ${serverVersion} up to ${newer.gameVersion}, for good: a world can’t go back to an older Minecraft.`
}

/** What happens to the server as it plays the world, by what it is doing now. */
export function serverLine(name: string, status: ServerView['status']): string {
  if (status === 'running')
    return `The server restarts into ${name}. Anyone online can join again once it’s up.`
  if (status === 'stopped') return `The server is asleep, and wakes on ${name} when someone joins.`
  return `The server starts on ${name}.`
}

/** Where the world the server had goes: kept, and the way back to it said. */
export const KEPT_LINE = 'The world the server has now is kept, and you can switch back to it from Backups.'
