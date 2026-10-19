// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Duels lobby's pit, in NetherGames' arena Cramped, north of the platform: a free-for-all where
 * everyone fights everyone. A player steps onto the yellow pad off the platform's north edge and
 * arrives at one of the arena's own two spawn points, at random, with the pit's kit: the duel kit
 * without the bow. Not the lobby round it (`duels-waiting.ts`) or where the arena sits (`maps.ts`).
 *
 * The pit is a fight, so it is open only while two can have one: while fewer than two players are
 * outside a duel, a lid of white glass lies over the pad and over the arena, and the sign by the pad
 * says why. A player is in a duel while they carry the duel kit's bow, which the pit's kit leaves
 * out. The lid closes only over an empty pit, so it never shuts anyone in.
 *
 * A player leaves by the green square in the arena's far corner, under an open door, which puts
 * them back on the platform, or by losing, which drops what they hold; what anyone drops in it is
 * cleared, and whoever leaves leaves the kit behind. A player who joins a duel from the pit keeps
 * the duel's kit, and is put back there afterwards with what they had, as the Duels plugin does for
 * everyone.
 *
 * The arena's invisible walls and roof, which keep its fight inside it, are placed here rather than
 * kept in its structure, the roof as barrier while the pit is open and as the lid's glass while not.
 */
import { type Block, box, exactly, type Part } from '../arcade/datapack.ts'
import { MARKERS, type ShownMarker, showMarker } from '../brand-pack.ts'
import { NS, placed } from './maps.ts'
import { onTop } from './parkour.ts'

const cramped = (at: Block) => placed('cramped', at)

/** The arena's floor, inside its walls, and what is over it to its roof. */
const FLOOR = { from: cramped([-15, 78, -15]), to: cramped([15, 78, 15]) }
const ROOF_Y = cramped([0, 99, 0])[1]

/** Where a player is in the pit: over its floor, under its roof. */
export const IN_PIT = box(
  [FLOOR.from[0], FLOOR.from[1], FLOOR.from[2]],
  [FLOOR.to[0], ROOF_Y - 1, FLOOR.to[2]],
)

/** The arena's own spawn points, from NetherGames' `arenas.yml`, each facing the other. */
const SPAWNS: ReadonlyArray<{ at: Block; yaw: number }> = [
  { at: [0.5, 79, -12.5], yaw: 0 },
  { at: [0.5, 79, 13.5], yaw: 180 },
]

/** Where the pad puts a player, as a command gives a place: `x y z yaw pitch`. */
export const PIT_SPAWNS: readonly string[] = SPAWNS.map(({ at, yaw }) => `${exactly(cramped(at))} ${yaw} 0`)

/** The pad that puts a player in the pit: three by three, off the platform's north edge. */
export const PIT_PAD: { from: Block; to: Block } = { from: [7, -61, -11], to: [9, -61, -9] }

/** The lid over the pad: a layer of glass on it, so nobody stands on the pad. */
const PAD_LID = `fill ${PIT_PAD.from[0]} ${PIT_PAD.from[1] + 1} ${PIT_PAD.from[2]} ${PIT_PAD.to[0]} ${PIT_PAD.to[1] + 1} ${PIT_PAD.to[2]}`

/** The middle of the pad's lid, which says whether the pit is open: air if it is, glass if it isn't. */
const LID_MIDDLE = `${PIT_PAD.from[0] + 1} ${PIT_PAD.from[1] + 1} ${PIT_PAD.from[2] + 1}`

/** The arena's roof, inside its walls: barrier while open, white glass while not. */
const ROOF = `fill ${FLOOR.from[0]} ${ROOF_Y} ${FLOOR.from[2]} ${FLOOR.to[0]} ${ROOF_Y} ${FLOOR.to[2]}`

/** The arena's invisible walls, a block outside its floor, from the ring round it to its roof. */
const WALLS = (() => {
  const [x0, z0, x1, z1] = [FLOOR.from[0] - 1, FLOOR.from[2] - 1, FLOOR.to[0] + 1, FLOOR.to[2] + 1]
  const [y0, y1] = [FLOOR.from[1] + 2, ROOF_Y]
  return [
    `fill ${x0} ${y0} ${z0} ${x1} ${y1} ${z0} minecraft:barrier`,
    `fill ${x0} ${y0} ${z1} ${x1} ${y1} ${z1} minecraft:barrier`,
    `fill ${x0} ${y0} ${z0} ${x0} ${y1} ${z1} minecraft:barrier`,
    `fill ${x1} ${y0} ${z0} ${x1} ${y1} ${z1} minecraft:barrier`,
  ]
})()

/**
 * The sign by the pad, on the arena's front, beside the pad and over it, facing the platform: what
 * it says while the pit is closed, and while it is open.
 */
export const PIT_SIGN: Block = cramped([2, 81, 22])
const CLOSED_SIGN = `data merge block ${PIT_SIGN.join(' ')} {front_text:{messages:["the pit is closed:","it opens when","two can fight",""]}}`
const OPEN_SIGN = `data merge block ${PIT_SIGN.join(' ')} {front_text:{messages:["the pit:","step on the pad","everyone fights","everyone"]}}`

/** The way out: a green square in the arena's far corner, two by two. */
export const PIT_EXIT = { from: cramped([14, 78, -15]), to: cramped([15, 78, -14]) }

