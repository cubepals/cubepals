// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The overworld's force-loaded chunks and which of them are loaded, as `forceload` and
 * `execute if loaded` answer in 26.3's words (`lang-26.3.json`). The console runs at the world
 * spawn, which the fake puts at block 0, 0, so `~-48` and `-48` are the same column. Force-loaded
 * chunks are kept with the world, by its directory, across restarts, as the game saves them; a
 * forced chunk is loaded from the second time it is asked about, the first having started its
 * generation. Players' own chunks are not modelled.
 */
import lang from './lang-26.3.json' with { type: 'json' }

const DIMENSION = 'minecraft:overworld'
const CHUNK_BLOCKS = 16

/** A line of the game's, its `%s` filled in order. */
function said(key: keyof typeof lang.lines, ...values: string[]): string {
  let i = 0
  return lang.lines[key].replace(/%s/g, () => values[i++] ?? '')
}

interface Chunks {
  forced: Set<string>
  /** Asked about once while forced: loaded at the next ask. */
  started: Set<string>
}

const worlds = new Map<string, Chunks>()

const chunksOf = (dir: string): Chunks => {
  let chunks = worlds.get(dir)
  if (chunks === undefined) {
    chunks = { forced: new Set(), started: new Set() }
    worlds.set(dir, chunks)
  }
  return chunks
}

/** The chunk a column's coordinate falls in, relative or not. */
const chunkOf = (coordinate: string): number | null => {
  const blocks = Number(coordinate.replace(/^~/, '') || '0')
  return Number.isFinite(blocks) ? Math.floor(blocks / CHUNK_BLOCKS) : null
}

const key = (x: number, z: number) => `${x},${z}`
const shown = (x: number, z: number) => `[${x}, ${z}]`

/** Every chunk from one corner to the other, or null for coordinates it can't read. */
function area(args: string[]): Array<[number, number]> | null {
  const [x1, z1, x2 = x1, z2 = z1] = args.map(chunkOf)
  if (x1 == null || z1 == null || x2 == null || z2 == null) return null
  const found: Array<[number, number]> = []
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
    for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) found.push([x, z])
  return found
}

/** `forceload query`: every force-loaded chunk. */
function listed(chunks: Chunks): string {
  const all = [...chunks.forced].map((k) => `[${k.replace(',', ', ')}]`)
  if (all.length === 0) return said('commands.forceload.added.none', DIMENSION)
  if (all.length === 1) return said('commands.forceload.list.single', DIMENSION, all[0] ?? '')
  return said('commands.forceload.list.multiple', String(all.length), DIMENSION, all.join(', '))
}

/** `forceload add|remove <from> <to>`: how many chunks changed, from the first to the last. */
function marked(chunks: Chunks, adding: boolean, square: Array<[number, number]>): string {
  const changed = square.filter(([x, z]) => adding !== chunks.forced.has(key(x, z)))
  for (const [x, z] of changed) {
    if (adding) chunks.forced.add(key(x, z))
    else {
      chunks.forced.delete(key(x, z))
      chunks.started.delete(key(x, z))
    }
  }
  if (changed.length === 0)
    return said(adding ? 'commands.forceload.added.failure' : 'commands.forceload.removed.failure')
  const [fx, fz] = square[0] ?? [0, 0]
  const [lx, lz] = square[square.length - 1] ?? [fx, fz]
  const line = adding ? 'commands.forceload.added.multiple' : 'commands.forceload.removed.multiple'
  return said(line, String(changed.length), DIMENSION, shown(fx, fz), shown(lx, lz))
}

/** `forceload add|remove <from> [<to>]` and `forceload query [<pos>]` on the overworld. */
function forceload(chunks: Chunks, args: string[]): string {
  const [verb, ...rest] = args
  if (verb === 'query' && rest.length === 0) return listed(chunks)
  const square = area(rest)
  const [first] = square ?? []
  if (first === undefined) return said('command.unknown.argument')
  if (verb === 'query') {
    const line = chunks.forced.has(key(...first))
      ? 'commands.forceload.query.success'
      : 'commands.forceload.query.failure'
    return said(line, shown(...first), DIMENSION)
  }
  if (verb !== 'add' && verb !== 'remove') return said('command.unknown.command')
  return marked(chunks, verb === 'add', square ?? [])
}

/** `execute if loaded <x> <y> <z>`: passed once a forced chunk has been asked about before. */
function ifLoaded(chunks: Chunks, args: string[]): string {
  const [x, , z] = args
  const cx = chunkOf(x ?? '')
  const cz = chunkOf(z ?? '')
  if (cx === null || cz === null) return said('command.unknown.argument')
  const k = key(cx, cz)
  if (!chunks.forced.has(k)) return said('commands.execute.conditional.fail')
  if (chunks.started.has(k)) return said('commands.execute.conditional.pass')
  chunks.started.add(k)
  return said('commands.execute.conditional.fail')
}

/** The answer to a command about chunks, or null for any other command. */
export function chunks(dir: string, verb: string, args: string[]): string | null {
  if (verb === 'forceload') return forceload(chunksOf(dir), args)
  if (verb === 'execute' && args[0] === 'if' && args[1] === 'loaded')
    return ifLoaded(chunksOf(dir), args.slice(2))
  return null
}

/** The chunks force-loaded in a world, as `x,z` chunk coordinates, for tests to read. */
export const forcedChunks = (dir: string): string[] => [...chunksOf(dir).forced]
