// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What "Bring a world" says, as the player's own world comes in and is played (docs/world-import.md
 * § What the player sees): the world by its name while it comes, the mods it was played with, then
 * what playing it does to the server. Words only; the dialog that shows them is `bring-world.tsx`,
 * and what is sent of a world with its mods, `lib/brought-files.ts`.
 */
import { type BroughtWorld, brandName, type PlayedWith, type ServerView } from '@blockly/contracts'
import type { AddedMods, NotAdded } from '../../../../lib/brought-files'

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

/**
 * What playing it does with its mods: brings them, which moves the server to their loader with
 * them; goes without them, where they didn't come; or nothing, for a world without any a server runs.
 */
export type ModsPlay = 'with' | 'without' | 'none'

export function modsPlayOf(playedWith: PlayedWith): ModsPlay {
  if (playedWith === null) return 'none'
  if (playedWith.mods === null) return playedWith.moddedWith.length > 0 ? 'without' : 'none'
  return playedWith.mods.mods.length > 0 ? 'with' : 'none'
}

/**
 * Whether playing it moves the server up to the world's newer release: as a server without mods
 * does, or with the world's mods, which move up with it in the same step (`withMods`).
 */
export const movesUp = (world: Pick<BroughtWorld, 'newer'>, mods: ModsPlay): boolean =>
  world.newer !== null && (world.newer.movesServer || mods === 'with')

/** What the button that plays it says: the release too, where playing it moves the server up. */
export function playLabel(world: BroughtWorld, mods: ModsPlay = 'none'): string {
  const play = movesUp(world, mods)
    ? `Play ${world.name} on ${world.newer?.gameVersion}`
    : `Play ${world.name}`
  return mods === 'without' ? `${play} without its mods` : play
}

/**
 * The one-way step playing it takes, in one line: a world from a newer release moves the server up
 * to it for good. Null where it opens as the server is, or where the server can't move with it.
 */
export function movesLine(
  world: BroughtWorld,
  serverVersion: string,
  mods: ModsPlay = 'none',
): string | null {
  if (!movesUp(world, mods)) return null
  return `Playing it moves this server from Minecraft ${serverVersion} up to ${world.newer?.gameVersion}, for good: a world can’t go back to an older Minecraft.`
}

/** Names in a sentence: the first few, then how many more. */
function someNames(names: readonly string[], most = 6): string {
  if (names.length <= most) return names.join(', ')
  return `${names.slice(0, most).join(', ')} and ${names.length - most} more`
}

/** Mods counted in a sentence: "a mod", "3 mods". */
const modsCounted = (count: number): string => (count === 1 ? 'a mod' : `${count} mods`)

/** Before it is sent, read from its `level.dat`: the world was played with mods that aren't with it. */
export const playedWithLine = (moddedWith: readonly string[]): string =>
  `This world was played with ${moddedWith.map(brandName).join(' and ')} mods.`

/** The one thing to do so they come: the instance it was played in, picked beside it. */
export const ADD_INSTANCE_LINE =
  'Add the instance you played it in, and they come with it. Without them, the blocks and items they add are gone.'

/** Mods picked beside the world, as they go up with it: which of them a server runs is read after. */
export function addedLine(mods: Pick<AddedMods, 'count' | 'from'>): string {
  const comes = mods.count === 1 ? 'goes up' : 'go up'
  const counted = modsCounted(mods.count)
  return `${counted.charAt(0).toUpperCase()}${counted.slice(1)}${mods.from === null ? '' : ` from ${mods.from}`} ${comes} with it.`
}

/** A launcher's instance picked whole: what of it is sent, and that the rest stays. */
export function instanceLine(name: string, mods: number): string {
  const what =
    mods === 0
      ? 'the world you choose'
      : `the world you choose with its ${modsCounted(mods).replace(/^a /, '')}`
  return `${name} is a launcher’s instance. Cubepals sends ${what}, and leaves the rest of it on your computer.`
}

/** An instance picked whole that holds several worlds: the one question, only its player can answer. */
export const WHICH_WORLD_LINE = 'Which of its worlds do you want?'

/** A world that came as a zip, played on a launcher without instances: its folder takes its mods, a zip can't. */
export const ZIP_WITHOUT_INSTANCE_LINE =
  'A zip can’t take its mods. Choose the world’s folder instead of its zip, and they can come with it.'

/** A folder picked for the mods that can't give them. */
export function notAddedLine(why: NotAdded): string {
  return why === 'no-mods'
    ? 'There are no mods in this folder. Choose the instance you played the world in, or its mods folder.'
    : 'Choose the instance’s own folder: a world that came as a zip is taken from its instance, with its mods.'
}

/**
 * Once it is read, what it was played with: the loader and the mods that come, and what playing it
 * does to the server, which moves to that loader where it runs another. Null where its mods didn't come.
 */
export function modsLine(playedWith: PlayedWith, serverLoader: ServerView['loader']): string | null {
  const found = playedWith?.mods ?? null
  if (found === null) return null
  const loader = brandName(found.loader)
  const coming = found.mods.map((mod) => mod.name)
  if (coming.length === 0)
    return `Played with ${loader}. None of its mods run on a server, so your server stays as it is.`
  const them = coming.length === 1 ? 'it' : 'them'
  const server =
    serverLoader === found.loader
      ? `Your server gets ${them} too.`
      : `Your server moves to ${loader} with ${them}.`
  return `Played with ${loader} and ${modsCounted(coming.length)}: ${someNames(coming)}. ${server}`
}

/** The mods that don't come, each with why: those only players' games run, then the rest. */
export function leftOutLines(playedWith: PlayedWith): string[] {
  const found = playedWith?.mods ?? null
  if (found === null) return []
  const players = found.forPlayers.map((mod) => mod.name)
  return [
    ...(players.length === 0
      ? []
      : [`Left out ${someNames(players)}: only players’ games run ${players.length === 1 ? 'it' : 'them'}.`]),
    ...found.leftOut.map((mod) => `Left out ${mod.name}: ${mod.why}`),
  ]
}

/** Once it is read, where its mods didn't come: what it was played with, and what that costs it. */
export function noModsLine(playedWith: PlayedWith, name: string): string | null {
  if (playedWith === null || playedWith.mods !== null || playedWith.moddedWith.length === 0) return null
  const loaders = playedWith.moddedWith.map(brandName).join(' and ')
  return `${atStart(name)} was played with ${loaders} mods, which didn’t come with it. Without them, the blocks and items they add are gone.`
}

/** The way to bring them after all: the instance, and the world sent again with them. */
export const againLine = (name: string): string =>
  `Add the instance you played it in, and Cubepals brings ${name} again with them.`

/** What happens to the server as it plays the world, by what it is doing now. */
export function serverLine(name: string, status: ServerView['status']): string {
  if (status === 'running')
    return `The server restarts into ${name}. Anyone online can join again once it’s up.`
  if (status === 'stopped') return `The server is asleep, and wakes on ${name} when someone joins.`
  return `The server starts on ${name}.`
}

/** Where the world the server had goes: kept, and the way back to it said. */
export const KEPT_LINE = 'The world the server has now is kept, and you can switch back to it from Backups.'