/**
 * Over the way out, on the arena's invisible wall beside it, an open door (`brand-pack.ts`): over
 * the head of a player jumping on the square, so it stands nowhere they do. It is shown while
 * someone is on the server, once the world's entities are surely in, and only once.
 */
export const EXIT_MARKER: ShownMarker = {
  marker: MARKERS.wayOut,
  at: [PIT_EXIT.to[0] + 0.97, PIT_EXIT.to[1] + 4.6, PIT_EXIT.to[2]],
  facing: 'west',
  scale: 0.8,
}

/** Where the way out puts a player: on the platform by the pad, facing away from the pit. */
export const OUTSIDE = '8.5 -60.0 -6.5 0 0'

/** A player outside a duel: one without the duel kit's bow. */
const UNLESS_DUELLING = 'unless items entity @s container.* minecraft:bow'

/** The pit's kit: iron and food, the duel kit without the bow. */
const KIT = [
  'clear @s',
  'item replace entity @s armor.head with minecraft:iron_helmet',
  'item replace entity @s armor.chest with minecraft:iron_chestplate',
  'item replace entity @s armor.legs with minecraft:iron_leggings',
  'item replace entity @s armor.feet with minecraft:iron_boots',
  'give @s minecraft:iron_sword',
  'give @s minecraft:cooked_beef 8',
]

export const PIT_PART: Part = {
  functions: {
    // Run as the player, from the pad: one of the spawn points, then the kit.
    'pit/arrive': [
      `execute store result score #spawn ${NS}.waiting run random value 0..${SPAWNS.length - 1}`,
      ...PIT_SPAWNS.map(
        (place, i) => `execute if score #spawn ${NS}.waiting matches ${i} run tp @s ${place}`,
      ),
      `function ${NS}:pit/kit`,
      'tellraw @s "To leave the pit, stand on the green square in its far corner. The kit stays here."',
    ],
    'pit/kit': [...KIT, `tag @s add ${NS}.pit`],
    'pit/leave': ['clear @s', `tag @s remove ${NS}.pit`],
    'pit/out': [`function ${NS}:pit/leave`, `tp @s ${OUTSIDE}`],
    open: [
      `${PAD_LID} minecraft:air replace minecraft:white_stained_glass`,
      `${ROOF} minecraft:barrier`,
      OPEN_SIGN,
    ],
    close: [`${PAD_LID} minecraft:white_stained_glass`, `${ROOF} minecraft:white_stained_glass`, CLOSED_SIGN],
  },
  load: ['scoreboard objectives add cubepals.waiting dummy'],
  // Built closed, since nobody is on a server as it loads.
  build: [
    ...WALLS,
    `fill ${PIT_PAD.from.join(' ')} ${PIT_PAD.to.join(' ')} minecraft:yellow_concrete`,
    `fill ${PIT_EXIT.from.join(' ')} ${PIT_EXIT.to.join(' ')} minecraft:lime_concrete`,
    `setblock ${PIT_SIGN.join(' ')} minecraft:oak_wall_sign[facing=south]{is_waxed:1b}`,
    `function ${NS}:close`,
    `kill @e[type=minecraft:item_display,tag=${NS}.exit]`,
  ],
  tick: [
    // Whether two can fight in the pit, counted as players outside a duel, and the pit opened or
    // closed to match.
    `scoreboard players set #waiting ${NS}.waiting 0`,
    `execute as @a[gamemode=!spectator] ${UNLESS_DUELLING} run scoreboard players add #waiting ${NS}.waiting 1`,
    `execute if score #waiting ${NS}.waiting matches 2.. if block ${LID_MIDDLE} minecraft:white_stained_glass run function ${NS}:open`,
    `execute if score #waiting ${NS}.waiting matches ..1 if block ${LID_MIDDLE} minecraft:air if block ${PIT_PAD.from.join(' ')} minecraft:yellow_concrete unless entity @a[${IN_PIT}] run function ${NS}:close`,
    `execute as @a[gamemode=!spectator,${onTop(PIT_PAD.from, PIT_PAD.to)}] at @s if block ~ ~-1 ~ minecraft:yellow_concrete run function ${NS}:pit/arrive`,
    // Whoever is in the pit without the kit, say back after a restart or a lost duel, is given it;
    // not a moderator watching, nor a player in a duel.
    `execute as @a[tag=!${NS}.pit,gamemode=!spectator,${IN_PIT}] ${UNLESS_DUELLING} run function ${NS}:pit/kit`,
    `execute as @a[${IN_PIT}] at @s if block ~ ~-1 ~ minecraft:lime_concrete run function ${NS}:pit/out`,
    // Whoever leaves the pit any other way leaves the kit behind, unless they left for a duel.
    `execute as @a[tag=${NS}.pit] unless entity @s[${IN_PIT}] ${UNLESS_DUELLING} run function ${NS}:pit/leave`,
    `kill @e[type=minecraft:item,${IN_PIT}]`,
    `execute if entity @a if block ${PIT_EXIT.from.join(' ')} minecraft:lime_concrete unless entity @e[type=minecraft:item_display,tag=${NS}.exit] run ${showMarker(EXIT_MARKER, [`${NS}.exit`])}`,
  ],
}
