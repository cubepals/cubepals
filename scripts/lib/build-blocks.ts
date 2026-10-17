// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The blocks a datapack's function sets, read from its commands: each `fill` and `setblock`, in
 * order, by place, and for a `fill … replace`, the one block it replaces. What the scripts that
 * measure a world as the datapack leaves it lay over the world's own blocks. Not any other command.
 */

type Block = readonly [number, number, number]

/** What a command sets at a place: the block, and for a `fill … replace`, the block it replaces alone. */
export interface Placed {
  block: string
  only?: string
}

/** One `fill` or `setblock`: its two corners, both included, and what it sets; none for any other command. */
function readCommand(command: string): { from: Block; to: Block; set: Placed } | undefined {
  const [verb, ...words] = command.split(' ')
  if (verb !== 'fill' && verb !== 'setblock') return undefined
  const corners = verb === 'fill' ? 6 : 3
  const numbers = words.slice(0, corners).map(Number)
  const [x0 = 0, y0 = 0, z0 = 0] = numbers
  const [x1 = x0, y1 = y0, z1 = z0] = verb === 'fill' ? numbers.slice(3) : []
  const block = (words[corners] ?? '').replace(/[[{].*$/, '')
  const [how, only] = words.slice(corners + 1)
  if (how === undefined) return { from: [x0, y0, z0], to: [x1, y1, z1], set: { block } }
  if (verb !== 'fill' || how !== 'replace' || only === undefined)
    throw new Error(`${command} isn't read here`)
  return { from: [x0, y0, z0], to: [x1, y1, z1], set: { block, only } }
}

/** Each place the commands set, by `x y z`, as the last of them leaves it. */
export function blocksSet(commands: readonly string[]): Map<string, Placed> {
  const built = new Map<string, Placed>()
  for (const read of commands.map(readCommand)) {
    if (read === undefined) continue
    const { from, to, set } = read
    for (let x = Math.min(from[0], to[0]); x <= Math.max(from[0], to[0]); x++)
      for (let y = Math.min(from[1], to[1]); y <= Math.max(from[1], to[1]); y++)
        for (let z = Math.min(from[2], to[2]); z <= Math.max(from[2], to[2]); z++)
          built.set(`${x} ${y} ${z}`, set)
  }
  return built
}

/** A world's blocks in a box, air left out, with what the commands set laid over them. */
export function laidOver(
  found: Map<string, string>,
  built: ReadonlyMap<string, Placed>,
  from: Block,
  to: Block,
): Map<string, string> {
  for (const [at, { block, only }] of built) {
    const [x = 0, y = 0, z = 0] = at.split(' ').map(Number)
    const inside = x >= from[0] && x <= to[0] && y >= from[1] && y <= to[1] && z >= from[2] && z <= to[2]
    if (!inside || (only !== undefined && found.get(at) !== only)) continue
    if (block === 'minecraft:air') found.delete(at)
    else found.set(at, block)
  }
  return found
}
