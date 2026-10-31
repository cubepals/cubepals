// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What is sent of a world a player brings to a server they have (docs/world-import.md § Mods), as
 * one file: a zip or a tarball as they chose it, a world's folder laid out as a tarball, or, of a
 * launcher's instance picked whole, the world chosen in it with its mods (`sentWith`). A folder
 * picked for the mods of a world that came without them adds them beside it (`modsSent`), so one
 * upload holds both; a world that came as a file is taken from its instance instead, since a zip
 * can't be added to in the browser. Which folders hold what is `instance-folders.ts`'s; what the
 * dialog says of it, `bring-world-lines.ts`'s.
 */
import {
  instanceIn,
  modsBeside,
  modsIn,
  modsSent,
  type PickedInstance,
  playedFrom,
  sentWith,
} from './instance-folders'
import { type PickedFile, tarOf } from './world-folder'

/** A world as its player handed it over: a file, a world's folder, or a launcher's instance picked whole. */
export type Brought =
  | { kind: 'file'; file: File }
  | { kind: 'folder'; held: PickedFile[] }
  | { kind: 'instance'; held: PickedFile[]; instance: PickedInstance }

/** Mods added beside a world's folder or an instance's: their files at the paths they are sent at, and where they came from. */
export interface AddedMods {
  held: PickedFile[]
  /** How many mods: the jars among them. */
  count: number
  /** The instance's folder name, where they came from one. */
  from: string | null
}

/** What goes up: what was handed over, the world chosen of an instance, and mods added beside it. */
export interface Sending {
  brought: Brought
  /** Of an instance, the folder of the world chosen in it; null until one is. */
  world: string | null
  mods: AddedMods | null
}

/** Why a folder picked for a world's mods can't add them: it holds none, or the world came as a file. */
export type NotAdded = 'no-mods' | 'needs-instance'

/** A folder handed over, as what it is: an instance picked whole, or a world's own (or a server's). */
export function broughtFrom(files: PickedFile[]): Brought {
  const instance = instanceIn(files.map((file) => file.path))
  return instance === null ? { kind: 'folder', held: files } : { kind: 'instance', held: files, instance }
}

/**
 * What is sent of what was handed over, before anything is added: of an instance, its world named
 * `levelName` in its saves, else its only one; none chosen where it holds several.
 */
export function sendingOf(brought: Brought, levelName: string | null = null): Sending {
  if (brought.kind !== 'instance') return { brought, world: null, mods: null }
  const { worlds } = brought.instance
  const named = worlds.find((world) => folderName(world) === levelName)
  return { brought, world: named ?? (worlds.length === 1 ? (worlds[0] ?? null) : null), mods: null }
}

/** A folder's name, from its path ending in a slash. */
export const folderName = (folder: string): string => folder.slice(0, -1).split('/').pop() ?? ''

const tarNamed = (name: string, files: readonly PickedFile[]): File =>
  new File([tarOf(files)], `${name || 'world'}.tar`, { type: 'application/x-tar' })

/**
 * The files of an instance sent with the world chosen: what it runs on and its mods first, with
 * those `added` beside them, then the world.
 */
function instanceSent(
  brought: Extract<Brought, { kind: 'instance' }>,
  world: string,
  added: readonly PickedFile[],
): PickedFile[] {
  const paths = brought.held.map((file) => file.path)
  const sent = new Set(sentWith(paths, brought.instance, world))
  const files = brought.held.filter((file) => sent.has(file.path))
  const inWorld = (file: PickedFile) => file.path.startsWith(world)
  // As an instance's folder lists them: the control plane reads its mods without reading the world twice.
  return [...files.filter((file) => !inWorld(file)), ...added, ...files.filter(inWorld)]
}

/** The one file sent; null for an instance whose world isn't chosen yet. */
export function uploadOf({ brought, world, mods }: Sending): File | null {
  if (brought.kind === 'file') return brought.file
  if (brought.kind === 'instance')
    return world === null ? null : tarNamed(folderName(world), instanceSent(brought, world, mods?.held ?? []))
  const name = brought.held[0]?.path.split('/')[0] ?? ''
  return tarNamed(name, [...(mods?.held ?? []), ...brought.held])
}

/** The world alone, for its `level.dat` to be read in the browser (`levelOf`); null for an instance whose world isn't chosen. */
export function worldOf({ brought, world }: Sending): Blob | null {
  if (brought.kind === 'file') return brought.file
  if (brought.kind === 'folder') return tarOf(brought.held)
  if (world === null) return null
  return tarOf(brought.held.filter((file) => file.path.startsWith(world)))
}

/**
 * How many mods go up with the world: those added beside it, else those beside it in what was
 * handed over. For a file, those its names show (`namesInZip`); null where they can't be read.
 */
export function modsGoing({ brought, mods }: Sending, names: readonly string[] | null): number | null {
  if (mods !== null) return mods.count
  if (brought.kind === 'file') return names === null ? null : modsBeside(names).length
  return modsBeside(brought.held.map((file) => file.path)).length
}

/**
 * What is sent once a folder is picked for the world's mods: of an instance, the world taken from
 * it (`sendingOf`), which a world that came as a file needs; of a mods folder, its mods beside the
 * world's folder or the instance's. Why not, where the folder can't give them.
 */
export function withPicked(
  sending: Sending,
  picked: PickedFile[],
  levelName: string | null,
): Sending | { notAdded: NotAdded } {
  const paths = picked.map((file) => file.path)
  const { brought } = sending
  const instance = brought.kind === 'folder' ? null : instanceIn(paths)
  if (instance !== null) {
    // An instance without mods would send the same world again, for the same answer.
    if (modsBeside(paths).length === 0) return { notAdded: 'no-mods' }
    return sendingOf({ kind: 'instance', held: picked, instance }, levelName)
  }
  if (brought.kind === 'file') return { notAdded: 'needs-instance' }
  const folder = modsIn(paths)
  if (folder === null) return { notAdded: 'no-mods' }
  const byPath = new Map(picked.map((file) => [file.path, file.file]))
  const beside = playedFrom(brought.held.map((file) => file.path))
  // Beside an instance, only the mods: what it runs on is its own.
  const sent = modsSent(paths, folder, beside).filter(
    ({ at }) => brought.kind === 'folder' || at.startsWith(`${beside}mods/`),
  )
  const files = sent.flatMap(({ path, at }) => {
    const file = byPath.get(path)
    return file === undefined ? [] : [{ path: at, file }]
  })
  const from = folder.root === null || folder.root === '' ? null : folderName(folder.root)
  const count = files.filter((file) => /\.jar$/.test(file.path)).length
  return { ...sending, mods: { held: files, count, from } }
}
